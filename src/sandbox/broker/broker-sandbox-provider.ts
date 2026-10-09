
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
     * 固定租户（Worker 侧）：每个 Run 的 Worker 只服务一个租户，直接把它作为
     * execute/terminate 的请求租户。
     */
    readonly tenantId?: string;
    /**
     * 动态解析租户（Master 侧）：Master 可能为多个租户创建 sandbox，需要在
     * terminate 时从持久化记录反查归属。返回 null 表示无法确定，调用方应拒绝
     * 而不是猜测。
     */
    readonly resolveTenantId?: (sandboxId: string) => string | null;
}

/**
 * Master/Worker 侧的 Broker 客户端。
 *
 * 它只持有 Unix socket 连接，不持有 Firecracker 进程、jailer 或 tenant secret；
 * create/execute/terminate 全部转发给特权 Broker。
 */
export class BrokerSandboxProvider implements SandboxProvider, SandboxCommandExecutor {
    /** sandboxId -> create 时已知的租户，避免每次 terminate 都回查 store。 */
    private readonly tenantBySandbox = new Map<string, string>();

    constructor(private readonly options: BrokerSandboxProviderOptions) {}

    async create(input: {
        id: string;
        runId: string;
        workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle> {
        const result = await this.request<BrokerCreateResult>({
            id: crypto.randomUUID(),
            op: "create",
            input,
        });
        this.tenantBySandbox.set(result.record.id, input.policy.tenantId);
        this.options.store?.create(result.record);
        return toHandle(result.handle);
    }

    async terminate(sandboxId: string): Promise<void> {
        const tenantId = this.resolveTenant(sandboxId);
        if (tenantId === null) {
            throw new Error(
                "无法确定 sandbox " + sandboxId + " 的租户，拒绝 terminate（防止跨租户终止）",
            );
        }
        await this.request<Record<string, never>>({
            id: crypto.randomUUID(),
            op: "terminate",
            sandboxId,
            tenantId,
        });
        this.tenantBySandbox.delete(sandboxId);
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
        const tenantId = this.resolveTenant(sandboxId);
        if (tenantId === null) {
            throw new Error(
                "无法确定 sandbox " + sandboxId + " 的租户，拒绝 execute（防止跨租户执行）",
            );
        }
        const result = await this.request<{ exitCode: number; stdout: string; stderr: string }>({
            id: crypto.randomUUID(),
            op: "execute",
            sandboxId,
            tenantId,
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

    private resolveTenant(sandboxId: string): string | null {
        return this.tenantBySandbox.get(sandboxId)
            ?? this.options.tenantId
            ?? this.options.resolveTenantId?.(sandboxId)
            ?? null;
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

function toHandle(payload: BrokerSandboxHandlePayload): SandboxHandle {
    return {
        id: payload.id,
        workspacePath: payload.workspacePath,
        secretNames: payload.secretNames,
        enforcement: payload.enforcement,
        mountRoot: payload.mountRoot,
        containerWorkdir: payload.containerWorkdir,
        ...(payload.acquisition === undefined ? {} : { acquisition: payload.acquisition }),
        withSecrets: <T>(_callback: (environment: Readonly<Record<string, string>>) => T): T => {
            throw new Error(
                "BrokerSandboxProvider 不在客户端暴露 secret；secret 仅在 Broker 进程内注入",
            );
        },
    };
}
