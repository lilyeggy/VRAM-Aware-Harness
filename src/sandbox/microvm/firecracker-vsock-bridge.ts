import { createConnection, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { MicrovmExecuteOptions, MicrovmExecutionResult } from "./microvm-types";

interface VsockFrame {
    v?: number;
    type: string;
    id?: string | null;
    stream?: "stdout" | "stderr";
    data?: string;
    exitCode?: number;
    timedOut?: boolean;
    truncated?: boolean;
    reason?: string;
}

export class FirecrackerVsockBridge {
    private socket: Socket | null = null;
    private rawBuffer = "";
    private handshakeComplete = false;
    private executionQueue: Promise<any> = Promise.resolve();
    private activeHandlers = new Map<string, {
        onOutput: (stream: "stdout" | "stderr", data: string) => void;
        onResult: (exitCode: number, timedOut: boolean, truncated: boolean) => void;
        onError: (err: Error) => void;
    }>();

    constructor(
        private readonly udsPath: string,
        private readonly guestPort: number = 5000,
    ) {}

    /**
     * 真机验证修复：guest 内核启动 + init + socat 监听需要数秒，
     * 单次 connect() 的 3s 窗口必然在冷启动时超时（且会把 3s 全浪费在
     * 一次注定失败的尝试上——真机实测冷启动 3.5s 里约 3s 是白等的）。
     * 在 deadline 内按 interval 反复尝试，单次尝试用较短超时快速失败。
     */
    async connectWithRetry(overallTimeoutMs = 20000, intervalMs = 150): Promise<void> {
        const deadline = Date.now() + overallTimeoutMs;
        let lastError: unknown = null;
        while (Date.now() < deadline) {
            try {
                // 单次尝试 1s：guest 通常 1~2s 就绪，短超时避免整段空等
                await this.connect(1000);
                return;
            } catch (err) {
                lastError = err;
                this.close();
                await new Promise((r) => setTimeout(r, intervalMs));
            }
        }
        const reason = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(
            `vsock agent 在 ${overallTimeoutMs}ms 内未就绪（UDS: ${this.udsPath}）。最后一次错误：${reason}`,
        );
    }

    /**
     * 快照 pause/resume 之后重连。
     *
     * 背景（真机实测）：`PATCH /vm {"state":"Paused"}` 会冻结 vCPU，guest 内的
     * socat / agent 随之被冻结，宿主侧已建立的连接会被对端关闭。恢复 vCPU 后
     * 必须重新走一遍 connect + 握手，否则该 VM 的执行通道永久不可用。
     *
     * 与 connectWithRetry 的区别：这里对"guest 刚恢复、socat 尚未回到监听态"
     * 给了额外的稳定窗口，避免恢复瞬间的第一次连接直接判死。
     */
    async reconnectAfterGuestResume(overallTimeoutMs = 20000, intervalMs = 250): Promise<void> {
        // 恢复 vCPU 后 guest 需要一点时间回到用户态、socat 重新 accept。
        await new Promise((r) => setTimeout(r, 500));
        await this.connectWithRetry(overallTimeoutMs, intervalMs);
    }

    /** 连接 UDS、发 CONNECT <port>、等 OK，并进行 ping/pong 握手；失败抛错。支持 reconnect。 */
    async connect(handshakeTimeoutMs = 3000): Promise<void> {
        this.close();

        return new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let resolved = false;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
            };

            timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.close();
                    reject(new Error(`Timeout connecting to Firecracker vsock UDS at "${this.udsPath}" (3000ms)`));
                }
            }, handshakeTimeoutMs);

            try {
                this.socket = createConnection({ path: this.udsPath });
            } catch (err: any) {
                cleanup();
                return reject(err);
            }

            this.socket.on("error", (err: Error) => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    reject(err);
                } else {
                    for (const handler of this.activeHandlers.values()) {
                        handler.onError(err);
                    }
                }
            });

            this.socket.on("close", () => {
                this.handshakeComplete = false;
                for (const handler of this.activeHandlers.values()) {
                    handler.onError(new Error("Vsock connection closed unexpectedly"));
                }
                this.activeHandlers.clear();
            });

            let connectHandshakeDone = false;
            let handshakeBuffer = "";

            const onHandshakeData = (chunk: Buffer) => {
                handshakeBuffer += chunk.toString("utf8");

                if (!connectHandshakeDone) {
                    const newlineIdx = handshakeBuffer.indexOf("\n");
                    if (newlineIdx !== -1) {
                        const line = handshakeBuffer.slice(0, newlineIdx).trim();
                        handshakeBuffer = handshakeBuffer.slice(newlineIdx + 1);

                        if (line.startsWith("OK")) {
                            connectHandshakeDone = true;
                            // Now send ping
                            const pingId = randomBytes(8).toString("hex");
                            const pingFrame = JSON.stringify({ v: 1, type: "ping", id: pingId }) + "\n";
                            this.socket?.write(pingFrame);

                            // The remaining buffer might contain JSON frames
                            checkPingPong(pingId);
                        } else {
                            resolved = true;
                            cleanup();
                            this.close();
                            reject(new Error(`Vsock CONNECT failed with response: "${line}"`));
                            return;
                        }
                    }
                } else {
                    checkPingPong();
                }
            };

            let expectedPingId: string | null = null;
            const checkPingPong = (pingId?: string) => {
                if (pingId) expectedPingId = pingId;
                const newlineIdx = handshakeBuffer.indexOf("\n");
                if (newlineIdx !== -1) {
                    const line = handshakeBuffer.slice(0, newlineIdx).trim();
                    handshakeBuffer = handshakeBuffer.slice(newlineIdx + 1);

                    try {
                        const frame = JSON.parse(line);
                        if (frame.type === "pong" && frame.id === expectedPingId) {
                            resolved = true;
                            cleanup();
                            this.handshakeComplete = true;
                            this.socket?.removeListener("data", onHandshakeData);
                            // Transfer any leftover buffer to rawBuffer
                            this.rawBuffer = handshakeBuffer;
                            this.setupFrameListener();
                            resolve();
                        }
                    } catch {
                        // ignore malformed early bytes
                    }
                }
            };

            this.socket.on("connect", () => {
                this.socket?.write(`CONNECT ${this.guestPort}\n`);
            });

            this.socket.on("data", onHandshakeData);
        });
    }

    private setupFrameListener(): void {
        this.socket?.on("data", (chunk: Buffer) => {
            this.rawBuffer += chunk.toString("utf8");

            while (true) {
                const newlineIdx = this.rawBuffer.indexOf("\n");
                if (newlineIdx === -1) {
                    break;
                }

                const line = this.rawBuffer.slice(0, newlineIdx);
                this.rawBuffer = this.rawBuffer.slice(newlineIdx + 1);

                if (!line.trim()) {
                    continue;
                }

                if (Buffer.byteLength(line, "utf8") > 1048576) {
                    this.close();
                    for (const handler of this.activeHandlers.values()) {
                        handler.onError(new Error("Vsock frame exceeded 1MiB limit"));
                    }
                    return;
                }

                let frame: VsockFrame;
                try {
                    frame = JSON.parse(line);
                } catch {
                    // Malformed JSON, drop
                    continue;
                }

                this.dispatchFrame(frame);
            }
        });
    }

    private dispatchFrame(frame: VsockFrame): void {
        if (!frame.id) {
            return;
        }

        const handler = this.activeHandlers.get(frame.id);
        if (!handler) {
            // Unknown or stale id: drop frame
            return;
        }

        if (frame.type === "exec_output" && frame.stream && frame.data) {
            handler.onOutput(frame.stream, frame.data);
        } else if (frame.type === "exec_result") {
            // Remove handler immediately so subsequent duplicate results are ignored
            this.activeHandlers.delete(frame.id);
            handler.onResult(
                frame.exitCode ?? 0,
                frame.timedOut ?? false,
                frame.truncated ?? false,
            );
        }
    }

    /** 发送 exec 请求，聚合 exec_output，返回结构化结果。options 同现有 MicrovmExecuteOptions（含 onStdoutChunk 流式回调）。 */
    async execute(
        command: readonly string[],
        options?: MicrovmExecuteOptions,
    ): Promise<MicrovmExecutionResult> {
        return new Promise<MicrovmExecutionResult>((resolve, reject) => {
            this.executionQueue = this.executionQueue.then(async () => {
                if (!this.socket || !this.handshakeComplete) {
                    throw new Error("Vsock bridge is not connected");
                }

                const execId = randomBytes(8).toString("hex");
                let stdout = "";
                let stderr = "";

                const req = {
                    v: 1,
                    type: "exec",
                    id: execId,
                    argv: [...command],
                    cwd: options?.workdir ?? "/workspace",
                    env: options?.env ? { ...options.env } : {},
                    timeoutMs: options?.timeoutMs ?? 60000,
                    maxOutputBytes: options?.maxOutputBytes ?? 1048576,
                };

                const executePromise = new Promise<MicrovmExecutionResult>((res, rej) => {
                    // 宿主侧兜底超时：agent 不应答时防止执行队列永久 stall。
                    // 比 guest 侧 timeoutMs 多 5s 宽限（正常路径以 guest 超时为准）。
                    const hostTimeoutMs = req.timeoutMs + 5000;
                    const hostTimer = setTimeout(() => {
                        if (this.activeHandlers.delete(execId)) {
                            rej(new Error(
                                `Vsock exec ${execId} 超过宿主兜底超时 ${hostTimeoutMs}ms 无应答；`
                                + "guest agent 可能卡死，拒绝无限期等待。",
                            ));
                        }
                    }, hostTimeoutMs);

                    this.activeHandlers.set(execId, {
                        onOutput: (stream, base64Data) => {
                            const decoded = Buffer.from(base64Data, "base64").toString("utf8");
                            if (stream === "stdout") {
                                stdout += decoded;
                                options?.onStdoutChunk?.(decoded);
                            } else {
                                stderr += decoded;
                                options?.onStderrChunk?.(decoded);
                            }
                        },
                        onResult: (exitCode, timedOut, truncated) => {
                            clearTimeout(hostTimer);
                            // 如实透传 guest 侧超时/截断标志，不得静默吞掉
                            res({
                                exitCode,
                                stdout,
                                stderr,
                                ...(timedOut ? { timedOut: true } : {}),
                                ...(truncated ? { truncated: true } : {}),
                            });
                        },
                        onError: (err) => {
                            clearTimeout(hostTimer);
                            rej(err);
                        },
                    });

                    try {
                        this.socket?.write(JSON.stringify(req) + "\n");
                    } catch (err: any) {
                        clearTimeout(hostTimer);
                        this.activeHandlers.delete(execId);
                        rej(err);
                    }
                });

                return executePromise.then(resolve).catch(reject);
            }).catch(reject);
        });
    }

    close(): void {
        this.handshakeComplete = false;
        this.rawBuffer = "";
        if (this.socket) {
            try {
                this.socket.destroy();
            } catch {}
            this.socket = null;
        }
    }
}
