import { isWithin, type EffectivePolicySnapshot } from "../policies/effective-policy.ts";
import type { SandboxStore } from "./sandbox-store.ts";
import {
    freezeRuntimeEvidence,
    freezeSandboxSpec,
    resolveSandboxProfile,
    type SandboxProfile,
} from "./sandbox-profile.ts";
import type {
    SandboxHandle,
    SandboxLifecycleEvent,
    SandboxProvider,
    SandboxRecord,
    SecretProvider,
} from "./sandbox-provider.ts";

/**
 * Development/test provider. It deliberately does not claim process or kernel
 * isolation and rejects hard resource limits.
 */
export class ManagedLocalSandboxProvider implements SandboxProvider {
    private readonly handlers = new Set<(event: SandboxLifecycleEvent) => void>();
    private readonly secretValues = new Map<string, Readonly<Record<string, string>>>();
    private readonly profile: SandboxProfile;

    constructor(
        private readonly store: SandboxStore,
        private readonly secrets: SecretProvider,
        config: { readonly profile?: SandboxProfile } = {},
    ) {
        this.profile = config.profile ?? "development";
        if (this.profile !== "development") {
            throw new Error("ManagedLocal 只能使用 development profile，不能承载多租户执行");
        }
    }

    async create(input: {
        id: string;
        runId: string;
        instanceId: string;
        workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle> {
        const profile = resolveSandboxProfile(input.policy.sandboxProfile, this.profile);
        if (profile !== this.profile) {
            throw new Error(`ManagedLocal 拒绝 profile：${profile}`);
        }
        if (Object.values(input.policy.resourceLimits).some((value) => value !== null)) {
            throw new Error("MANAGED_LOCAL 无法落实 CPU/内存/磁盘硬限制，拒绝执行");
        }
        if (
            input.policy.workspaceRoots !== null
            && !input.policy.workspaceRoots.some((root) => isWithin(input.workspacePath, root))
        ) {
            throw new Error(`Sandbox Workspace 超出策略范围：${input.workspacePath}`);
        }
        const secretNames = input.policy.allowedSecrets ?? [];
        const environment: Record<string, string> = {};
        for (const name of secretNames) {
            const value = this.secrets.get(input.policy.tenantId, name);
            if (value === null) throw new Error(`授权 Secret 不存在：${name}`);
            environment[name] = value;
        }
        const now = new Date().toISOString();
        const spec = freezeSandboxSpec({
            profile: "development",
            runtime: "managed-local",
            image: null,
            userId: null,
            workspaceMount: "/workspace",
            workspacePath: input.workspacePath,
            networkMode: input.policy.allowNetwork ? "bridge" : "none",
            readOnlyRootfs: false,
            droppedCapabilities: "NONE",
            noNewPrivileges: false,
            pidLimit: null,
            resourceLimits: input.policy.resourceLimits,
            secretNames,
        });
        const provisioning: SandboxRecord = {
            id: input.id,
            instanceId: input.instanceId,
            runId: input.runId,
            policySnapshotId: input.policy.id,
            provider: "MANAGED_LOCAL",
            profile: "development",
            runtime: "managed-local",
            spec,
            runtimeEvidence: freezeRuntimeEvidence({
                adapter: "managed-local",
                requestedRuntime: "managed-local",
                observedRuntime: "managed-local",
                verified: true,
                verificationReason: "仅开发/测试生命周期证据；不代表内核隔离",
                verifiedAt: now,
            }),
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
            enforcement: Object.freeze({
                toolExecutionBoundary: "HOST" as const,
                filesystemIsolation: false,
                processIsolation: false,
                networkPolicyEnforced: false,
                cpuLimitEnforced: false,
                memoryLimitEnforced: false,
                diskLimitEnforced: false,
                pidLimitEnforced: false,
            }),
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

    async cleanupStale(_record: SandboxRecord): Promise<void> {
        // ManagedLocal has no child environment that can survive this process.
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
        const tenantNamespace = Buffer.from(tenantId, "utf8").toString("hex").toUpperCase();
        return this.environment[`HARNESS_SECRET_${tenantNamespace}_${name}`] ?? null;
    }
}

function isEnvironmentSegment(value: string): boolean {
    return /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
}
