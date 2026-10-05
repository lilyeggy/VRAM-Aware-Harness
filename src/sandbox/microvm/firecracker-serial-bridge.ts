import type { Readable, Writable } from "node:stream";
import type { MicrovmExecuteOptions, MicrovmExecutionResult } from "./microvm-types.ts";

export interface SerialBridgeConfig {
    readonly defaultTimeoutMs?: number;
    readonly promptReadySentinel?: string;
}

/**
 * Manages bidirectional interactive communication with a Firecracker MicroVM
 * over its serial console (ttyS0 / stdio).
 *
 * It uses sentinel demarcation to detect command completion, extract exit codes,
 * and maintain persistent shell sessions across multi-turn tool calls.
 */
export class FirecrackerSerialBridge {
    private readonly stdin: Writable;
    private readonly stdout: Readable;
    private readonly defaultTimeoutMs: number;
    private buffer = "";
    private isExecuting = false;
    private executionQueue: Array<() => void> = [];
    private closed = false;

    constructor(
        stdin: Writable,
        stdout: Readable,
        config: SerialBridgeConfig = {},
    ) {
        this.stdin = stdin;
        this.stdout = stdout;
        this.defaultTimeoutMs = config.defaultTimeoutMs ?? 60_000;

        this.stdout.on("data", (chunk: Buffer | string) => {
            const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            this.buffer += str;
        });

        this.stdout.on("error", (err) => {
            console.error("[FirecrackerSerialBridge] stdout error:", err);
        });
    }

    /**
     * Executes a command inside the persistent guest shell session and waits for its exit code.
     */
    async execute(
        command: readonly string[],
        options: MicrovmExecuteOptions = {},
    ): Promise<MicrovmExecutionResult> {
        if (this.closed) {
            throw new Error("FirecrackerSerialBridge 已关闭，无法执行命令");
        }

        // 串行队列锁：串口控制台是单流，多命令必须排队执行
        if (this.isExecuting) {
            await new Promise<void>((resolve) => {
                this.executionQueue.push(resolve);
            });
        }

        this.isExecuting = true;
        try {
            return await this.executeInternal(command, options);
        } finally {
            this.isExecuting = false;
            const next = this.executionQueue.shift();
            if (next) next();
        }
    }

    private async executeInternal(
        command: readonly string[],
        options: MicrovmExecuteOptions,
    ): Promise<MicrovmExecutionResult> {
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
        const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const sentinel = `__HARNESS_DONE_${nonce}__`;

        let rawCmd = command.join(" ");
        if (options.workdir) {
            rawCmd = `cd ${options.workdir} && ${rawCmd}`;
        }

        // 确保命令末尾输出带有退出码的哨兵标记
        const payload = `\n${rawCmd}\necho "${sentinel}:$?"\n`;

        // 记录发送命令前的缓冲区长度，后续只提取此后的输出
        const startBufferIndex = this.buffer.length;

        this.stdin.write(payload);

        return new Promise<MicrovmExecutionResult>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;

            const checkBuffer = () => {
                const searchArea = this.buffer.slice(startBufferIndex);
                const markerIndex = searchArea.indexOf(sentinel);

                if (markerIndex !== -1) {
                    if (timer) clearTimeout(timer);
                    clearInterval(interval);

                    // 匹配 `${sentinel}:<exitCode>`
                    const rest = searchArea.slice(markerIndex);
                    const match = rest.match(new RegExp(`${sentinel}:(\\d+)`));

                    if (match) {
                        const exitCode = parseInt(match[1], 10);
                        let output = searchArea.slice(0, markerIndex);

                        // 清洗终端可能的回显指令头部（仅当整行与发出的原始命令一致时剥除）
                        const lines = output.split(/\r?\n/);
                        if (lines.length > 0 && lines[0].trim() === rawCmd.trim()) {
                            lines.shift();
                        }
                        const cleanStdout = lines.join("\n").trim();

                        if (options.onStdoutChunk && cleanStdout.length > 0) {
                            options.onStdoutChunk(cleanStdout);
                        }

                        resolve({
                            exitCode,
                            stdout: cleanStdout,
                            stderr: "",
                        });
                        return;
                    }
                }
            };

            const interval = setInterval(checkBuffer, 20);

            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    clearInterval(interval);
                    // 发送 Ctrl+C 尝试打断虚拟机内正在运行的阻塞进程
                    this.stdin.write("\x03\n");
                    reject(new Error(`命令在 MicroVM 中执行超时 (${timeoutMs}ms): ${command.join(" ")}`));
                }, timeoutMs);
            }
        });
    }

    close(): void {
        this.closed = true;
        this.executionQueue.length = 0;
        this.buffer = "";
    }
}
