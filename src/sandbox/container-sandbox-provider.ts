import { isWithin, type EffectivePolicySnapshot } from "../policies/effective-policy.ts";
import type { SandboxStore } from "./sandbox-store.ts";
import type {
    SandboxCommandExecutor,
    SandboxHandle,
    SandboxLifecycleEvent,
    SandboxProvider,
    SandboxRecord,
    SecretProvider,
} from "./sandbox-provider.ts";

export interface ContainerCommandRuntime {
    run(args: readonly string[]): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
}

export interface ContainerSandboxConfig {
    readonly image: string;
    readonly runtime?: string;
    readonly userId?: number;
}

/**
 * One detached container per Attempt. The provider deliberately compiles every
 * isolation guarantee into an inspectable docker command, rather than relying
 * on a host-side convention.
 */
export class ContainerSandboxProvider implements SandboxProvider, SandboxCommandExecutor {
    private readonly handlers = new Set<(event: SandboxLifecycleEvent) => void>();
    private readonly containerBySandboxId = new Map<string, string>();
    private readonly secretValues = new Map<string, Readonly<Record<string, string>>>();
    private readonly docker: string;

    constructor(
        private readonly store: SandboxStore,
        private readonly secrets: SecretProvider,
        private readonly config: ContainerSandboxConfig,
        private readonly commands: ContainerCommandRuntime = new BunContainerCommandRuntime(),
    ) {
        if (config.userId !== undefined && (!Number.isInteger(config.userId) || config.userId <= 0)) {
            throw new Error("Container Sandbox userId 必须是正整数，不能使用 root");
        }
        this.docker = config.runtime ?? "docker";
    }

    async create(input: {
        id: string; runId: string; instanceId: string; workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle> {
        if (input.policy.workspaceRoots !== null && !input.policy.workspaceRoots.some(
            (root) => isWithin(input.workspacePath, root),
        )) {
            throw new Error(`Sandbox Workspace 超出策略范围：${input.workspacePath}`);
        }
        if (input.policy.resourceLimits.diskMiB !== null) {
            // Docker bind mount cannot express a trustworthy per-directory quota.
            throw new Error("Container bind mount 无法强制磁盘配额，拒绝执行");
        }
        const environment: Record<string, string> = {};
        for (const name of input.policy.allowedSecrets ?? []) {
            const value = this.secrets.get(input.policy.tenantId, name);
            if (value === null) throw new Error(`授权 Secret 不存在：${name}`);
            environment[name] = value;
        }
        const now = new Date().toISOString();
        const record: SandboxRecord = {
            id: input.id, instanceId: input.instanceId, runId: input.runId,
            policySnapshotId: input.policy.id, provider: "CONTAINER",
            status: "PROVISIONING", workspacePath: input.workspacePath,
            secretNames: Object.freeze(Object.keys(environment)),
            createdAt: now, updatedAt: now, failureReason: null,
        };
        this.store.create(record);
        const containerName = `agent-harness-${input.id}`;
        const result = await this.commands.run(this.createArgs(
            containerName, input.workspacePath, input.policy, environment,
        ));
        if (result.exitCode !== 0) {
            const failed = {
                ...record, status: "FAILED" as const, updatedAt: new Date().toISOString(),
                failureReason: redact(result.stderr || result.stdout),
            };
            this.store.update(failed, "PROVISIONING");
            this.emit(failed, "FAILED", failed.failureReason ?? "container create failed");
            throw new Error(`容器 Sandbox 创建失败：${failed.failureReason}`);
        }
        this.containerBySandboxId.set(input.id, containerName);
        this.secretValues.set(input.id, Object.freeze(environment));
        this.store.update({ ...record, status: "ACTIVE", updatedAt: new Date().toISOString() }, "PROVISIONING");
        return Object.freeze({
            id: input.id, workspacePath: input.workspacePath, secretNames: record.secretNames,
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
    }

    subscribe(handler: (event: SandboxLifecycleEvent) => void): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    private createArgs(
        name: string, workspacePath: string, policy: EffectivePolicySnapshot,
        environment: Readonly<Record<string, string>>,
    ): string[] {
        const args = [this.docker, "run", "--detach", "--rm", "--name", name,
            "--user", `${this.config.userId ?? 65532}:${this.config.userId ?? 65532}`, "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--pids-limit", "128",
            "--workdir", "/workspace", "--mount",
            `type=bind,src=${workspacePath},dst=/workspace`,
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
            "--network", policy.allowNetwork ? "bridge" : "none"];
        if (policy.resourceLimits.cpuCores !== null) {
            args.push("--cpus", String(policy.resourceLimits.cpuCores));
        }
        if (policy.resourceLimits.memoryMiB !== null) {
            args.push("--memory", `${policy.resourceLimits.memoryMiB}m`);
        }
        for (const [key, value] of Object.entries(environment)) {
            args.push("--env", `${key}=${value}`);
        }
        args.push(this.config.image, "tail", "-f", "/dev/null");
        return args;
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
