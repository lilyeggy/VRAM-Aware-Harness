/**
 * Out-of-Process Worker Agent Runtime Adapter.
 *
 * Implements AgentRuntime by spawning an isolated OS worker subprocess via Bun.spawn.
 * Communicates via line-delimited JSON IPC over stdio.
 * Provides process-level blast radius isolation, crash detection watchdog, and orphan container cleanup.
 */

import { resolve, dirname } from "node:path";
import { settlesWithin } from "./async-utils.ts";
import type {
    AgentRuntime,
    RuntimeEventHandler,
    RuntimeEvent,
    RuntimeStartRequest,
    RuntimeResumeRequest,
} from "./agent-runtime.ts";
import type {
    ExecuteToolInput,
    ToolGatewayOutcome,
    ToolPrepareDecision,
} from "../tools/tool-gateway.ts";
import type { ToolExecution } from "../tools/tool-execution.ts";
import {
    createJsonLineReader,
    createInterruptRunMessage,
    createResumeRunMessage,
    createStartRunMessage,
    createToolCompleteResponseMessage,
    createToolPrepareResponseMessage,
    formatJsonLine,
    isWorkerToMasterMessage,
    type MasterToWorkerMessage,
    type ToolCompleteRequestMessage,
    type ToolPrepareDecisionPayload,
    type ToolPrepareRequestMessage,
    type WorkerRuntimeConfig,
    type WorkerToMasterMessage,
} from "../worker/worker-protocol.ts";

/**
 * 工具治理桥：Master 侧的 ToolGateway 沿 IPC 暴露的 prepare/complete 两阶段。
 * Worker 内的真实工具执行必须先经此桥获得裁决并记账，未装配时一律 fail-closed 拒绝。
 */
export interface WorkerToolGatewayBridge {
    prepare(input: ExecuteToolInput): ToolPrepareDecision;
    complete(input: ExecuteToolInput, execution: ToolExecution, outcome: ToolGatewayOutcome): void;
}

export interface WorkerProcessRuntimeOptions {
    readonly sandboxAcquirers?: Map<string, () => Promise<import("../sandbox/sandbox-provider.ts").SandboxHandle>>;
    readonly workerScriptPath?: string;
    readonly bunCommand?: string;
    readonly cwd?: string;
    readonly extraEnv?: Record<string, string>;
    /**
     * 方案 B：是否继承宿主全量环境。默认 true（历史行为）；
     * broker 模式下必须为 false——worker 只拿到 PATH/HOME/TMPDIR 等白名单，
     * 杜绝 HARNESS_BOOTSTRAP_API_KEY 等宿主 secret 进入半可信 worker。
     */
    readonly inheritEnv?: boolean;
    readonly interruptGraceMs?: number;
    readonly workerHandshakeTimeoutMs?: number;
    /** 进程启动方式：spawn 直接子进程；systemd 经特权窄 helper 起专用 UID/cgroup。 */
    readonly launch?: "spawn" | "systemd";
    readonly systemdLauncherPath?: string;
    readonly systemdSudoPath?: string;
    readonly systemdUnitPrefix?: string;
    readonly workerConfig?: WorkerRuntimeConfig;
    readonly dockerCommand?: string;
    readonly orphanSandboxCleaner?: (sandboxId: string) => Promise<void>;
    readonly toolGatewayBridge?: WorkerToolGatewayBridge;
    readonly getRunEventSequence?: (runId: string) => number;
    /**
     * 工具执行阶段回调：PREPARED 裁决放行后进入 STARTED（RUN → WAITING_TOOL），
     * COMPLETE 落账后回到 ENDED（WAITING_TOOL → RUNNING）。
     * Worker 在工具执行期间崩溃时不会收到 ENDED，Run 停在 WAITING_TOOL，
     * 由恢复扫描与 RUNNING 一视同仁地转 INTERRUPTED。
     */
    readonly onToolExecutionPhase?: (
        runId: string,
        phase: "STARTED" | "ENDED",
        info: { toolName: string; toolCallId: string },
    ) => void;
}

const WORKER_ENV_ALLOWLIST = [
    "HOME",
    "TMPDIR",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
] as const;

export function buildWorkerEnvironment(
    runId: string,
    options: {
        readonly inheritEnv?: boolean;
        readonly extraEnv?: Record<string, string>;
        readonly path?: string;
    },
): Record<string, string> {
    const environment: Record<string, string> = {};
    if (options.inheritEnv === false) {
        for (const key of WORKER_ENV_ALLOWLIST) {
            const value = process.env[key];
            if (value !== undefined) {
                environment[key] = value;
            }
        }
    } else {
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
                environment[key] = value;
            }
        }
    }
    if (options.path !== undefined) {
        environment.PATH = options.path;
    }
    if (options.extraEnv !== undefined) {
        for (const [key, value] of Object.entries(options.extraEnv)) {
            environment[key] = value;
        }
    }
    environment.HARNESS_RUN_ID = runId;
    return environment;
}

interface ActiveWorker {
    readonly runId: string;
    readonly sandboxId?: string;
    readonly systemdUnit?: string;
    readonly child: ReturnType<typeof Bun.spawn>;
    readonly completionPromise: Promise<void>;
    send(msg: MasterToWorkerMessage): void;
}

export class WorkerProcessAgentRuntime implements AgentRuntime {
    private readonly handlersByRunId = new Map<string, Set<RuntimeEventHandler>>();
    private readonly activeWorkers = new Map<string, ActiveWorker>();
    private readonly interruptedRuns = new Set<string>();
    /** PREPARED 已落库、等待 Worker 回报 COMPLETE 的在途工具调用。 */
    private readonly pendingToolPrepares = new Map<string, {
        readonly runId: string;
        readonly input: ExecuteToolInput;
        readonly execution: ToolExecution;
    }>();

    constructor(private readonly options: WorkerProcessRuntimeOptions = {}) {}

    subscribe(runId: string, handler: RuntimeEventHandler): () => void {
        let handlers = this.handlersByRunId.get(runId);
        if (!handlers) {
            handlers = new Set();
            this.handlersByRunId.set(runId, handlers);
        }
        handlers.add(handler);
        return () => {
            handlers?.delete(handler);
            if (handlers?.size === 0) {
                this.handlersByRunId.delete(runId);
            }
        };
    }

    start(request: RuntimeStartRequest): Promise<void> {
        return this.executeRun(
            request.run.runId,
            (send) => {
                send(createStartRunMessage(request.run.runId, request, this.options.workerConfig));
            },
            request.execution?.sandboxId,
            request.execution?.lazySandbox === true,
        );
    }

    resume(request: RuntimeResumeRequest): Promise<void> {
        return this.executeRun(
            request.run.runId,
            (send) => {
                send(createResumeRunMessage(request.run.runId, request, this.options.workerConfig));
            },
            request.execution?.sandboxId,
            request.execution?.lazySandbox === true,
        );
    }

    async interrupt(runId: string): Promise<void> {
        this.interruptedRuns.add(runId);
        const active = this.activeWorkers.get(runId);
        if (!active) return;

        try {
            active.send(createInterruptRunMessage(runId, "Master requested interrupt"));
        } catch {
            // child stdin might be closed
        }

        const graceMs = this.options.interruptGraceMs ?? 5000;
        const exitedInGrace = await settlesWithin(active.completionPromise, graceMs);
        if (!exitedInGrace) {
            console.warn(`[WorkerProcessRuntime] Worker for run ${runId} timed out in grace. Escalating to SIGTERM.`);
            try {
                active.child.kill("SIGTERM");
            } catch {}

            const exitedAfterSigterm = await settlesWithin(active.completionPromise, 2000);
            if (!exitedAfterSigterm) {
                console.warn(`[WorkerProcessRuntime] Worker for run ${runId} still alive. Escalating to SIGKILL.`);
                try {
                    active.child.kill("SIGKILL");
                } catch {}
                if (active.systemdUnit !== undefined) {
                    this.stopSystemdUnit(active.systemdUnit);
                }
            }
        }
    }

    /**
     * 支柱 3：物理强杀。跳过优雅中断与 SIGTERM 阶梯，直接 SIGKILL
     * Worker 子进程；子进程退出回调会以 WORKER_CRASHED 收尾并对孤儿
     * 沙箱执行强制清理。最多等待 2 秒让进程退出事实落地（SIGKILL 不可
     * 被忽略，超时只可能出现在 D 状态僵尸等极端场景）。
     */
    async forceKill(runId: string): Promise<void> {
        const active = this.activeWorkers.get(runId);
        if (!active) return;

        this.interruptedRuns.add(runId);
        console.warn(`[WorkerProcessRuntime] Force killing worker for run ${runId} (SIGKILL).`);
        try {
            active.child.kill("SIGKILL");
        } catch (err) {
            console.warn(`[WorkerProcessRuntime] SIGKILL failed for run ${runId}:`, err);
        }
        if (active.systemdUnit !== undefined) {
            this.stopSystemdUnit(active.systemdUnit);
        }

        await settlesWithin(
            active.completionPromise.catch(() => undefined),
            2_000,
        );
    }

    private executeRun(
        runId: string,
        onReady: (send: (msg: MasterToWorkerMessage) => void) => void,
        sandboxId?: string,
        lazySandbox = false,
    ): Promise<void> {
        if (this.activeWorkers.has(runId)) {
            throw new Error(`Run 已在 Worker 进程中执行：${runId}`);
        }

        const workerScript = this.options.workerScriptPath
            ?? resolve(this.options.cwd ?? process.cwd(), "src/worker/worker-main.ts");
        const bunCmd = (this.options.bunCommand && this.options.bunCommand !== "bun")
            ? this.options.bunCommand
            : (process.execPath || "bun");
        const handshakeTimeoutMs = this.options.workerHandshakeTimeoutMs ?? 15_000;

        let resolvePromise!: () => void;
        let rejectPromise!: (err: Error) => void;
        let settled = false;

        const completionPromise = new Promise<void>((res, rej) => {
            resolvePromise = () => {
                if (!settled) {
                    settled = true;
                    res();
                }
            };
            rejectPromise = (err) => {
                if (!settled) {
                    settled = true;
                    rej(err);
                }
            };
        });

        // Memoized idempotent sandbox cleanup helper for this run
        let cleanupPromise: Promise<void> | null = null;
        const triggerSandboxCleanup = (): Promise<void> => {
            if (!sandboxId) return Promise.resolve();
            if (!cleanupPromise) {
                cleanupPromise = this.cleanupSandbox(sandboxId);
            }
            return cleanupPromise;
        };

        const systemdUnit = this.options.launch === "systemd"
            ? `${this.options.systemdUnitPrefix ?? "harness-worker"}-${runId}`
            : null;

        let child: ReturnType<typeof Bun.spawn>;
        try {
            const bunBinDir = process.execPath ? dirname(process.execPath) : "";
            const currentPath = process.env.PATH ?? "";
            const mergedPath = bunBinDir && !currentPath.includes(bunBinDir)
                ? `${bunBinDir}:${currentPath}`
                : currentPath;

            child = systemdUnit === null
                ? Bun.spawn([bunCmd, "run", workerScript], {
                    cwd: this.options.cwd ?? process.cwd(),
                    stdin: "pipe",
                    stdout: "pipe",
                    stderr: "pipe",
                    env: buildWorkerEnvironment(runId, {
                        inheritEnv: this.options.inheritEnv,
                        extraEnv: this.options.extraEnv,
                        path: mergedPath,
                    }),
                })
                : Bun.spawn([
                    this.options.systemdSudoPath ?? "sudo",
                    "-n",
                    this.options.systemdLauncherPath ?? "/usr/local/sbin/harness-worker-run",
                    "--run-id",
                    runId,
                    "--unit-name",
                    systemdUnit,
                ], {
                    cwd: this.options.cwd ?? process.cwd(),
                    stdin: "pipe",
                    stdout: "pipe",
                    stderr: "pipe",
                    env: {
                        PATH: "/usr/local/bin:/usr/bin:/bin",
                        HOME: process.env.HOME ?? "/tmp",
                        LANG: process.env.LANG ?? "C.UTF-8",
                    },
                });
        } catch (spawnErr) {
            void triggerSandboxCleanup();
            throw spawnErr;
        }

        let interruptedAcknowledged = false;
        let completedNormally = false;
        let readyReceived = false;
        const stderrLines: string[] = [];

        const send = (msg: MasterToWorkerMessage) => {
            try {
                if (child.stdin && typeof child.stdin !== "number" && !child.killed) {
                    child.stdin.write(formatJsonLine(msg));
                    child.stdin.flush();
                }
            } catch (err) {
                console.warn(`[WorkerProcessRuntime] Error writing IPC message to run ${runId}:`, err);
            }
        };

        this.activeWorkers.set(runId, {
            runId,
            sandboxId,
            systemdUnit: systemdUnit ?? undefined,
            child,
            completionPromise,
            send,
        });

        // 1. Handshake watchdog timer
        const handshakeTimer = setTimeout(async () => {
            if (!readyReceived && !settled) {
                try {
                    child.kill("SIGKILL");
                } catch {}
                if (systemdUnit !== null) {
                    this.stopSystemdUnit(systemdUnit);
                }
                const stderrTail = stderrLines.join("\n").slice(-1000);
                const reason = `Worker failed to become ready within ${handshakeTimeoutMs}ms${stderrTail ? `\nStderr: ${stderrTail}` : ""}`;
                this.emit({
                    type: "agent_failed",
                    runId,
                    timestamp: new Date().toISOString(),
                    message: reason,
                });
                await triggerSandboxCleanup();
                rejectPromise(new Error(reason));
            }
        }, handshakeTimeoutMs);

        // 2. Consume stderr lines: 既保留尾部用于崩溃取证，也转发到 Master 日志。
        //
        // worker-main.ts 把 console.* 全部重定向到 stderr 以免污染 stdout 上的
        // NDJSON 协议，因此 worker 侧的一切诊断（含 Pi 会话压缩）都只走 stderr。
        // 原先这里只留最后 50 行在内存里、只有崩溃时才吐出来——后果是
        //「worker 里到底发生了什么」在正常运行期完全不可见：8 小时长稳中
        // Pi 压缩静默失效，正是因为这条链路看不到任何 worker 侧信号。
        void this.consumeStreamLines(child.stderr as ReadableStream<Uint8Array>, (line) => {
            stderrLines.push(line);
            if (stderrLines.length > 50) {
                stderrLines.shift();
            }
            process.stderr.write(`[worker ${child.pid}] ${line}\n`);
        });

        // 3. Read IPC messages from child stdout
        void (async () => {
            try {
                for await (const rawMsg of createJsonLineReader<WorkerToMasterMessage>(child.stdout as ReadableStream<Uint8Array>)) {
                    if (!isWorkerToMasterMessage(rawMsg)) {
                        continue;
                    }
                    const msg = rawMsg;
                    try {
                        switch (msg.type) {
                            case "WORKER_READY":
                                readyReceived = true;
                                clearTimeout(handshakeTimer);
                                if (!completedNormally && !this.interruptedRuns.has(runId)) {
                                    onReady(send);
                                }
                                break;
                            case "RUNTIME_EVENT":
                                this.emit(msg.event);
                                break;
                            case "RUN_COMPLETED":
                                completedNormally = true;
                                resolvePromise();
                                break;
                            case "RUN_FAILED":
                                completedNormally = true;
                                rejectPromise(new Error(msg.error));
                                break;
                            case "RUN_INTERRUPTED":
                                interruptedAcknowledged = true;
                                if (!lazySandbox) { completedNormally = true; resolvePromise(); }
                                break;
                            case "SANDBOX_ACQUIRE_REQUEST": {
                                const acquire = msg.runId === runId ? this.options.sandboxAcquirers?.get(runId) : undefined;
                                void (async () => {
                                    try {
                                        if (!acquire) throw new Error("Run 未授权申请 Sandbox");
                                        const handle = await acquire();
                                        send({ type: "SANDBOX_ACQUIRE_RESPONSE", runId, requestId: msg.requestId,
                                            result: { ok: true, sandboxId: handle.id, token: handle.capabilityToken,
                                                enforcement: handle.enforcement, mountRoot: handle.mountRoot,
                                                workdir: handle.containerWorkdir } });
                                    } catch (error) {
                                        send({ type: "SANDBOX_ACQUIRE_RESPONSE", runId, requestId: msg.requestId,
                                            result: { ok: false, error: error instanceof Error ? error.message : String(error) } });
                                    }
                                })();
                                break;
                            }
                            case "TOOL_PREPARE_REQUEST":
                                this.handleToolPrepareRequest(runId, msg, send);
                                break;
                            case "TOOL_COMPLETE_REQUEST":
                                this.handleToolCompleteRequest(runId, msg, send);
                                break;
                        }
                    } catch (dispatchErr) {
                        console.error(`[WorkerProcessRuntime] Error dispatching IPC message:`, dispatchErr);
                    }
                }
            } catch (err) {
                // Stdout stream finished or broke
            }
        })();

        // 4. Process termination watchdog
        void child.exited.then(async (exitCode) => {
            clearTimeout(handshakeTimer);
            this.activeWorkers.delete(runId);
            this.interruptedRuns.delete(runId);
            if (systemdUnit !== null) {
                this.stopSystemdUnit(systemdUnit);
            }
            // Worker 之死不撤销已落库的 PREPARED 记账：它正是 fail-closed 恢复的证据。
            for (const [executionId, pending] of this.pendingToolPrepares) {
                if (pending.runId === runId) {
                    this.pendingToolPrepares.delete(executionId);
                }
            }

            if (lazySandbox && interruptedAcknowledged) {
                completedNormally = true;
                resolvePromise();
            }
            if (!completedNormally) {
                // Ensure orphan sandbox is reclaimed on ANY abnormal worker termination
                await triggerSandboxCleanup();

                if (!settled) {
                    const signal = child.signalCode ?? (exitCode === 137 ? "SIGKILL" : null);
                    const stderrTail = stderrLines.join("\n").slice(-1000);
                    const reason = `WORKER_CRASHED: exitCode=${exitCode}, signal=${signal ?? "none"}${stderrTail ? `\nStderr: ${stderrTail}` : ""}`;

                    // Emit synthetic agent_failed
                    this.emit({
                        type: "agent_failed",
                        runId,
                        timestamp: new Date().toISOString(),
                        message: reason,
                    });

                    rejectPromise(new Error(reason));
                }
            }
        }).catch((err) => {
            console.error(`[WorkerProcessRuntime] Unhandled error in child.exited for run ${runId}:`, err);
        });

        return completionPromise;
    }

    private stopSystemdUnit(unit: string): void {
        const sudoCmd = this.options.systemdSudoPath ?? "sudo";
        const launcher = this.options.systemdLauncherPath ?? "/usr/local/sbin/harness-worker-run";
        try {
            const proc = Bun.spawn([sudoCmd, "-n", launcher, "--stop", "--unit-name", unit], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
            });
            void proc.exited;
        } catch (err) {
            console.warn(`[WorkerProcessRuntime] Failed to stop systemd unit ${unit}:`, err);
        }
    }

    private emit(event: RuntimeEvent): void {
        const handlers = this.handlersByRunId.get(event.runId);
        if (!handlers) return;
        for (const handler of handlers) {
            try {
                handler(event);
            } catch (err) {
                console.error(`[WorkerProcessRuntime] Error in runtime event handler:`, err);
            }
        }
    }

    /**
     * 治理裁决入口：策略守卫 + PREPARED 记账都在 Master（DB 拥有者）执行。
     * 未装配治理桥时 fail-closed 拒绝，绝不放行未受治的工具执行。
     */
    private handleToolPrepareRequest(
        runId: string,
        msg: ToolPrepareRequestMessage,
        send: (msg: MasterToWorkerMessage) => void,
    ): void {
        const respond = (decision: ToolPrepareDecisionPayload): void => {
            send(createToolPrepareResponseMessage(runId, msg.requestId, decision));
        };
        const bridge = this.options.toolGatewayBridge;
        if (bridge === undefined) {
            respond({
                kind: "DENIED",
                reason: "Worker 隔离模式未装配工具治理桥，fail-closed 拒绝执行",
            });
            return;
        }
        try {
            const input: ExecuteToolInput = {
                ...msg.input,
                runId,
                lastEventSequence: this.options.getRunEventSequence?.(runId)
                    ?? msg.input.lastEventSequence,
            };
            const decision = bridge.prepare(input);
            if (decision.kind === "PREPARED") {
                this.pendingToolPrepares.set(decision.execution.id, { runId, input, execution: decision.execution });
                // 先落 WAITING_TOOL 再放行，保证 Worker 真正执行副作用时
                // 状态已经反映"正在等待工具结果"。
                this.options.onToolExecutionPhase?.(runId, "STARTED", {
                    toolName: input.toolName,
                    toolCallId: input.toolCallId,
                });
                respond({
                    kind: "ALLOWED",
                    toolExecutionId: decision.execution.id,
                    lastEventSequence: input.lastEventSequence,
                });
            } else if (decision.kind === "REUSE") {
                respond({ kind: "REUSE", result: decision.result });
            } else {
                respond({ kind: "DENIED", reason: decision.reason });
            }
        } catch (err) {
            // 策略守卫抛出的拒绝原样转成 DENIED（保留消息），绝不放行。
            respond({
                kind: "DENIED",
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private handleToolCompleteRequest(
        runId: string,
        msg: ToolCompleteRequestMessage,
        send: (msg: MasterToWorkerMessage) => void,
    ): void {
        const pending = this.pendingToolPrepares.get(msg.toolExecutionId);
        if (!pending) {
            // 找不到对应的 PREPARED 记账（如 Worker 崩溃后重发），按失败回报，
            // 让 Worker 侧工具调用以错误收场而不是默默丢失副作用事实。
            send(createToolCompleteResponseMessage(runId, msg.requestId, false));
            return;
        }
        this.pendingToolPrepares.delete(msg.toolExecutionId);
        try {
            this.options.toolGatewayBridge?.complete(
                pending.input,
                pending.execution,
                msg.outcome.ok
                    ? { ok: true, result: msg.outcome.result }
                    : { ok: false, error: msg.outcome.error },
            );
            this.options.onToolExecutionPhase?.(runId, "ENDED", {
                toolName: pending.input.toolName,
                toolCallId: pending.input.toolCallId,
            });
            send(createToolCompleteResponseMessage(runId, msg.requestId, true));
        } catch (err) {
            console.error(`[WorkerProcessRuntime] Tool complete failed for ${msg.toolExecutionId}:`, err);
            send(createToolCompleteResponseMessage(runId, msg.requestId, false));
        }
    }

    private async cleanupSandbox(sandboxId: string): Promise<void> {
        try {
            if (this.options.orphanSandboxCleaner) {
                await this.options.orphanSandboxCleaner(sandboxId);
            } else {
                const dockerCmd = this.options.dockerCommand ?? "docker";
                const containerName = `agent-harness-${sandboxId}`;
                const proc = Bun.spawn([dockerCmd, "rm", "--force", containerName], {
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const timeout = setTimeout(() => {
                    try {
                        proc.kill("SIGKILL");
                    } catch {}
                }, 10_000);
                await Promise.all([
                    proc.exited,
                    new Response(proc.stdout).text(),
                    new Response(proc.stderr).text(),
                ]);
                clearTimeout(timeout);
            }
        } catch (err) {
            console.warn(`[WorkerProcessRuntime] Failed to cleanup orphan sandbox ${sandboxId}:`, err);
        }
    }

    private async consumeStreamLines(
        stream: ReadableStream<Uint8Array>,
        onLine: (line: string) => void,
    ): Promise<void> {
        try {
            const reader = stream.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newlineIndex: number;
                while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
                    const line = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 1);
                    if (line.length > 0) onLine(line);
                }
            }
            buffer += decoder.decode();
            const trailing = buffer.trim();
            if (trailing.length > 0) onLine(trailing);
        } catch {
            // Stream closed
        }
    }
}
