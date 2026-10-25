import { relative, sep } from "node:path";
import type { EffectivePolicySnapshot } from "../policies/effective-policy.ts";
import { redact } from "./redact.ts";
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
    /**
     * `user` 让容器挂用户工作区根：同用户所有 Run 共用一个挂载点，
     * 代价是同用户跨 Run 的文件隔离由物理视野降为策略约束。
     * 默认 `run`：容器只挂本 Run 的工作区。
     */
    readonly workspaceScope?: "run" | "user";
    /** `user` 视野下用户工作区的根目录（Harness 的 workspaceRoot）。 */
    readonly userWorkspaceRoot?: string;
    /** N14：容器 PID 上限（docker --pids-limit），未配置时 128。 */
    readonly pidsLimit?: number;
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

    constructor(
        private readonly store: SandboxStore,
        private readonly secrets: SecretProvider,
        config: ContainerSandboxConfig,
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
            ...(config.pidsLimit === undefined ? {} : { pidsLimit: config.pidsLimit }),
            ...(config.workspaceScope === undefined ? {} : { workspaceScope: config.workspaceScope }),
            ...(config.userWorkspaceRoot === undefined
                ? {}
                : { userWorkspaceRoot: config.userWorkspaceRoot }),
        });
    }

    async create(input: {
        id: string; runId: string; workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle> {
        // 1. 档位再校验
        const profile = resolveSandboxProfile(input.policy.sandboxProfile, this.profile);
        if (profile !== this.profile) {
            throw new Error(`Sandbox profile 未路由到匹配 Provider：${profile}`);
        }

        // 2. 根据 secret 取出 key
        const environment: Record<string, string> = {};
        for (const name of input.policy.allowedSecrets ?? []) {
            const value = this.secrets.get(input.policy.userId, name);
            if (value === null) throw new Error(`授权 Secret 不存在：${name}`);
            environment[name] = value;
        }

        // 3. 编译 spec
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

        // 落库PROVISIONING
        const record: SandboxRecord = {
            id: input.id, runId: input.runId,
            policySnapshotId: input.policy.id, provider: "CONTAINER",
            profile: compiled.spec.profile, runtime: compiled.spec.runtime,
            spec: compiled.spec, runtimeEvidence: evidence,
            status: "PROVISIONING", workspacePath: input.workspacePath,
            secretNames: Object.freeze(Object.keys(environment)),
            createdAt: now, updatedAt: now, failureReason: null,
        };
        this.store.create(record);
        // N13：创建参数里不再有 Secret 明文（也没有占位符），明文只保留在
        // Provider 内存中，执行期经客户端环境注入。
        const args = [...this.adapter.augmentCreateArgs(compiled.createArgs)];
        const acquisitionStartedAt = performance.now();
        const result = await this.commands.run([this.docker, ...args]);
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
        this.secretValues.set(input.id, Object.freeze(environment));
        this.store.update({
            ...record,
            status: "ACTIVE",
            updatedAt: new Date().toISOString(),
            runtimeEvidence: freezeRuntimeEvidence(verifiedEvidence),
        }, "PROVISIONING");
        return Object.freeze({
            id: input.id, workspacePath: input.workspacePath, secretNames: record.secretNames,
            mountRoot: compiled.spec.mountedRoot,
            containerWorkdir: compiled.spec.workspaceScope === "USER"
                ? containerWorkdirFor(compiled.spec.mountedRoot, input.workspacePath)
                : "/workspace",
            acquisition: Object.freeze({
                durationMs: Math.round(performance.now() - acquisitionStartedAt),
                warmHit: false,
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
                workspaceScope: compiled.spec.workspaceScope,
            }),
            withSecrets: <T>(callback: (values: Readonly<Record<string, string>>) => T) =>
                callback(this.secretValues.get(input.id) ?? Object.freeze({})),
        });
    }

    async execute(
        sandboxId: string,
        command: readonly string[],
        options?: { readonly workdir?: string },
    ) {
        const name = this.containerBySandboxId.get(sandboxId);
        if (name === undefined) throw new Error(`Sandbox 不可执行：${sandboxId}`);
        // N13：只把 Secret **名字**放进 argv，明文通过 docker CLI 进程环境传递
        // （`docker exec --env NAME` 的语义是"取客户端同名环境变量的值"）。
        // 这样明文既不出现在 /proc/*/cmdline（同机任意用户可读），
        // 也不会写进容器 Config.Env（docker 组成员可用 docker inspect 读出）。
        const authorizedSecrets = this.secretValues.get(sandboxId) ?? {};
        const secretArgs = Object.keys(authorizedSecrets).flatMap((secretName) => ["--env", secretName]);
        // USER 视野下容器 /workspace 是整个用户根，工具的 cwd 必须显式落到
        // 本 Run 的工作区子目录，否则 bash 的相对路径会落在用户根上。
        const workdir = options?.workdir ?? "/workspace";
        const result = await this.commands.run([
            this.docker, "exec", "--workdir", workdir, ...secretArgs, name, ...command,
        ], authorizedSecrets);
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

    async close(): Promise<void> {}

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

    private emit(record: SandboxRecord, status: "LOST" | "FAILED", reason: string): void {
        for (const handler of this.handlers) handler({
            sandboxId: record.id, runId: record.runId,
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
    async run(args: readonly string[], environment?: Readonly<Record<string, string>>) {
        const child = Bun.spawn([...args], {
            stdout: "pipe",
            stderr: "pipe",
            // N13：Secret 明文只经子进程环境传递，不落在 argv 上。
            ...(environment === undefined
                ? {}
                : { env: { ...process.env, ...environment } }),
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
    }
}

/** USER 视野下，本 Run 的工作区在容器内的绝对路径。 */
function containerWorkdirFor(mountedRoot: string, workspacePath: string): string {
    const suffix = relative(mountedRoot, workspacePath).split(sep).join("/");
    return suffix === "" || suffix === "." ? "/workspace" : `/workspace/${suffix}`;
}

/**
 * 判定"沙箱已经不存在了"，用于把工具失败升级为沙箱失联（LOST）。
 *
 * 真机验证（A6000 / runsc release-20260817.0）补充了两类文本：
 *  - gVisor 沙箱被资源上限终结时，触发那一次 exec 直接报
 *    `waiting on PID n in sandbox "...": urpc method "containerManager.WaitPID"
 *    failed: EOF`（退出码 128）。这类文本原先不匹配，只能等下一次工具调用
 *    才发现失联；补进来后触发当次即可收敛，少一个"沙箱已死仍显示 RUNNING"的窗口。
 *  - 沙箱终结后容器会被 --rm 回收，后续 exec 报 No such container。
 */
function isContainerMissing(value: string): boolean {
    return /no such container|container .* is not running|cannot exec in a stopped state|urpc method .* failed|containerManager\.WaitPID/i.test(value);
}
