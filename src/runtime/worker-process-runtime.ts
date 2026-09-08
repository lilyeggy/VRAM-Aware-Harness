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
import {
    createJsonLineReader,
    createInterruptRunMessage,
    createResumeRunMessage,
    createStartRunMessage,
    formatJsonLine,
    isWorkerToMasterMessage,
    type MasterToWorkerMessage,
    type WorkerRuntimeConfig,
    type WorkerToMasterMessage,
} from "../worker/worker-protocol.ts";

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
