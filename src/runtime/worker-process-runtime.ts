/**
 * Out-of-Process Worker Agent Runtime Adapter.
 *
 * Implements AgentRuntime by spawning an isolated OS worker subprocess via Bun.spawn.
 * Communicates via line-delimited JSON IPC over stdio.
 * Provides process-level blast radius isolation, crash detection watchdog, and orphan container cleanup.
 */

import { resolve } from "node:path";
import type {
    AgentRuntime,
    RuntimeEventHandler,
    RuntimeEvent,
    RuntimeStartRequest,
    RuntimeResumeRequest,
} from "./agent-runtime.ts";
import { createPiCapabilityProfile } from "./runtime-capability.ts";
import type { RuntimeCapabilityProfile } from "./runtime-capability.ts";
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
    readonly workerScriptPath?: string;
    readonly bunCommand?: string;
    readonly cwd?: string;
    readonly extraEnv?: Record<string, string>;
    readonly interruptGraceMs?: number;
    readonly workerHandshakeTimeoutMs?: number;
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

interface ActiveWorker {
    readonly runId: string;
    readonly sandboxId?: string;
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

    getCapabilityProfile(): RuntimeCapabilityProfile {
        const provider = this.options.workerConfig?.piProvider ?? "local-vllm";
        const modelId = this.options.workerConfig?.piModelId ?? "default";
        return createPiCapabilityProfile(
            `worker-process:${provider}/${modelId}`,
            `${provider}/${modelId}`,
        );
    }

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
        );
    }

    resume(request: RuntimeResumeRequest): Promise<void> {
        return this.executeRun(
            request.run.runId,
            (send) => {
                send(createResumeRunMessage(request.run.runId, request, this.options.workerConfig));
            },
            request.execution?.sandboxId,
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

        await settlesWithin(
            active.completionPromise.catch(() => undefined),
            2_000,
        );
    }

    private executeRun(
        runId: string,
        onReady: (send: (msg: MasterToWorkerMessage) => void) => void,
        sandboxId?: string,
    ): Promise<void> {
        if (this.activeWorkers.has(runId)) {
            throw new Error(`Run 已在 Worker 进程中执行：${runId}`);
        }

        const workerScript = this.options.workerScriptPath
            ?? resolve(this.options.cwd ?? process.cwd(), "src/worker/worker-main.ts");
        const bunCmd = this.options.bunCommand ?? "bun";
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

        let child: ReturnType<typeof Bun.spawn>;
        try {
            child = Bun.spawn([bunCmd, "run", workerScript], {
                cwd: this.options.cwd ?? process.cwd(),
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
                env: {
                    ...process.env,
                    ...this.options.extraEnv,
                    HARNESS_RUN_ID: runId,
                },
            });
        } catch (spawnErr) {
            void triggerSandboxCleanup();
            throw spawnErr;
        }

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

        // 2. Consume stderr lines for crash forensics
        void this.consumeStreamLines(child.stderr as ReadableStream<Uint8Array>, (line) => {
            stderrLines.push(line);
            if (stderrLines.length > 50) {
                stderrLines.shift();
            }
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
                                completedNormally = true;
                                resolvePromise();
                                break;
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
            // Worker 之死不撤销已落库的 PREPARED 记账：它正是 fail-closed 恢复的证据。
            for (const [executionId, pending] of this.pendingToolPrepares) {
                if (pending.runId === runId) {
                    this.pendingToolPrepares.delete(executionId);
                }
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
        const bridge = this.options.toolGatewayBridge;
        if (!bridge) {
            send(createToolPrepareResponseMessage(runId, msg.requestId, {
                kind: "DENIED",
                reason: "Worker 隔离模式未装配工具治理桥，fail-closed 拒绝执行",
            }));
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
                send(createToolPrepareResponseMessage(runId, msg.requestId, {
                    kind: "ALLOWED",
                    toolExecutionId: decision.execution.id,
                    lastEventSequence: input.lastEventSequence,
                }));
            } else if (decision.kind === "REUSE") {
                send(createToolPrepareResponseMessage(runId, msg.requestId, {
                    kind: "REUSE",
                    result: decision.result,
                }));
            } else {
                send(createToolPrepareResponseMessage(runId, msg.requestId, {
                    kind: "DENIED",
                    reason: decision.reason,
                }));
            }
        } catch (err) {
            // 策略守卫抛出的拒绝原样转成 DENIED（保留消息），绝不放行。
            send(createToolPrepareResponseMessage(runId, msg.requestId, {
                kind: "DENIED",
                reason: err instanceof Error ? err.message : String(err),
            }));
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

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
    });
    try {
        return await Promise.race([
            promise.then(() => true, () => true),
            timeout,
        ]);
    } finally {
        clearTimeout(timer!);
    }
}
