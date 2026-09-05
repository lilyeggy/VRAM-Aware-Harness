import type { EffectivePolicySnapshot } from "../policies/effective-policy.ts";
import { ContainerWarmPool } from './container-warm-pool.ts';
import {
    DockerRuncRuntimeAdapter,
    DockerRunscRuntimeAdapter,
    type ContainerCommandRuntime,
    type ContainerRuntimeAdapter,
} from "./container-runtime-adapter.ts";
import {
    freezeRuntimeEvidence,
    resolveSandboxProfile,
    type SandboxProfile,
} from "./sandbox-profile.ts";
import { OciSandboxSpecCompiler } from "./oci-sandbox-spec.ts";
import type { SandboxStore } from "./sandbox-store.ts";
import type {
    SandboxCommandExecutor,
    SandboxHandle,
    SandboxLifecycleEvent,
    SandboxProvider,
    SandboxRecord,
    SecretProvider,
} from "./sandbox-provider.ts";

export type { ContainerCommandRuntime } from "./container-runtime-adapter.ts";

export interface ContainerSandboxConfig {
    readonly warmPoolSize?: number;
    readonly warmPoolOwner?: string;
    readonly image: string;
    /**
     * `runtime` accepted a Docker executable path in the pre-P0.5 contract;
     * known runsc/runc values are also accepted as the runtime selector.
     */
    readonly runtime?: string;
    /** New explicit runtime selector; defaults to runsc. */
    readonly sandboxRuntime?: "runsc" | "runc";
    readonly dockerCommand?: string;
    readonly profile?: SandboxProfile;
    readonly userId?: number;
}

/**
 * OCI/Docker lifecycle provider. OCI policy compilation and the actual runtime
 * adapter are intentionally separate: an OCI-compatible image does not prove
 * which kernel/runtime executed it.
 */
export class ContainerSandboxProvider implements SandboxProvider, SandboxCommandExecutor {
    private readonly handlers = new Set<(event: SandboxLifecycleEvent) => void>();
    private readonly containerBySandboxId = new Map<string, string>();
    private readonly secretValues = new Map<string, Readonly<Record<string, string>>>();
    private readonly docker: string;
    private readonly profile: SandboxProfile;
    private readonly runtime: "runsc" | "runc";
    private readonly adapter: ContainerRuntimeAdapter;
    private readonly compiler: OciSandboxSpecCompiler;
    private readonly warmPool: ContainerWarmPool | undefined;
    private readonly replenishments = new Map<string, { key: string; args: readonly string[] }>();

    constructor(
        private readonly store: SandboxStore,
        private readonly secrets: SecretProvider,
        private readonly config: ContainerSandboxConfig,
        private readonly commands: ContainerCommandRuntime = new BunContainerCommandRuntime(),
        adapter?: ContainerRuntimeAdapter,
    ) {
        if (config.userId !== undefined && (!Number.isInteger(config.userId) || config.userId <= 0)) {
            throw new Error("Container Sandbox userId 必须是正整数，不能使用 root");
        }
        this.profile = config.profile ?? "default";
        this.runtime = config.sandboxRuntime
            ?? (config.runtime === "runc" || config.runtime === "runsc"
                ? config.runtime
                : "runsc");
        this.docker = config.dockerCommand
            ?? (config.runtime !== undefined
                && config.runtime !== "runc"
                && config.runtime !== "runsc"
                ? config.runtime
                : "docker");
        if (this.profile === "default" || this.profile === "restricted-egress") {
            if (this.runtime !== "runsc") {
                throw new Error(`${this.profile} profile 禁止使用 ${this.runtime}，不得回退到 runc`);
            }
        }
        if (this.profile === "strict") {
            throw new Error("strict profile 必须由 SandboxProviderRouter 路由到 microVM Provider");
        }
        this.adapter = adapter ?? (
            this.runtime === "runsc"
                ? new DockerRunscRuntimeAdapter()
                : new DockerRuncRuntimeAdapter()
        );
        if (this.adapter.runtime !== this.runtime) {
            throw new Error("runtime adapter 与配置 runtime 不一致");
        }
        this.compiler = new OciSandboxSpecCompiler({
            image: config.image,
            userId: config.userId ?? 65532,
            profile: this.profile,
            runtime: this.runtime,
        });
        if (config.warmPoolSize) this.warmPool = new ContainerWarmPool(commands, this.docker, config.warmPoolSize, 60_000, config.warmPoolOwner);
    }

    async create(input: {
        id: string; runId: string; instanceId: string; workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle> {
        const profile = resolveSandboxProfile(input.policy.sandboxProfile, this.profile);
        if (profile !== this.profile) {
            throw new Error(`Sandbox profile 未路由到匹配 Provider：${profile}`);
        }
        const environment: Record<string, string> = {};
        for (const name of input.policy.allowedSecrets ?? []) {
            const value = this.secrets.get(input.policy.tenantId, name);
            if (value === null) throw new Error(`授权 Secret 不存在：${name}`);
            environment[name] = value;
        }
        const compiled = this.compiler.compile(
            `agent-harness-${input.id}`,
            input.workspacePath,
            input.policy,
            Object.keys(environment),
        );
        const now = new Date().toISOString();
        const evidence = freezeRuntimeEvidence({
            adapter: this.adapter.name,
            requestedRuntime: this.runtime,
            observedRuntime: null,
            verified: false,
            verificationReason: "等待 Docker inspect runtime 证据",
            verifiedAt: null,
        });
        const record: SandboxRecord = {
            id: input.id, instanceId: input.instanceId, runId: input.runId,
            policySnapshotId: input.policy.id, provider: "CONTAINER",
            profile: compiled.spec.profile, runtime: compiled.spec.runtime,
            spec: compiled.spec, runtimeEvidence: evidence,
            status: "PROVISIONING", workspacePath: input.workspacePath,
            secretNames: Object.freeze(Object.keys(environment)),
            createdAt: now, updatedAt: now, failureReason: null,
        };
        this.store.create(record);
        const args = this.withSecretValues(
            this.adapter.augmentCreateArgs(compiled.createArgs),
            environment,
        );
        const keyArgs = [...args];
        keyArgs[keyArgs.indexOf('--name') + 1] = '<resource>';
        const poolKey = JSON.stringify([input.policy.tenantId, keyArgs]);
        const eligible = this.warmPool !== undefined && Object.keys(environment).length === 0;
        const acquisitionStartedAt = performance.now();
        const warmed = eligible && await this.warmPool!.take(poolKey, `agent-harness-${input.id}`);
        const result = warmed ? { exitCode: 0, stdout: '', stderr: '' }
            : await this.commands.run([this.docker, ...args]);
        if (result.exitCode !== 0) {
            const failed = {
                ...record, status: "FAILED" as const, updatedAt: new Date().toISOString(),
                failureReason: redact(result.stderr || result.stdout),
                runtimeEvidence: freezeRuntimeEvidence({
                    ...evidence,
                    verificationReason: "容器创建失败，未取得实际 runtime 证据",
                }),
            };
            this.store.update(failed, "PROVISIONING");
            this.emit(failed, "FAILED", failed.failureReason ?? "container create failed");
            throw new Error(`容器 Sandbox 创建失败：${failed.failureReason}`);
        }

        const verifiedEvidence = await this.adapter.verify(
            this.commands, this.docker, `agent-harness-${input.id}`,
        );
        if (!verifiedEvidence.verified) {
            await this.commands.run([this.docker, "rm", "--force", `agent-harness-${input.id}`]);
            const reason = verifiedEvidence.verificationReason
                ?? `实际 runtime 不是 ${this.runtime}`;
            const failed = {
                ...record, status: "FAILED" as const, updatedAt: new Date().toISOString(),
                failureReason: reason, runtimeEvidence: freezeRuntimeEvidence(verifiedEvidence),
            };
            this.store.update(failed, "PROVISIONING");
            this.emit(failed, "FAILED", reason);
            throw new Error(`Sandbox runtime 证据校验失败：${reason}`);
        }

        this.containerBySandboxId.set(input.id, `agent-harness-${input.id}`);
        if (eligible) this.replenishments.set(input.id, { key: poolKey, args });
        this.secretValues.set(input.id, Object.freeze(environment));
        this.store.update({
            ...record,
            status: "ACTIVE",
            updatedAt: new Date().toISOString(),
            runtimeEvidence: freezeRuntimeEvidence(verifiedEvidence),
        }, "PROVISIONING");
        return Object.freeze({
            id: input.id, workspacePath: input.workspacePath, secretNames: record.secretNames,
            acquisition: Object.freeze({
                durationMs: Math.round(performance.now() - acquisitionStartedAt),
                warmHit: Boolean(warmed),
            }),
            enforcement: Object.freeze({
                toolExecutionBoundary: "SANDBOX" as const,
                filesystemIsolation: true,
                processIsolation: true,
                networkPolicyEnforced: true,
                cpuLimitEnforced: compiled.spec.resourceLimits.cpuCores !== null,
                memoryLimitEnforced: compiled.spec.resourceLimits.memoryMiB !== null,
                diskLimitEnforced: compiled.spec.resourceLimits.diskMiB !== null,
                pidLimitEnforced: compiled.spec.pidLimit !== null,
            }),
            withSecrets: <T>(callback: (values: Readonly<Record<string, string>>) => T) =>
                callback(this.secretValues.get(input.id) ?? Object.freeze({})),
        });
    }

    async execute(sandboxId: string, command: readonly string[]) {
        const name = this.containerBySandboxId.get(sandboxId);
        if (name === undefined) throw new Error(`Sandbox 不可执行：${sandboxId}`);
        const result = await this.commands.run([
            this.docker, "exec", "--workdir", "/workspace", name, ...command,
        ]);
        if (result.exitCode !== 0 && isContainerMissing(result.stderr || result.stdout)) {
            this.markLost(sandboxId, redact(result.stderr || result.stdout));
        }
        return result;
    }

    async terminate(sandboxId: string): Promise<void> {
        const current = this.store.get(sandboxId);
        const container = this.containerBySandboxId.get(sandboxId);
        this.containerBySandboxId.delete(sandboxId);
        this.secretValues.delete(sandboxId);
        if (container !== undefined) {
            await this.commands.run([this.docker, "rm", "--force", container]);
        }
        if (current !== null && current.status === "ACTIVE") {
            this.store.update({ ...current, status: "TERMINATED", updatedAt: new Date().toISOString() }, "ACTIVE");
        }
        const replenish = this.replenishments.get(sandboxId);
        this.replenishments.delete(sandboxId);
        if (replenish) void this.warmPool!.warm(replenish.key, replenish.args)
            .catch(error => console.error('Sandbox warm replenishment failed', error));
    }

    async close(): Promise<void> { await this.warmPool?.close(); }

    async cleanupStale(record: SandboxRecord): Promise<void> {
        const name = `agent-harness-${record.id}`;
        const result = await this.commands.run([this.docker, "rm", "--force", name]);
        if (result.exitCode !== 0 && !isContainerMissing(result.stderr || result.stdout)) {
            throw new Error(`遗留容器清理失败：${redact(result.stderr || result.stdout)}`);
        }
        this.containerBySandboxId.delete(record.id);
        this.secretValues.delete(record.id);
    }

    subscribe(handler: (event: SandboxLifecycleEvent) => void): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    private withSecretValues(args: readonly string[], environment: Readonly<Record<string, string>>): string[] {
        return args.map((argument) => argument.replace(
            /__HARNESS_SECRET_([A-Z][A-Z0-9_]*)__/, (_, name: string) => environment[name] ?? "",
        ));
    }

    private emit(record: SandboxRecord, status: "LOST" | "FAILED", reason: string): void {
        for (const handler of this.handlers) handler({
            sandboxId: record.id, runId: record.runId, instanceId: record.instanceId,
            status, reason, timestamp: new Date().toISOString(),
        });
    }

    private markLost(sandboxId: string, reason: string): void {
        const current = this.store.get(sandboxId);
        if (current === null || current.status !== "ACTIVE") return;
        this.containerBySandboxId.delete(sandboxId);
        this.secretValues.delete(sandboxId);
        const lost: SandboxRecord = {
            ...current,
            status: "LOST",
            updatedAt: new Date().toISOString(),
            failureReason: reason || "docker exec reported missing container",
        };
        this.store.update(lost, "ACTIVE");
        this.emit(lost, "LOST", lost.failureReason!);
    }
}

export class BunContainerCommandRuntime implements ContainerCommandRuntime {
    async run(args: readonly string[]) {
        const process = Bun.spawn([...args], { stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([
            process.exited,
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
    }
}

function redact(value: string): string {
    return value.replace(/(?:[A-Z][A-Z0-9_]{2,})=\S+/g, "$1=[REDACTED]").slice(0, 1_000);
}

function isContainerMissing(value: string): boolean {
    return /no such container|container .* is not running|cannot exec in a stopped state/i.test(value);
}
