
import { createHash, timingSafeEqual } from "node:crypto";
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
import {
    createPeerCredentialsReader,
    type PeerCredentials,
    type PeerCredentialsReader,
} from "./peer-credentials.ts";

export interface SandboxBrokerServerOptions {
    readonly socketPath: string;
    readonly provider: SandboxProvider & SandboxCommandExecutor;
    /** Broker 侧记录查询：create 后据此回传完整 SandboxRecord。 */
    readonly readRecord: (sandboxId: string) => SandboxRecord | null;
    readonly onError?: (error: unknown) => void;
    /**
     * Master -> Broker 的静态共享 secret。Broker 强制要求 create 携带且匹配；
     * 它让 Broker 能区分“可信 Master”与“可能被污染的 Worker”，从而把 create
     * 限制在控制面。
     */
    readonly controlToken: string;
    /**
     * 允许连接 Broker 的 peer UID 白名单（SO_PEERCRED）。设置后，不在白名单内的
     * 连接在握手前被拒绝；读取不到 peer 凭据时 fail-closed。
     */
    readonly allowedPeerUids?: ReadonlySet<number>;
    /** 若设置，create/terminate 只接受该 UID（Master 控制面）。 */
    readonly masterPeerUid?: number;
    /** 若设置，execute 只接受该 UID（Worker 执行面）。 */
    readonly workerPeerUid?: number;
    /** 测试注入用；默认使用 Linux SO_PEERCRED。 */
    readonly readPeerCredentials?: PeerCredentialsReader;
}

/**
 * 特权最小 Sandbox Broker：只暴露 create/execute/terminate 三个操作，
 * Master/Worker 通过 Unix socket 调用，永远不直接持有 Firecracker 进程。
 */
export class SandboxBrokerServer {
    private readonly server: Server;
    private readonly sockets = new Set<Socket>();
    /**
     * sandboxId -> 归属用户。create 时从 policy.userId 记录；execute/terminate
     * 必须携带同一 userId，否则拒绝。它把“同一 Broker 服务多用户”从约定
     * 变成协议级校验，防止一个用户的 Worker 拿 sandboxId 操作另一个用户的 VM。
     */
    private readonly userBySandbox = new Map<string, string>();
    /** sandboxId -> capability token；execute/terminate 必须携带匹配 token。 */
    private readonly tokenBySandbox = new Map<string, string>();
    /** capability token -> sandboxId；用于拒绝重复 token。 */
    private readonly sandboxByToken = new Map<string, string>();
    /** 每个连接的 SO_PEERCRED 快照；null 表示读取失败（fail-closed）。 */
    private readonly peerBySocket = new WeakMap<Socket, PeerCredentials | null>();
    private readonly readPeerCredentials: PeerCredentialsReader;
    private started = false;

    constructor(private readonly options: SandboxBrokerServerOptions) {
        if (options.controlToken.length === 0) {
            throw new Error("SandboxBrokerServer 必须配置非空 controlToken");
        }
        this.readPeerCredentials = options.readPeerCredentials ?? createPeerCredentialsReader();
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
        const peer = this.readPeerCredentials(socket);
        this.peerBySocket.set(socket, peer);
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
            this.assertPeerOperation(socket, request);
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
            case "commit_receipt": {
                this.assertControlToken(request.token);
                const provider = this.options.provider as typeof this.options.provider & {
                    getCommitReceipt?: (sandboxId: string, userId: string, workspacePath: string) => Promise<unknown>;
                };
                if (!provider.getCommitReceipt) throw new Error("Workspace 提交回执未启用");
                return provider.getCommitReceipt(request.sandboxId, request.userId, request.workspacePath);
            }
            case "create": {
                this.assertControlToken(request.input.controlToken);
                if (this.sandboxByToken.has(request.input.token)) {
                    throw new Error("Broker 拒绝 create：capability token 已被使用");
                }
                const handle = await this.options.provider.create(request.input);
                const record = this.options.readRecord(handle.id);
                if (record === null) {
                    // F6：create 已经真实建好 VM，但 readRecord 失败时如果不回收，
                    // Broker 侧不会登记 userBySandbox/tokenBySandbox，后续
                    // terminate 会在 assertUser 处直接报“Broker 不认识 sandbox”，
                    // 连 controlToken 兜底都走不通——变成不可寻址孤儿 VM。
                    try {
                        await this.options.provider.terminate(handle.id);
                    } catch (cleanupError) {
                        this.options.onError?.(cleanupError);
                    }
                    throw new Error("Broker created sandbox but record is missing: " + handle.id);
                }
                this.userBySandbox.set(handle.id, request.input.policy.userId);
                this.tokenBySandbox.set(handle.id, request.input.token);
                this.sandboxByToken.set(request.input.token, handle.id);
                const result: BrokerCreateResult = {
                    record,
                    handle: toPayload(handle),
                };
                return result;
            }
            case "execute":
                this.assertCapability(request.sandboxId, request.userId, request.token, false);
                return await this.options.provider.execute(
                    request.sandboxId,
                    request.command,
                    request.options,
                );
            case "terminate":
                this.assertCapability(request.sandboxId, request.userId, request.token, true);
                await this.options.provider.terminate(request.sandboxId);
                this.userBySandbox.delete(request.sandboxId);
                {
                    const token = this.tokenBySandbox.get(request.sandboxId);
                    if (token !== undefined) {
                        this.tokenBySandbox.delete(request.sandboxId);
                        this.sandboxByToken.delete(token);
                    }
                }
                return {};
        }
    }

    /**
     * 用 SO_PEERCRED 把操作绑定到进程 UID：create/terminate 属于 Master，
     * execute 属于 Worker。未配置对应 UID 时不额外限制；配置了但读不到凭据
     * 或 UID 不匹配时 fail-closed。
     */
    private assertPeerOperation(socket: Socket, request: BrokerRequest): void {
        const allowed = this.options.allowedPeerUids;
        const required = request.op === "execute"
            ? this.options.workerPeerUid
            : request.op === "create" || request.op === "terminate" || request.op === "commit_receipt"
                ? this.options.masterPeerUid
                : undefined;
        if ((allowed === undefined || allowed.size === 0) && required === undefined) {
            return;
        }
        const peer = this.peerBySocket.get(socket) ?? null;
        if (peer === null) {
            throw new Error(
                "Broker 拒绝 " + request.op + "：无法读取对端 SO_PEERCRED 凭据",
            );
        }
        if (allowed !== undefined && allowed.size > 0 && allowed.has(peer.uid) === false) {
            throw new Error(
                "Broker 拒绝 " + request.op + "：对端 uid=" + peer.uid
                + " 不在 SO_PEERCRED 白名单内",
            );
        }
        if (required !== undefined && peer.uid !== required) {
            throw new Error(
                "Broker 拒绝 " + request.op + "：对端 uid=" + peer.uid
                + "，要求 uid=" + required,
            );
        }
    }

    private assertUser(sandboxId: string, userId: string): void {
        const owner = this.userBySandbox.get(sandboxId);
        if (owner === undefined) {
            throw new Error("Broker 不认识 sandbox：" + sandboxId);
        }
        if (owner !== userId) {
            throw new Error(
                "Broker 拒绝跨用户操作：sandbox " + sandboxId
                + " 属于用户 " + owner + "，请求用户 " + userId,
            );
        }
    }

    private assertControlToken(token: string): void {
        if (!constantTimeEqual(token, this.options.controlToken)) {
            throw new Error("Broker 拒绝 create：control token 不匹配");
        }
    }

    /**
     * 校验 sandbox 归属与 capability token。allowControlToken=true 时额外接受
     * Broker 的 control token，仅用于 Master 侧 terminate（例如 Master 重启后
     * 已丢失 per-sandbox token，但仍需回收自己创建的孤儿 VM）。
     */
    private assertCapability(
        sandboxId: string,
        userId: string,
        token: string,
        allowControlToken: boolean,
    ): void {
        this.assertUser(sandboxId, userId);
        const expected = this.tokenBySandbox.get(sandboxId);
        if (expected !== undefined && constantTimeEqual(token, expected)) {
            return;
        }
        if (allowControlToken && constantTimeEqual(token, this.options.controlToken)) {
            return;
        }
        throw new Error(
            "Broker 拒绝：sandbox " + sandboxId + " 的 capability token 不匹配",
        );
    }

    private writeResponse(socket: Socket, response: BrokerResponse): void {
        if (socket.destroyed) {
            return;
        }
        socket.write(JSON.stringify(response) + "\n");
    }
}

/**
 * F12：control token / capability token 的恒时比较。先各自 SHA-256，
 * 再对等长摘要做 timingSafeEqual，避免直接字符串比较泄露长度/前缀。
 */
function constantTimeEqual(left: string, right: string): boolean {
    const leftDigest = createHash("sha256").update(left).digest();
    const rightDigest = createHash("sha256").update(right).digest();
    return timingSafeEqual(leftDigest, rightDigest);
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
