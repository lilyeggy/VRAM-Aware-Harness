
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type {
    SandboxCommandExecutor,
    SandboxHandle,
    SandboxProvider,
    SandboxRecord,
} from "../sandbox-provider.ts";
import {
    isBrokerRequest,
    type BrokerCreateResult,
    type BrokerRequest,
    type BrokerResponse,
    type BrokerSandboxHandlePayload,
} from "./broker-protocol.ts";

export interface SandboxBrokerServerOptions {
    readonly socketPath: string;
    readonly provider: SandboxProvider & SandboxCommandExecutor;
    /** Broker 侧记录查询：create 后据此回传完整 SandboxRecord。 */
    readonly readRecord: (sandboxId: string) => SandboxRecord | null;
    readonly onError?: (error: unknown) => void;
}

/**
 * 特权最小 Sandbox Broker：只暴露 create/execute/terminate 三个操作，
 * Master/Worker 通过 Unix socket 调用，永远不直接持有 Firecracker 进程。
 */
export class SandboxBrokerServer {
    private readonly server: Server;
    private readonly sockets = new Set<Socket>();
    private started = false;

    constructor(private readonly options: SandboxBrokerServerOptions) {
        this.server = createServer((socket) => this.handleConnection(socket));
    }

    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.prepareSocketPath();
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                this.server.off("listening", onListening);
                reject(error);
            };
            const onListening = (): void => {
                this.server.off("error", onError);
                resolve();
            };
            this.server.once("error", onError);
            this.server.once("listening", onListening);
            this.server.listen(this.options.socketPath);
        });
        chmodSync(this.options.socketPath, 0o660);
        this.started = true;
    }

    async close(): Promise<void> {
        for (const socket of this.sockets) {
            socket.destroy();
        }
        this.sockets.clear();
        await new Promise<void>((resolve) => {
            this.server.close(() => resolve());
        });
        await this.options.provider.close?.();
        if (existsSync(this.options.socketPath)) {
            unlinkSync(this.options.socketPath);
        }
        this.started = false;
    }

    private prepareSocketPath(): void {
        if (existsSync(this.options.socketPath) === false) {
            return;
        }
        const stat = statSync(this.options.socketPath);
        if (stat.isSocket() === false) {
            throw new Error("Broker socket path exists and is not a socket: " + this.options.socketPath);
        }
        unlinkSync(this.options.socketPath);
    }

    private handleConnection(socket: Socket): void {
        this.sockets.add(socket);
        socket.setEncoding("utf8");
        let buffer = "";
        let chain: Promise<void> = Promise.resolve();
        socket.on("data", (chunk: string) => {
            buffer += chunk;
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex >= 0) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                if (line.trim().length > 0) {
                    chain = chain.then(
                        () => this.handleLine(socket, line),
                        (error) => {
                            this.options.onError?.(error);
                        },
                    );
                }
                newlineIndex = buffer.indexOf("\n");
            }
        });
        socket.on("error", (error) => {
            this.options.onError?.(error);
        });
        socket.on("close", () => {
            this.sockets.delete(socket);
        });
    }

    private async handleLine(socket: Socket, line: string): Promise<void> {
        let request: BrokerRequest;
        try {
            const parsed: unknown = JSON.parse(line);
            if (isBrokerRequest(parsed) === false) {
                throw new Error("Invalid broker request");
            }
            request = parsed;
        } catch (error) {
            this.writeResponse(socket, {
                id: "unknown",
                ok: false,
                error: errorMessage(error),
            });
            return;
        }

        try {
            const result = await this.dispatch(request);
            this.writeResponse(socket, { id: request.id, ok: true, result });
        } catch (error) {
            this.writeResponse(socket, {
                id: request.id,
                ok: false,
                error: errorMessage(error),
            });
        }
    }

    private async dispatch(request: BrokerRequest): Promise<unknown> {
        switch (request.op) {
            case "ping":
                return { pid: process.pid };
            case "create": {
                const handle = await this.options.provider.create(request.input);
                const record = this.options.readRecord(handle.id);
                if (record === null) {
                    throw new Error("Broker created sandbox but record is missing: " + handle.id);
                }
                const result: BrokerCreateResult = {
                    record,
                    handle: toPayload(handle),
                };
                return result;
            }
            case "execute":
                return await this.options.provider.execute(
                    request.sandboxId,
                    request.command,
                    request.options,
                );
            case "terminate":
                await this.options.provider.terminate(request.sandboxId);
                return {};
        }
    }

    private writeResponse(socket: Socket, response: BrokerResponse): void {
        if (socket.destroyed) {
            return;
        }
        socket.write(JSON.stringify(response) + "\n");
    }
}

function toPayload(handle: SandboxHandle): BrokerSandboxHandlePayload {
    return {
        id: handle.id,
        workspacePath: handle.workspacePath,
        secretNames: [...handle.secretNames],
        enforcement: handle.enforcement,
        mountRoot: handle.mountRoot,
        containerWorkdir: handle.containerWorkdir,
        ...(handle.acquisition === undefined ? {} : { acquisition: handle.acquisition }),
    };
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
