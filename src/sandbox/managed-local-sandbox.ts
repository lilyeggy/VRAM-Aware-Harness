import { isWithin, type EffectivePolicySnapshot } from "../policies/effective-policy.ts";
import type { SandboxStore } from "./sandbox-store.ts";
import type {
    SandboxHandle,
    SandboxLifecycleEvent,
    SandboxProvider,
    SandboxRecord,
    SecretProvider,
} from "./sandbox-provider.ts";

/**
 * 首个 Provider 不假装提供容器级隔离：Workspace 与工具文件/进程/网络约束
 * 由控制面和 ToolGateway 强制；这里负责生命周期、资源预算证据与按需 Secret 租约。
 */
export class ManagedLocalSandboxProvider implements SandboxProvider {
    private readonly handlers = new Set<(event: SandboxLifecycleEvent) => void>();
    private readonly secretValues = new Map<string, Readonly<Record<string, string>>>();

    constructor(
        private readonly store: SandboxStore,
        private readonly secrets: SecretProvider,
    ) {}

    async create(input: {
        id: string;
        runId: string;
        instanceId: string;
        workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle> {
        if (Object.values(input.policy.resourceLimits).some((value) => value !== null)) {
            throw new Error(
                "MANAGED_LOCAL 无法落实 CPU/内存/磁盘硬限制，拒绝执行",
            );
        }
        if (
            input.policy.workspaceRoots !== null
            && !input.policy.workspaceRoots.some((root) =>
                isWithin(input.workspacePath, root))
        ) {
            throw new Error(`Sandbox Workspace 超出策略范围：${input.workspacePath}`);
        }
        const now = new Date().toISOString();
        const secretNames = input.policy.allowedSecrets ?? [];
        const environment: Record<string, string> = {};
        for (const name of secretNames) {
            const value = this.secrets.get(input.policy.tenantId, name);
            if (value === null) {
                throw new Error(`授权 Secret 不存在：${name}`);
            }
            environment[name] = value;
        }
        const provisioning: SandboxRecord = {
            id: input.id,
            instanceId: input.instanceId,
            runId: input.runId,
            policySnapshotId: input.policy.id,
            provider: "MANAGED_LOCAL",
            status: "PROVISIONING",
            workspacePath: input.workspacePath,
            secretNames: Object.freeze([...secretNames]),
            createdAt: now,
            updatedAt: now,
            failureReason: null,
        };
        this.store.create(provisioning);
        const active = { ...provisioning, status: "ACTIVE" as const };
        this.store.update(active, "PROVISIONING");
        this.secretValues.set(input.id, Object.freeze(environment));

        return Object.freeze({
            id: input.id,
            workspacePath: input.workspacePath,
            secretNames: provisioning.secretNames,
            withSecrets: <T>(callback: (values: Readonly<Record<string, string>>) => T) =>
                callback(this.secretValues.get(input.id) ?? Object.freeze({})),
        });
    }

    async terminate(sandboxId: string): Promise<void> {
        const current = this.store.get(sandboxId);
        this.secretValues.delete(sandboxId);
        if (current === null || current.status === "TERMINATED") return;
        if (current.status !== "ACTIVE") return;
        this.store.update({
            ...current,
            status: "TERMINATED",
            updatedAt: new Date().toISOString(),
        }, current.status);
    }

    /** 故障注入和真实 Provider 失联回调共用的生命周期入口。 */
    lose(sandboxId: string, reason: string): void {
        const current = this.store.get(sandboxId);
        if (current === null || current.status !== "ACTIVE") return;
        const timestamp = new Date().toISOString();
        this.secretValues.delete(sandboxId);
        this.store.update({
            ...current,
            status: "LOST",
            updatedAt: timestamp,
            failureReason: reason,
        }, current.status);
        for (const handler of this.handlers) {
            handler({
                sandboxId,
                runId: current.runId,
                instanceId: current.instanceId,
                status: "LOST",
                reason,
                timestamp,
            });
        }
    }

    subscribe(handler: (event: SandboxLifecycleEvent) => void): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }
}

export class EnvironmentSecretProvider implements SecretProvider {
    constructor(private readonly environment: Record<string, string | undefined>) {}
    get(tenantId: string, name: string): string | null {
        if (!isEnvironmentSegment(name)) {
            throw new Error("Secret 名称只能包含大写字母、数字和下划线");
        }
        // Do not fall back to a global NAME lookup: that would let two tenants
        // with an allowed identical name observe the same value. Hex avoids
        // collisions between legal IDs such as tenant-a and tenant_a.
        const tenantNamespace = Buffer.from(tenantId, "utf8").toString("hex").toUpperCase();
        return this.environment[`HARNESS_SECRET_${tenantNamespace}_${name}`] ?? null;
    }
}

function isEnvironmentSegment(value: string): boolean {
    return /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
}
