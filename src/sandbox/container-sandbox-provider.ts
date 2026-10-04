import { relative, sep } from "node:path";
import type { EffectivePolicySnapshot } from "../policies/effective-policy.ts";
import { redact } from "./redact.ts";
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
import { OciSandboxSpecCompiler, stripResourceLimitArgs } from "./oci-sandbox-spec.ts";
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
    /** 预热容器存活时长；默认 5 分钟。过短会让补充出来的容器白白过期。 */
    readonly warmPoolTtlMs?: number;
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
     * `tenant` 让容器挂租户工作区根：同租户所有 Run 共用一个挂载点，
     * 因此预热池可以跨工作区复用（命中率大幅提升）。
     * 代价是同租户跨 Run 的文件隔离由物理视野降为策略约束。
     * 默认 `run`：容器只挂本 Run 的工作区。
     */
    readonly workspaceScope?: "run" | "tenant";
    /** `tenant` 视野下租户工作区的根目录（Harness 的 workspaceRoot）。 */
    readonly tenantWorkspaceRoot?: string;
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
    private readonly warmPool: ContainerWarmPool | undefined;
    private readonly replenishments = new Map<string, { key: string; args: readonly string[] }>();

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
            ...(config.tenantWorkspaceRoot === undefined
                ? {}
                : { tenantWorkspaceRoot: config.tenantWorkspaceRoot }),
        });
        if (config.warmPoolSize) {
            this.warmPool = new ContainerWarmPool(
                commands,
                this.docker,
                config.warmPoolSize,
                config.warmPoolTtlMs ?? 300_000,
                config.warmPoolOwner,
            );
            // N29：清场必须在池**首次被使用之前**确定性地发生，不能只靠 take()/warm()
            // 惰性触发——否则一个配了池但长期没有可复用 Run 的实例，会一直不清场。
            // 预热容器不含密钥、也不属于任何 Run，清不掉只影响资源占用（内存/PID 额度），
            // 不影响正确性，因此这里失败只记录、不阻断 Provider 构造。
            // initialize() 自身幂等：后续 take()/warm() 复用同一个 promise，不会重复清场。
            void this.warmPool.initialize().catch((error) => {
                console.error('Warm pool startup reconciliation failed', error);
            });
        }
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
            const value = this.secrets.get(input.policy.tenantId, name);
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
        // 池化规格：剥离 CPU/内存限额。这两项随模板与 Run 经常变，放进匹配键
        // 会让"同工作区、仅限额不同"的 Run 也复用不上；它们改由租用时
        // docker update 落实（见 applyResourceLimits）。
        const poolArgs = stripResourceLimitArgs(args);
        const keyArgs = [...poolArgs];
        keyArgs[keyArgs.indexOf('--name') + 1] = '<resource>';
        const poolKey = JSON.stringify([input.policy.tenantId, keyArgs]);


        // 从这里开始分叉，就是判断是否命中预热池
        const eligible = this.warmPool !== undefined && Object.keys(environment).length === 0;
        const acquisitionStartedAt = performance.now();
        let warmed = false;
        if (eligible) {
            warmed = await this.warmPool!.take(poolKey, `agent-harness-${input.id}`);
            if (warmed && !await this.applyResourceLimits(input.id, input.policy)) {
                // 限额落实不了，这个容器就不能代表本次策略，删掉重走真实创建。
                await this.commands.run([this.docker, 'rm', '--force', `agent-harness-${input.id}`]);
                warmed = false;
            }
            if (warmed) {
                // 命中即补货：让池子始终保有存货。等 Run 结束才补的话，
                // 补充速度受限于结束速度，连续使用场景只能做到隔次命中。
                void this.warmPool!.warm(poolKey, poolArgs)
                    .catch(error => console.error('Sandbox warm replenishment failed', error));
            }
        }
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
        if (eligible) this.replenishments.set(input.id, { key: poolKey, args: poolArgs });
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
            containerWorkdir: compiled.spec.workspaceScope === "TENANT"
                ? containerWorkdirFor(compiled.spec.mountedRoot, input.workspacePath)
                : "/workspace",
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
                workspaceScope: compiled.spec.workspaceScope,
            }),
            withSecrets: <T>(callback: (values: Readonly<Record<string, string>>) => T) =>
                callback(this.secretValues.get(input.id) ?? Object.freeze({})),
        });
    }

    /**
     * 预热容器按"池化规格"裸建（不含 CPU/内存限额），所以租用后必须把本次
     * 策略的限额补上，否则等于悄悄放大了资源上限。
     * 返回 false 表示限额落实失败，调用方必须放弃这个容器而不是将就用它。
     *
     * 真机验证（A6000 / docker 28.1.1 / runsc release-20260817.0）：
     *  - `docker update --cpus N` 可直接生效，无需附加参数；
     *  - `docker update --memory N` **必须同时下发 `--memory-swap N`**，否则
     *    daemon 直接拒绝："Memory limit should be smaller than already set
     *    memoryswap limit"——裸建容器的 MemorySwap 默认为 0，而 docker 要求
     *    Memory < MemorySwap。写入同值等价于禁用 swap，符合硬限制语义。
     *  - 限额确实落地为 cgroup 约束（stats 分母随之变化，超限进程被终结）；
     *    但注意 gVisor 下"内存触顶"的爆炸半径是**整个沙箱**而非单个进程：
     *    沙箱会被终结，下一次 `docker exec` 报 No such container 并收敛为 LOST。
     */
    private async applyResourceLimits(
        sandboxId: string,
        policy: EffectivePolicySnapshot,
    ): Promise<boolean> {
        const args: string[] = [];
        if (policy.resourceLimits.cpuCores !== null) {
            args.push('--cpus', String(policy.resourceLimits.cpuCores));
        }
        if (policy.resourceLimits.memoryMiB !== null) {
            args.push('--memory', `${policy.resourceLimits.memoryMiB}m`);
            args.push('--memory-swap', `${policy.resourceLimits.memoryMiB}m`);
        }
        if (args.length === 0) return true;
        const result = await this.commands.run([
            this.docker, 'update', ...args, `agent-harness-${sandboxId}`,
        ]);
        if (result.exitCode !== 0) {
            console.error('Warm container resource update failed', redact(result.stderr || result.stdout));
            return false;
        }
        return true;
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
        // TENANT 视野下容器 /workspace 是整个租户根，工具的 cwd 必须显式落到
        // 本 Run 的工作区子目录，否则 bash 的相对路径会落在租户根上。
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

/** TENANT 视野下，本 Run 的工作区在容器内的绝对路径。 */
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
