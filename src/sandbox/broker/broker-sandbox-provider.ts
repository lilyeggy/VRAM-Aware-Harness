
import { createConnection } from "node:net";
import type { EffectivePolicySnapshot } from "../../policies/effective-policy.ts";
import type {
    SandboxCommandExecutor,
    SandboxHandle,
    SandboxLifecycleEvent,
    SandboxProvider,
    SandboxRecord,
} from "../sandbox-provider.ts";
import type { SandboxStore } from "../sandbox-store.ts";
import {
    isBrokerResponse,
    type BrokerCreateResult,
    type BrokerRequest,
    type BrokerSandboxHandlePayload,
} from "./broker-protocol.ts";

export interface BrokerSandboxProviderOptions {
    readonly socketPath: string;
    /** Master 侧注入 SQLite store 以保留审计记录；Worker 侧不需要。 */
    readonly store?: SandboxStore;
    readonly requestTimeoutMs?: number;
    /**
     * 固定用户（Worker 侧）：每个 Run 的 Worker 只服务一个用户，直接把它作为
     * execute/terminate 的请求用户。
     */
    readonly userId?: string;
    /**
     * Master 侧 create 所需的 Broker control token：Broker 用它确认调用方是
     * Master 而不是被污染的 Worker。Worker 侧不设置，因此无法 create sandbox。
     */
    readonly controlToken?: string;
    /**
     * 固定 capability token（Worker 侧）：Worker 只服务一个 sandbox，直接携带
     * 它的 token 执行命令；Broker 会校验 token 与 sandboxId 绑定。
     */
    readonly capabilityToken?: string;
    /**
     * 动态解析用户（Master 侧）：Master 可能为多个用户创建 sandbox，需要在
     * terminate 时从持久化记录反查归属。返回 null 表示无法确定，调用方应拒绝
     * 而不是猜测。
     */
    readonly resolveUserId?: (sandboxId: string) => string | null;
}

/**
 * Master/Worker 侧的 Broker 客户端。
 *
 * 它只持有 Unix socket 连接，不持有 Firecracker 进程、jailer 或 user secret；
 * create/execute/terminate 全部转发给特权 Broker。
 */
export class BrokerSandboxProvider implements SandboxProvider, SandboxCommandExecutor {
    /** sandboxId -> create 时已知的用户，避免每次 terminate 都回查 store。 */
    private readonly userBySandbox = new Map<string, string>();
    /** sandboxId -> capability token，create 时生成/记录，terminate 成功后删除。 */
    private readonly tokenBySandbox = new Map<string, string>();

    constructor(private readonly options: BrokerSandboxProviderOptions) {}

    async create(input: {
        id: string;
        runId: string;
        workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle> {
        const controlToken = this.options.controlToken;
        if (controlToken === undefined) {
            throw new Error(
                "BrokerSandboxProvider 缺少 controlToken，拒绝 create（Worker 侧不应创建 sandbox）",
            );
        }
        const token = crypto.randomUUID();
        const result = await this.request<BrokerCreateResult>({
            id: crypto.randomUUID(),
            op: "create",
            input: { ...input, controlToken, token },
        });
        this.userBySandbox.set(result.record.id, input.policy.userId);
        this.tokenBySandbox.set(result.record.id, token);
        this.options.store?.create(result.record);
        return toHandle(result.handle, token);
    }

    async terminate(sandboxId: string): Promise<void> {
        const userId = this.resolveUser(sandboxId);
        if (userId === null) {
            throw new Error(
                "无法确定 sandbox " + sandboxId + " 的用户，拒绝 terminate（防止跨用户终止）",
            );
        }
        const token = this.resolveCapability(sandboxId, true);
        if (token === null) {
            throw new Error(
                "无法确定 sandbox " + sandboxId + " 的 capability token，拒绝 terminate（防止越权终止）",
            );
        }
        await this.request<Record<string, never>>({
            id: crypto.randomUUID(),
            op: "terminate",
            sandboxId,
            userId,
            token,
        });
        this.userBySandbox.delete(sandboxId);
        this.tokenBySandbox.delete(sandboxId);
        const store = this.options.store;
        if (store === undefined) {
            return;
        }
        const record = store.get(sandboxId);
        if (record !== null && record.status === "ACTIVE") {
            store.update({
                ...record,
                status: "TERMINATED",
                updatedAt: new Date().toISOString(),
            }, "ACTIVE");
        }
    }

    async execute(
        sandboxId: string,
        command: readonly string[],
        options?: { readonly workdir?: string },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const userId = this.resolveUser(sandboxId);
        if (userId === null) {
            throw new Error(
                "无法确定 sandbox " + sandboxId + " 的用户，拒绝 execute（防止跨用户执行）",
            );
        }
        const token = this.resolveCapability(sandboxId, false);
        if (token === null) {
            throw new Error(
                "无法确定 sandbox " + sandboxId + " 的 capability token，拒绝 execute（防止越权执行）",
            );
        }
        const result = await this.request<{ exitCode: number; stdout: string; stderr: string }>({
            id: crypto.randomUUID(),
            op: "execute",
            sandboxId,
            userId,
            token,
            command: [...command],
            ...(options === undefined ? {} : { options }),
        });
        return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
        };
    }

    subscribe(_handler: (event: SandboxLifecycleEvent) => void): () => void {
        return () => undefined;
    }

    async cleanupStale(record: SandboxRecord): Promise<void> {
        await this.terminate(record.id).catch(() => undefined);
    }

    async close(): Promise<void> {
        // 每次请求独立连接，无需关闭长连接。
    }

    private resolveUser(sandboxId: string): string | null {
        return this.userBySandbox.get(sandboxId)
            ?? this.options.userId
            ?? this.options.resolveUserId?.(sandboxId)
            ?? null;
    }

    /**
     * capability token 解析顺序：
     * 1. 本进程 create 时记录的 token（Master 正常路径）；
     * 2. options.capabilityToken（Worker 固定 token）；
     * 3. allowControlToken 时退回 options.controlToken（仅 terminate 允许，
     *    用于 Master 重启后清理自己创建的孤儿 sandbox）。
     */
    private resolveCapability(sandboxId: string, allowControlToken: boolean): string | null {
        const known = this.tokenBySandbox.get(sandboxId);
        if (known !== undefined) {
            return known;
        }
        if (this.options.capabilityToken !== undefined) {
            return this.options.capabilityToken;
        }
        if (allowControlToken && this.options.controlToken !== undefined) {
            return this.options.controlToken;
        }
        return null;
    }

    private async request<T>(request: BrokerRequest): Promise<T> {
        const timeoutMs = this.options.requestTimeoutMs ?? 120_000;
        return await new Promise<T>((resolve, reject) => {
            let buffer = "";
            let settled = false;
            const socket = createConnection({ path: this.options.socketPath });
            const finish = (error: Error | null, value?: T): void => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                if (error === null) {
                    resolve(value as T);
                } else {
                    reject(error);
                }
            };

            socket.setTimeout(timeoutMs);
            socket.on("connect", () => {
                socket.write(JSON.stringify(request) + "\n");
            });
            socket.on("data", (chunk: Buffer) => {
                buffer += chunk.toString("utf8");
                const newlineIndex = buffer.indexOf("\n");
                if (newlineIndex < 0) {
                    return;
                }
                const line = buffer.slice(0, newlineIndex);
                try {
                    const parsed: unknown = JSON.parse(line);
                    if (isBrokerResponse(parsed) === false) {
                        finish(new Error("Invalid broker response"));
                        return;
                    }
                    if (parsed.id !== request.id) {
                        finish(new Error("Broker response id mismatch"));
                        return;
                    }
                    if (parsed.ok) {
                        finish(null, parsed.result as T);
                    } else {
                        finish(new Error(parsed.error));
                    }
                } catch (error) {
                    finish(new Error("Invalid broker response: " + String(error)));
                }
            });
            socket.on("timeout", () => {
                finish(new Error("Broker request timed out after " + timeoutMs + "ms"));
            });
            socket.on("error", (error) => {
                finish(error instanceof Error ? error : new Error(String(error)));
            });
            socket.on("close", () => {
                if (settled === false) {
                    finish(new Error("Broker connection closed before response"));
                }
            });
        });
    }
}

function toHandle(payload: BrokerSandboxHandlePayload, capabilityToken?: string): SandboxHandle {
    return {
        id: payload.id,
        workspacePath: payload.workspacePath,
        secretNames: payload.secretNames,
        enforcement: payload.enforcement,
        mountRoot: payload.mountRoot,
        containerWorkdir: payload.containerWorkdir,
        ...(capabilityToken === undefined ? {} : { capabilityToken }),
        ...(payload.acquisition === undefined ? {} : { acquisition: payload.acquisition }),
        withSecrets: <T>(_callback: (environment: Readonly<Record<string, string>>) => T): T => {
            throw new Error(
                "BrokerSandboxProvider 不在客户端暴露 secret；secret 仅在 Broker 进程内注入",
            );
        },
    };
}
