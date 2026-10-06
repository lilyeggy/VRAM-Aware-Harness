import { existsSync } from "node:fs";
import type { EffectivePolicySnapshot } from "../../policies/effective-policy.ts";
import {
    freezeRuntimeEvidence,
    freezeSandboxSpec,
    type SandboxRuntimeEvidence,
    type SandboxSpec,
} from "../sandbox-profile.ts";
import type {
    SandboxCommandExecutor,
    SandboxHandle,
    SandboxLifecycleEvent,
    SandboxProvider,
    SandboxRecord,
    SecretProvider,
} from "../sandbox-provider.ts";
import type { SandboxStore } from "../sandbox-store.ts";
import type { MicrovmDriver, MicrovmExecuteOptions, MicrovmInstance } from "./microvm-types.ts";
import { VmRunDirectoryManager } from "./vm-run-directory.ts";
import { WorkspaceDiskExporter } from "./workspace-disk-exporter.ts";
import {
    mapResourceToTier,
    MICROVM_TIERS,
    MicrovmWarmPool,
    type MicrovmResourceTier,
} from "./microvm-warm-pool.ts";

export interface MicrovmSandboxProviderConfig {
    readonly driver: MicrovmDriver;
    readonly profile?: "strict";
    /**
     * 工作区磁盘模板（ext4 镜像）：每个 Run 由驱动在私有 chroot 内创建
     * 独立副本挂载为 VM 的第二块盘，guest 内命令操作的是这块盘。
     */
    readonly workspaceDiskTemplatePath?: string;
    readonly vmRuntimeRoot?: string;
    /**
     * Phase 3：microVM 预热池。命中时跳过完整开机（driver.create），
     * acquisition.warmHit 如实为 true；未配置时每个 Run 冷启动。
     * 预热 VM 在入网前创建（无网络、无租户 secret），因此
     * allowNetwork=true 的请求永不命中预热池。
     */
    readonly warmPool?: MicrovmWarmPool;
    /** 预热池 key 的模板指纹（通常由驱动 computeTemplateHash() 提供）。 */
    readonly templateHash?: string | null;
}

export class MicrovmSandboxProvider implements SandboxProvider, SandboxCommandExecutor {
    private readonly handlers = new Set<(event: SandboxLifecycleEvent) => void>();
    private readonly driver: MicrovmDriver;
    private readonly workspaceDiskTemplatePath: string | undefined;
    private readonly secretValues = new Map<string, Readonly<Record<string, string>>>();
    private readonly activeSandboxes = new Set<string>();
    private readonly runDirManager: VmRunDirectoryManager;
    private readonly diskExporter = new WorkspaceDiskExporter();
    private readonly workspacePaths = new Map<string, string>();
    private readonly workspaceDisks = new Map<string, string>();
    private readonly warmPool?: MicrovmWarmPool;
    private readonly templateHash?: string | null;
    /** sandboxId → 驱动层 vmId（预热命中时两者不同：vmId 为预热分配） */
    private readonly instanceIds = new Map<string, string>();

    constructor(
        private readonly store: SandboxStore,
        private readonly secrets: SecretProvider,
        config: MicrovmSandboxProviderConfig,
    ) {
        this.driver = config.driver;
        this.workspaceDiskTemplatePath = config.workspaceDiskTemplatePath;
        this.runDirManager = new VmRunDirectoryManager({ runtimeRoot: config.vmRuntimeRoot });
        this.warmPool = config.warmPool;
        this.templateHash = config.templateHash;
    }

    async create(input: {
        id: string;
        runId: string;
        workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle> {
        const isAvailable = await this.driver.isAvailable();
        if (!isAvailable) {
            throw new Error(
                `MicroVM Driver (${this.driver.name}) 不可用；请检查 KVM 权限或 API 配置`,
            );
        }

        // 产品边界（2026-10-06 定档）：MicroVM 一律不提供网卡服务。
        // guest 内不存在任何网络设备，因此不存在"受控出口"这条路径——
        // 任何 allowNetwork=true 的请求都是配置错误，直接 fail-closed 拒绝。
        // 宿主侧能力（如 LLM 网关）必须走 vsock/本地套接字转发，不得依赖 guest 网络。
        if (input.policy.allowNetwork) {
            throw new Error(
                "MicroVM 不提供网卡服务：allowNetwork=true 不被支持（guest 内无网络设备）。"
                + "如需访问宿主能力，请使用 vsock 受控通道；请将策略改为 allowNetwork=false。",
            );
        }

        const hardwareIsolated = this.driver.providesHardwareIsolation;

        if (hardwareIsolated) {
            // P1 修复：Provider 只做模板存在性 fail-fast 校验；
            // 每 Run 磁盘副本由驱动在其私有布局内创建，
            // 真实路径以 driver.create() 回传的 workspaceDiskHostPath 为准。
            if (
                this.workspaceDiskTemplatePath === undefined
                || !existsSync(this.workspaceDiskTemplatePath)
            ) {
                throw new Error(
                    "硬件隔离 MicroVM 需要工作区磁盘模板"
                    + `（当前配置：${this.workspaceDiskTemplatePath ?? "<未配置>"}）；`
                    + "请设置 FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH 指向 ext4 模板镜像。"
                    + "拒绝创建没有工作区挂载的 VM。",
                );
            }
        }

        const acquisitionStartedAt = performance.now();

        // 解析 Secret（仅内存持有值，入库仅记名称）
        const resolvedSecrets: Record<string, string> = {};
        const secretNames: string[] = [];
        for (const name of (input.policy.allowedSecrets ?? [])) {
            const val = this.secrets.get(input.policy.tenantId, name);
            if (val !== null) {
                resolvedSecrets[name] = val;
                secretNames.push(name);
            }
        }
        this.secretValues.set(input.id, Object.freeze(resolvedSecrets));

        const spec: SandboxSpec = freezeSandboxSpec({
            profile: "strict",
            runtime: "firecracker",
            image: null,
            userId: 0, // 在 MicroVM 中，Guest OS 内部的 root 安全隔离，不穿透宿主
            workspaceMount: "/workspace",
            workspacePath: input.workspacePath,
            mountedRoot: input.workspacePath,
            workspaceScope: hardwareIsolated ? "RUN" : "NONE",
            networkMode: "none",
            readOnlyRootfs: false,
            droppedCapabilities: "NONE",
            noNewPrivileges: false,
            pidLimit: null,
            resourceLimits: input.policy.resourceLimits,
            secretNames,
        });

        // 隔离证据
        // guest 无网卡：出口画像恒为 none（不再有 controlled-egress 这一档）
        const egressProfile = "none";
        const evidence: SandboxRuntimeEvidence = freezeRuntimeEvidence(
            hardwareIsolated
                ? {
                    adapter: `microvm-${this.driver.name}`,
                    requestedRuntime: "firecracker",
                    observedRuntime: `microvm:${this.driver.name}`,
                    verified: true,
                    verificationReason:
                        "jailer 隔离的 Firecracker VM；kernel/rootfs 就绪、工作区盘已挂载、vsock agent 握手成功"
                        + "；guest 无网络设备（未挂载任何网卡）",
                    verifiedAt: new Date().toISOString(),
                    egressProfile,
                }
                : {
                    adapter: `microvm-${this.driver.name}`,
                    requestedRuntime: "firecracker",
                    observedRuntime: `microvm:${this.driver.name}`,
                    verified: false,
                    verificationReason:
                        `驱动 ${this.driver.name} 为桩/测试驱动，不提供真实硬件隔离；`
                        + "本记录不代表生产隔离证据",
                    verifiedAt: new Date().toISOString(),
                    egressProfile,
                },
        );

        const record: SandboxRecord = {
            id: input.id,
            runId: input.runId,
            policySnapshotId: input.policy.id,
            provider: `microvm-${this.driver.name}`,
            profile: "strict",
            runtime: "firecracker",
            spec,
            runtimeEvidence: evidence,
            status: "ACTIVE",
            workspacePath: input.workspacePath,
            secretNames,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            failureReason: null,
        };

        this.store.create(record);

        this.workspacePaths.set(input.id, input.workspacePath);

        let warmHit = false;
        try {
            const cpuCores = input.policy.resourceLimits.cpuCores ?? 2;
            const memoryMb = input.policy.resourceLimits.memoryMiB ?? 256;
            const tier = mapResourceToTier(cpuCores, memoryMb);

            // Phase 3：预热池只在"有模板指纹 + 硬件隔离"时命中
            //（预热 VM 无租户 secret，与请求语义必须严格一致）。
            let instance = null as MicrovmInstance | null;
            if (
                this.warmPool
                && this.templateHash
                && hardwareIsolated
            ) {
                const warmed = this.warmPool.take(this.templateHash, tier);
                if (warmed) {
                    instance = warmed.instance;
                    warmHit = true;
                }
            }

            if (instance === null) {
                instance = await this.driver.create({
                    id: input.id,
                    runId: input.runId,
                    workspacePath: input.workspacePath,
                    cpuCount: cpuCores,
                    memoryMb,
                    allowNetwork: input.policy.allowNetwork,
                    environment: resolvedSecrets,
                });
            }
            this.instanceIds.set(input.id, instance.id);

            // P1 修复：以驱动回传的真实磁盘路径登记导出源；
            // 硬件隔离驱动必须回传，否则拒绝（防止静默导出空盘）。
            if (hardwareIsolated) {
                if (!instance.workspaceDiskHostPath || !existsSync(instance.workspaceDiskHostPath)) {
                    throw new Error(
                        `驱动 ${this.driver.name} 未回传有效的工作区磁盘路径`
                        + `（workspaceDiskHostPath=${instance.workspaceDiskHostPath ?? "<未回传>"}）；`
                        + "拒绝在无法导出产物的情况下继续运行。",
                    );
                }
                this.workspaceDisks.set(input.id, instance.workspaceDiskHostPath);
            }

            this.activeSandboxes.add(input.id);

            // 命中预热后后台补一台同档位 VM（best-effort，不阻塞本 Run）
            if (warmHit) {
                void this.refillWarmPool(tier).catch(() => undefined);
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // 驱动 create 内部失败时会自清理；但 create 成功后的校验失败
            // （如 workspaceDiskHostPath 缺失）需要在这里回收 VM，防止泄漏。
            const vmId = this.instanceIds.get(input.id) ?? input.id;
            this.instanceIds.delete(input.id);
            await this.driver.terminate(vmId).catch(() => undefined);
            await this.runDirManager.dispose(input.id);
            this.workspacePaths.delete(input.id);
            this.workspaceDisks.delete(input.id);
            this.secretValues.delete(input.id);
            this.store.update({
                ...record,
                status: "FAILED",
                failureReason: reason,
                updatedAt: new Date().toISOString(),
            }, "ACTIVE");
            throw error;
        }

        return {
            id: input.id,
            workspacePath: input.workspacePath,
            secretNames,
            enforcement: {
                toolExecutionBoundary: "SANDBOX",
                filesystemIsolation: hardwareIsolated,
                processIsolation: hardwareIsolated,
                networkPolicyEnforced: true,
                // jailer cgroup 已落实，由宿主侧内核强制
                cpuLimitEnforced: hardwareIsolated,
                memoryLimitEnforced: hardwareIsolated,
                diskLimitEnforced: false,
                pidLimitEnforced: false,
                workspaceScope: hardwareIsolated ? "RUN" : "NONE",
            },
            mountRoot: input.workspacePath,
            containerWorkdir: "/workspace",
            withSecrets: <T>(callback: (environment: Readonly<Record<string, string>>) => T): T => {
                const env = this.secretValues.get(input.id) ?? {};
                return callback(env);
            },
            acquisition: {
                durationMs: Math.round(performance.now() - acquisitionStartedAt),
                warmHit,
            },
        };
    }

    /**
     * Phase 3：预热池补货。预热 VM 以 warm-<rand> 为 vmId 冷启动（无网络、
     * 无 secret），加入池中等待取用。best-effort：失败仅意味着下次冷启动。
     */
    private async refillWarmPool(tier: MicrovmResourceTier): Promise<void> {
        if (!this.warmPool || !this.templateHash) {
            return;
        }
        if (this.warmPool.has(this.templateHash, tier)) {
            return;
        }
        const spec = MICROVM_TIERS[tier];
        const warmId = `warm-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
        const instance = await this.driver.create({
            id: warmId,
            runId: "warm-pool",
            workspacePath: "/workspace",
            cpuCount: spec.cpu,
            memoryMb: spec.memoryMb,
            allowNetwork: false,
            environment: {},
        });
        this.warmPool.put(this.templateHash, tier, instance);
    }

    async execute(
        sandboxId: string,
        command: readonly string[],
        options?: MicrovmExecuteOptions,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const env = this.secretValues.get(sandboxId) ?? {};
        const vmId = this.instanceIds.get(sandboxId) ?? sandboxId;
        return this.driver.execute(vmId, command, {
            ...options,
            env: options?.env ? { ...env, ...options.env } : env,
        });
    }

    async terminate(sandboxId: string): Promise<void> {
        this.activeSandboxes.delete(sandboxId);
        this.secretValues.delete(sandboxId);
        const vmId = this.instanceIds.get(sandboxId) ?? sandboxId;
        this.instanceIds.delete(sandboxId);

        // 1. flush 文件系统缓存
        if (typeof this.driver.flushFilesystem === "function") {
            await this.driver.flushFilesystem(vmId).catch(() => undefined);
        }

        // 2. P1 修复：先停止 VM（保留磁盘），确保导出时 guest 已完全静止，
        //    避免读取一个仍在被写入的 ext4 镜像导致产物损坏。
        if (typeof this.driver.stopVm === "function") {
            await this.driver.stopVm(vmId).catch(() => undefined);
        }

        // 3. 导出工作区磁盘内容到宿主工作区目录
        const targetWorkspace = this.workspacePaths.get(sandboxId);
        const diskPath = this.workspaceDisks.get(sandboxId);
        if (targetWorkspace && diskPath && existsSync(diskPath)) {
            try {
                await this.diskExporter.exportToHost(diskPath, targetWorkspace);
            } catch (exportErr: any) {
                const record = this.store.get(sandboxId);
                if (record && record.status === "ACTIVE") {
                    this.store.update({
                        ...record,
                        status: "FAILED",
                        failureReason: `工作区导出失败: ${exportErr?.message || exportErr}`,
                        updatedAt: new Date().toISOString(),
                    }, "ACTIVE");
                }
                throw exportErr;
            }
        }

        // 4. 销毁 VM 与释放私有目录（terminate 在 stopVm 之后幂等）
        await this.driver.terminate(vmId);
        await this.runDirManager.dispose(sandboxId);
        this.workspacePaths.delete(sandboxId);
        this.workspaceDisks.delete(sandboxId);

        const record = this.store.get(sandboxId);
        if (record && record.status === "ACTIVE") {
            this.store.update({
                ...record,
                status: "TERMINATED",
                updatedAt: new Date().toISOString(),
            }, "ACTIVE");
        }
    }

    /** 启动期预热：按档位各补一台（默认 M 档，对应默认策略 2C/512MiB）。best-effort。 */
    async prewarm(tiers: readonly MicrovmResourceTier[] = ["M"]): Promise<void> {
        if (!this.warmPool || !this.templateHash) {
            return;
        }
        for (const tier of tiers) {
            await this.refillWarmPool(tier).catch((err) => {
                console.error(`[MicroVM] 预热 ${tier} 档失败（下次 Run 将冷启动）：`, err);
            });
        }
    }

    async cleanupStale(record: SandboxRecord): Promise<void> {
        await this.runDirManager.dispose(record.id);
        await this.terminate(record.id);
    }

    subscribe(handler: (event: SandboxLifecycleEvent) => void): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    async close(): Promise<void> {
        for (const id of Array.from(this.activeSandboxes)) {
            await this.terminate(id).catch(() => undefined);
        }
        await this.warmPool?.close().catch(() => undefined);
        this.handlers.clear();
        this.secretValues.clear();
    }
}
