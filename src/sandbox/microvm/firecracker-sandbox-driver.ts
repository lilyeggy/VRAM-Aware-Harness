import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import type {
    MicrovmCreateOptions,
    MicrovmDriver,
    MicrovmExecuteOptions,
    MicrovmExecutionResult,
    MicrovmInstance,
} from "./microvm-types.ts";
import { FirecrackerVsockBridge } from "./firecracker-vsock-bridge.ts";
import { VmRunDirectoryManager, type VmRunDirectory } from "./vm-run-directory.ts";
import { VmUidAllocator } from "./vm-uid-allocator.ts";
import { VmCidAllocator } from "./vm-cid-allocator.ts";
import { checkJailerPrereqs } from "./jailer-prereq-check.ts";
import { VmSnapshotManager } from "./vm-snapshot-manager.ts";

export interface FirecrackerDriverConfig {
    readonly binaryPath?: string;
    readonly jailerPath?: string;
    readonly kernelPath?: string;
    readonly rootfsPath?: string;
    readonly workspaceDiskTemplatePath?: string;
    readonly kvmDevicePath?: string;
    readonly vmRuntimeRoot?: string;
    readonly vsockPort?: number;
    readonly useJailer?: boolean;
    /**
     * Phase 3：microVM 快照加速。开启后，首次完整开机并握手成功后
     * 制作"黄金快照"（pause → snapshot/create → resume）；
     * 后续同模板 VM 走 /snapshot/load 快速路径（约 10ms 级恢复）。
     */
    readonly snapshotsEnabled?: boolean;
    /** 快照池目录（默认 /var/lib/harness/snapshots）。 */
    readonly snapshotPoolDir?: string;
}

async function copyFileReflink(src: string, dst: string): Promise<void> {
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    const proc = Bun.spawn(["cp", "--reflink=auto", src, dst], {
        stdout: "ignore",
        stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        const errText = await new Response(proc.stderr).text();
        throw new Error(`Failed to copy ${src} to ${dst}: ${errText}`);
    }
}

export class FirecrackerSandboxDriver implements MicrovmDriver {
    readonly name = "firecracker" as const;
    readonly providesHardwareIsolation = true;

    private readonly binaryPath: string;
    private readonly jailerPath: string;
    private readonly kernelPath?: string;
    private readonly rootfsPath?: string;
    private readonly workspaceDiskTemplatePath?: string;
    private readonly kvmPath: string;
    private readonly vmRuntimeRoot: string;
    private readonly vsockPort: number;
    private readonly useJailer: boolean;
    private readonly snapshotsEnabled: boolean;
    private readonly snapshotManager: VmSnapshotManager;
    private readonly runDirManager: VmRunDirectoryManager;
    private readonly uidAllocator = new VmUidAllocator();
    private readonly cidAllocator = new VmCidAllocator();

    private readonly processes = new Map<string, ChildProcess>();
    private readonly vsockBridges = new Map<string, FirecrackerVsockBridge>();
    private readonly runDirectories = new Map<string, VmRunDirectory>();

    constructor(config: FirecrackerDriverConfig = {}) {
        this.binaryPath = config.binaryPath ?? process.env.FIRECRACKER_BINARY_PATH ?? "firecracker";
        this.jailerPath = config.jailerPath ?? process.env.FIRECRACKER_JAILER_PATH ?? "jailer";
        this.kernelPath = config.kernelPath ?? process.env.FIRECRACKER_KERNEL_PATH;
        this.rootfsPath = config.rootfsPath ?? process.env.FIRECRACKER_ROOTFS_PATH;
        this.workspaceDiskTemplatePath = config.workspaceDiskTemplatePath
            ?? process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH;
        this.kvmPath = config.kvmDevicePath ?? "/dev/kvm";
        this.vmRuntimeRoot = config.vmRuntimeRoot
            ?? process.env.HARNESS_VM_RUNTIME_ROOT
            ?? "/var/lib/harness/vm";
        this.vsockPort = config.vsockPort ?? 5000;
        this.useJailer = config.useJailer ?? (process.env.HARNESS_USE_JAILER !== "false");
        this.snapshotsEnabled = config.snapshotsEnabled
            ?? (process.env.HARNESS_VM_SNAPSHOTS_ENABLED === "true");
        this.snapshotManager = new VmSnapshotManager({
            ...(config.snapshotPoolDir !== undefined || process.env.HARNESS_VM_SNAPSHOT_POOL_DIR !== undefined
                ? { snapshotPoolDir: config.snapshotPoolDir ?? process.env.HARNESS_VM_SNAPSHOT_POOL_DIR }
                : {}),
        });

        this.runDirManager = new VmRunDirectoryManager({ runtimeRoot: this.vmRuntimeRoot });
    }

    getKernelPath(): string | undefined {
        return this.kernelPath;
    }

    getRootfsPath(): string | undefined {
        return this.rootfsPath;
    }

    getWorkspaceDiskTemplatePath(): string | undefined {
        return this.workspaceDiskTemplatePath;
    }

    /** 预热池/快照共用的模板指纹；镜像未配置时返回 null（调用方据此禁用加速）。 */
    computeTemplateHash(): string | null {
        if (!this.kernelPath || !this.rootfsPath) {
            return null;
        }
        return this.snapshotManager.computeTemplateHash(this.kernelPath, this.rootfsPath);
    }

    async isAvailable(): Promise<boolean> {
        if (this.useJailer) {
            const prereqs = await checkJailerPrereqs({
                jailerBinaryPath: this.jailerPath,
                firecrackerBinaryPath: this.binaryPath,
                kvmDevicePath: this.kvmPath,
            });
            return prereqs.ok;
        }
        try {
            accessSync(this.kvmPath, constants.R_OK | constants.W_OK);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 设置 microVM 运行状态（暂停/恢复）。
     * Firecracker v1.7+ 已把该动作从 `PUT /actions {"action_type":"InstancePause"}`
     * 迁移为 `PATCH /vm {"state":"Paused"|"Resumed"}`；旧形状在当前版本会返回
     * 400 unknown variant `InstancePause`（真机验证发现）。
     */
    private async setVmState(socketPath: string, state: "Paused" | "Resumed"): Promise<void> {
        await this.putSocket(socketPath, "/vm", { state }, "PATCH");
    }

    private async putSocket(
        socketPath: string,
        path: string,
        payload: unknown,
        method: "PUT" | "PATCH" = "PUT",
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const data = JSON.stringify(payload);
            const req = http.request({
                socketPath,
                path,
                method,
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                },
            }, (res) => {
                let body = "";
                res.on("data", (chunk) => { body += chunk; });
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        reject(new Error(`Firecracker API error [${path}]: ${res.statusCode} ${body}`));
                    }
                });
            });
            req.on("error", reject);
            req.write(data);
            req.end();
        });
    }

    async create(options: MicrovmCreateOptions): Promise<MicrovmInstance> {
        // 0. 产品边界门禁（先于一切环境检查）：
        // MicroVM 不提供网卡服务——绝不挂载任何 network-interfaces，
        // guest 内只存在 vsock 通道与两块磁盘。策略违规优先于环境问题报错。
        if (options.allowNetwork) {
            throw new Error(
                "Firecracker 驱动不支持联网 VM：本部署不提供网卡服务（allowNetwork 必须为 false）。",
            );
        }

        // 1. 前置校验：KVM 可访问性
        try {
            accessSync(this.kvmPath, constants.R_OK | constants.W_OK);
        } catch {
            throw new Error(`KVM 设备不可访问：${this.kvmPath}；请检查是否已执行 sudo usermod -aG kvm`);
        }

        // 镜像校验
        if (
            !this.kernelPath
            || !existsSync(this.kernelPath)
            || !this.rootfsPath
            || !existsSync(this.rootfsPath)
        ) {
            throw new Error(
                "Firecracker 驱动缺少可用的内核或 rootfs 镜像"
                + `（kernel=${this.kernelPath ?? "<未配置>"}，rootfs=${this.rootfsPath ?? "<未配置>"}）；`
                + "请设置 FIRECRACKER_KERNEL_PATH 与 FIRECRACKER_ROOTFS_PATH。"
                + "拒绝在无 Guest OS 的情况下伪造 VM 实例。",
            );
        }

        if (this.useJailer) {
            const prereqs = await checkJailerPrereqs({
                jailerBinaryPath: this.jailerPath,
                firecrackerBinaryPath: this.binaryPath,
                kvmDevicePath: this.kvmPath,
            });
            if (!prereqs.ok) {
                throw new Error(`Jailer 前置检查未通过：${prereqs.failures.join("; ")}`);
            }
        }

        // 2. 分配 0700 私有运行目录
        const dir = this.runDirManager.allocate(options.id);
        this.runDirectories.set(options.id, dir);

        const guestCid = this.cidAllocator.allocate(options.id);

        let proc: ChildProcess | undefined;
        try {
            let apiSocketOnHost: string;
            let vsockUdsOnHost: string;
            let kernelPathForApi: string;
            let rootfsPathForApi: string;
            let workspacePathForApi: string;

            const workspaceTemplate = options.workspaceDiskTemplatePath
                ?? this.workspaceDiskTemplatePath;
            if (!workspaceTemplate || !existsSync(workspaceTemplate)) {
                throw new Error(
                    `工作区磁盘模板不存在：${workspaceTemplate ?? "<未配置>"}；拒绝创建没有工作区挂载的 VM。`,
                );
            }


            // 本 Run 工作区磁盘在宿主上的真实路径（jailer 模式位于 chroot 内），
            // 创建成功后回传给调用方用于终止时导出。
            let workspaceDiskHostPath: string;
            // jailer chroot 根（快照文件必须复制进 chroot 才能被降权后的
            // Firecracker 进程访问）；非 jailer 模式为 undefined。
            let chrootRootForVm: string | undefined;

            if (this.useJailer) {
                // 3. jailer 目录架构
                //
                // 关键：jail 根由 jailer 按 **exec-file 的 basename** 命名，
                // 即 `<base>/<basename(binaryPath)>/<id>/root`，而不是 `<base>/firecracker/<id>/root`。
                // 之前硬编码 "firecracker" 会在二进制名为 fc117/jailer117 时
                // 全部落空（真机实测：实际生成的是 `fc117/` 目录）。
                const jailerBase = resolve(dir.root, "jailer");
                const jailName = basename(this.binaryPath);
                const jailDir = resolve(jailerBase, jailName, options.id);
                const chrootRoot = resolve(jailDir, "root");
                chrootRootForVm = chrootRoot;
                mkdirSync(resolve(chrootRoot, "run"), { recursive: true, mode: 0o700 });

                // 异步复制到 chroot 内部
                await copyFileReflink(this.kernelPath, resolve(chrootRoot, "kernel.bin"));
                await copyFileReflink(this.rootfsPath, resolve(chrootRoot, "rootfs.ext4"));
                await copyFileReflink(workspaceTemplate, resolve(chrootRoot, "workspace.ext4"));

                // 4. 分配 UID/GID 并 chown
                const { uid, gid } = this.uidAllocator.allocate(options.id);
                const chownProc = Bun.spawn(["chown", "-R", `${uid}:${gid}`, chrootRoot]);
                await chownProc.exited;

                apiSocketOnHost = resolve(chrootRoot, "firecracker.socket");
                vsockUdsOnHost = resolve(chrootRoot, "run/vsock.sock");
                workspaceDiskHostPath = resolve(chrootRoot, "workspace.ext4");

                kernelPathForApi = "/kernel.bin";
                rootfsPathForApi = "/rootfs.ext4";
                workspacePathForApi = "/workspace.ext4";

                // 5. 启动 jailer
                //
                // 注意：jailer v1.17.0 **没有** `--node` 选项（NUMA 绑定已被移除），
                // 传入会直接报 ArgumentParsing 并拒绝启动（真机实测）。
                // 另外 API socket 必须放在 chroot 根而非 /run：jailer 会把 /run
                // 重挂为独立 tmpfs，放在其中的 socket 宿主完全无法访问。
                const cpuCores = options.cpuCount ?? 2;
                const memoryMb = options.memoryMb ?? 512;
                const cgroupArgs = [
                    "--cgroup", `cpu.max=${cpuCores * 100000} 100000`,
                    "--cgroup", `memory.max=${memoryMb * 1024 * 1024}`,
                ];

                proc = spawn(this.jailerPath, [
                    "--id", options.id,
                    "--exec-file", this.binaryPath,
                    "--uid", String(uid),
                    "--gid", String(gid),
                    "--chroot-base-dir", jailerBase,
                    "--cgroup-version", "2",
                    ...cgroupArgs,
                    "--",
                    "--api-sock", "/firecracker.socket",
                ], {
                    stdio: ["ignore", "pipe", "pipe"],
                    detached: false,
                });
            } else {
                // 非 jailer 运行模式 (私有目录直接运行)
                await copyFileReflink(this.rootfsPath, dir.rootfsPath());
                await copyFileReflink(workspaceTemplate, dir.workspaceDiskPath());

                apiSocketOnHost = dir.socketPath();
                vsockUdsOnHost = dir.vsockUdsPath();
                workspaceDiskHostPath = dir.workspaceDiskPath();

                kernelPathForApi = this.kernelPath;
                rootfsPathForApi = dir.rootfsPath();
                workspacePathForApi = dir.workspaceDiskPath();

                proc = spawn(this.binaryPath, ["--api-sock", apiSocketOnHost], {
                    stdio: ["ignore", "pipe", "pipe"],
                    detached: false,
                });
            }

            this.processes.set(options.id, proc);
            proc.on("error", (err) => {
                console.error(`[Firecracker] Process error for sandbox ${options.id}:`, err);
            });

            // 6. 等待 API Socket 出现
            const maxWaitMs = 1500;
            const start = Date.now();
            while (!existsSync(apiSocketOnHost) && Date.now() - start < maxWaitMs) {
                await new Promise((r) => setTimeout(r, 20));
            }
            if (!existsSync(apiSocketOnHost)) {
                throw new Error(`Firecracker API Socket 未能在 ${maxWaitMs}ms 内就绪：${apiSocketOnHost}`);
            }

            // 7. Firecracker API 配置
            // Phase 3 快照说明：restore 与快照制作之间，块设备 backing 文件内容
            // 必须一致（rootfs/工作区盘均为同一模板的逐份复制，内容相同，
            // 满足 Firecracker 对非 diff 快照的这一约束）。
            const templateHash = this.snapshotsEnabled
                ? this.snapshotManager.computeTemplateHash(this.kernelPath, this.rootfsPath)
                : null;
            const canRestore = templateHash !== null && this.snapshotManager.hasSnapshot(templateHash);

            if (!canRestore) {
                await this.putSocket(apiSocketOnHost, "/boot-source", {
                    kernel_image_path: kernelPathForApi,
                    boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/init",
                });
            }

            await this.putSocket(apiSocketOnHost, "/drives/rootfs", {
                drive_id: "rootfs",
                path_on_host: rootfsPathForApi,
                is_root_device: true,
                is_read_only: false,
            });

            await this.putSocket(apiSocketOnHost, "/drives/workspace", {
                drive_id: "workspace",
                path_on_host: workspacePathForApi,
                is_root_device: false,
                is_read_only: false,
            });

            await this.putSocket(apiSocketOnHost, "/vsock", {
                guest_cid: guestCid,
                uds_path: this.useJailer ? "/run/vsock.sock" : vsockUdsOnHost,
            });

            if (canRestore && templateHash !== null) {
                // 快速路径：加载黄金快照并直接恢复（跳过 boot-source /
                // machine-config / InstanceStart——配置来自快照本身）。
                const poolPaths = this.snapshotManager.getSnapshotPaths(templateHash);
                let snapForApi = poolPaths.snapshotPath;
                let memForApi = poolPaths.memFilePath;
                if (chrootRootForVm !== undefined) {
                    // jailer 降权后只能访问 chroot 内部：复制快照进去
                    const snapInChroot = resolve(chrootRootForVm, "run/restore.snap");
                    const memInChroot = resolve(chrootRootForVm, "run/restore.mem");
                    await copyFileReflink(poolPaths.snapshotPath, snapInChroot);
                    await copyFileReflink(poolPaths.memFilePath, memInChroot);
                    snapForApi = "/run/restore.snap";
                    memForApi = "/run/restore.mem";
                }
                await this.putSocket(apiSocketOnHost, "/snapshot/load", {
                    snapshot_path: snapForApi,
                    mem_file_path: memForApi,
                    enable_diff_snapshots: false,
                    track_dirty_pages: false,
                    // 快照里固化的是黄金 VM 的 vsock UDS 路径，必须覆盖为本 Run 的
                    // 私有 socket，否则 vsock 桥会连到上一个 VM 留下的地址。
                    vsock_override: {
                        UDS_PATH: this.useJailer ? "/run/vsock.sock" : vsockUdsOnHost,
                    },
                    resume_vm: true,
                });
            } else {
                await this.putSocket(apiSocketOnHost, "/machine-config", {
                    vcpu_count: options.cpuCount ?? 2,
                    mem_size_mib: options.memoryMb ?? 256,
                });

                await this.putSocket(apiSocketOnHost, "/actions", {
                    action_type: "InstanceStart",
                });
            }

            // 8. 建立 vsock agent 连接并握手（带重试：等待 guest 内核启动 + socat 监听）
            const vsockBridge = new FirecrackerVsockBridge(vsockUdsOnHost, this.vsockPort);
            await vsockBridge.connectWithRetry(20000, 250);
            this.vsockBridges.set(options.id, vsockBridge);

            // 9. 首次完整开机后制作黄金快照（pause → create → resume），
            //    后续同模板 VM 走 snapshot/load 快速路径。best-effort：
            //    快照制作失败不影响本 VM 交付，但绝不伪造"已加速"。
            if (this.snapshotsEnabled && !canRestore && templateHash !== null) {
                try {
                    const poolDir = this.snapshotManager.ensureDir(templateHash);
                    const poolPaths = this.snapshotManager.getSnapshotPaths(templateHash);
                    let snapForApi = poolPaths.snapshotPath;
                    let memForApi = poolPaths.memFilePath;
                    let snapInChroot: string | undefined;
                    let memInChroot: string | undefined;
                    if (chrootRootForVm !== undefined) {
                        snapInChroot = resolve(chrootRootForVm, "run/golden.snap");
                        memInChroot = resolve(chrootRootForVm, "run/golden.mem");
                        snapForApi = "/run/golden.snap";
                        memForApi = "/run/golden.mem";
                    }

                    let paused = false;
                    try {
                        await this.setVmState(apiSocketOnHost, "Paused");
                        paused = true;
                        await this.putSocket(apiSocketOnHost, "/snapshot/create", {
                            snapshot_type: "Full",
                            snapshot_path: snapForApi,
                            mem_file_path: memForApi,
                        });
                        if (snapInChroot !== undefined && memInChroot !== undefined) {
                            await copyFileReflink(snapInChroot, poolPaths.snapshotPath);
                            await copyFileReflink(memInChroot, poolPaths.memFilePath);
                        }
                    } finally {
                        // 无论快照成功与否都必须恢复 vCPU，否则本 VM 会永久停在
                        // Paused（guest 不再执行指令），表现为"任务卡死"而非报错。
                        if (paused) {
                            await this.setVmState(apiSocketOnHost, "Resumed")
                                .catch((resumeErr) => {
                                    console.error(
                                        `[Firecracker] 快照后恢复 vCPU 失败（template=${templateHash}），`
                                        + "该 VM 已被终止以避免交付卡死实例：",
                                        resumeErr,
                                    );
                                    throw resumeErr;
                                });
                        }
                    }
                    void poolDir;
                } catch (snapshotErr) {
                    console.error(
                        `[Firecracker] 黄金快照制作失败（template=${templateHash}），`
                        + "后续 VM 将回退完整开机路径：",
                        snapshotErr,
                    );
                }
            }

            return {
                id: options.id,
                driver: "firecracker",
                vmPid: proc.pid,
                guestCid,
                workspacePath: options.workspacePath,
                workspaceDiskHostPath,
                createdAt: new Date().toISOString(),
            };
        } catch (error) {
            await this.terminate(options.id).catch(() => undefined);
            throw error;
        }
    }

    async execute(
        vmId: string,
        command: readonly string[],
        options?: MicrovmExecuteOptions,
    ): Promise<MicrovmExecutionResult> {
        const proc = this.processes.get(vmId);
        if (!proc || proc.killed) {
            throw new Error(`Firecracker MicroVM 实例不存在或已终止：${vmId}`);
        }

        const bridge = this.vsockBridges.get(vmId);
        if (!bridge) {
            throw new Error(
                `Firecracker MicroVM 没有可用的 vsock 桥（vmId=${vmId}）；`
                + "VM 可能未完成启动，拒绝伪造执行结果。",
            );
        }

        return await bridge.execute(command, options);
    }

    async flushFilesystem(vmId: string): Promise<void> {
        const bridge = this.vsockBridges.get(vmId);
        if (bridge) {
            try {
                await bridge.execute(["sync"], { timeoutMs: 5000 });
            } catch {
                // best-effort
            }
        }
    }

    /**
     * 停止 VM（关 vsock、SIGKILL guest）但保留运行目录与工作区磁盘，
     * 供调用方在 guest 完全静止后安全导出磁盘；随后必须调 terminate() 完整清理。
     */
    async stopVm(vmId: string): Promise<void> {
        const bridge = this.vsockBridges.get(vmId);
        if (bridge) {
            bridge.close();
            this.vsockBridges.delete(vmId);
        }

        const proc = this.processes.get(vmId);
        if (proc) {
            this.processes.delete(vmId);
            try {
                proc.kill("SIGKILL");
            } catch {
                // Already killed
            }
        }

        // 等待 100ms 确保 guest 写盘完全停止
        await new Promise((r) => setTimeout(r, 100));
    }

    async terminate(vmId: string): Promise<void> {
        // 幂等：若 stopVm 已执行，这里取不到 bridge/proc 会直接跳过
        await this.stopVm(vmId);

        // 清理私有运行目录
        const dir = this.runDirectories.get(vmId);
        if (dir) {
            await dir.dispose();
            this.runDirectories.delete(vmId);
        }
        await this.runDirManager.dispose(vmId);

        // 释放 UID 与 CID
        this.uidAllocator.release(vmId);
        this.cidAllocator.release(vmId);
    }
}
