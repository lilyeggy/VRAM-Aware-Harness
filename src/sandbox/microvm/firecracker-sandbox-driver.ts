import { accessSync, constants, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
import { KeyedSemaphore } from "./vm-concurrency-gate.ts";
import {
    isFirecrackerProcess,
    killPid,
    reapOrphans,
    waitForExitAsync,
    writePidFile,
    type ReapOrphansReport,
} from "./vm-orphan-reaper.ts";

export interface FirecrackerDriverConfig {
    readonly binaryPath?: string;
    readonly jailerPath?: string;
    readonly kernelPath?: string;
    readonly rootfsPath?: string;
    readonly workspaceDiskTemplatePath?: string;
    readonly kvmDevicePath?: string;
    readonly vmRuntimeRoot?: string;
    /** 非 jailer 模式下 API/vsock Unix socket 的短路径根目录（SUN_LEN 限制）。 */
    readonly socketRoot?: string;
    readonly vsockPort?: number;
    readonly useJailer?: boolean;
    /** /proc 根目录（测试可注入假 procfs） */
    readonly procRoot?: string;
    /**
     * 快照制作的单飞闸门并发上限（默认 1，即同一时刻只让一台 VM 制作快照）。
     *
     * 小于 1 会被钳到 1（完全串行）。**不可配置为 0**：那会让所有 VM 的快照
     * 制作永久排队、创建流程卡死。生产建议保持 1。
     */
    readonly snapshotConcurrency?: number;
    /**
     * Phase 3：microVM 快照加速。开启后，首次完整开机并握手成功后
     * 制作"黄金快照"（pause → snapshot/create → resume）；
     * 后续同模板 VM 走 /snapshot/load 快速路径（约 10ms 级恢复）。
     */
    readonly snapshotsEnabled?: boolean;
    /** 快照池目录（默认 /var/lib/harness/snapshots）。 */
    readonly snapshotPoolDir?: string;
    /**
     * guest agent 版本，参与快照模板指纹。
     * 【必须】改动 guest/agent 后同步更新（或设 HARNESS_GUEST_AGENT_VERSION），
     * 否则模板指纹不变，会静默复用含旧 agent 的黄金快照。
     */
    readonly guestAgentVersion?: string;
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

/**
 * Firecracker VMM 自身的内存底噪（MiB），与准入估算
 * `estimateSandboxMemoryMiB()` 的 strict 档 +64 MiB 保持同一模型。
 * jailer cgroup 的 memory.max 必须覆盖 "guest 内存 + VMM 自身"，
 * 否则 Firecracker 会被自己的 cgroup OOM 掉。
 */
const VMM_MEMORY_OVERHEAD_MIB = 64;

/** 未显式指定资源时的默认值；单一事实来源，cgroup 与 /machine-config 共用。 */
const DEFAULT_VCPU_COUNT = 2;
const DEFAULT_MEMORY_MIB = 512;

/**
 * jailer 的 cgroup 限额参数。
 *
 * - `cpu.max` = 核数配额（period 固定 100000µs，即 1 核 = 100000/100000）。
 * - `memory.max` = guest 内存 + VMM 底噪：必须严格大于 guest 内存，
 *   否则 Firecracker 会被自己的 cgroup OOM 掉。
 *
 * 抽成纯函数以便不依赖 root/KVM 即可断言具体数值。
 */
export function buildJailerCgroupArgs(vcpuCount: number, memoryMb: number): string[] {
    return [
        "--cgroup", `cpu.max=${vcpuCount * 100000} 100000`,
        "--cgroup", `memory.max=${(memoryMb + VMM_MEMORY_OVERHEAD_MIB) * 1024 * 1024}`,
    ];
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
    private readonly socketRoot: string;
    private readonly vsockPort: number;
    private readonly useJailer: boolean;
    private readonly snapshotsEnabled: boolean;
    private readonly guestAgentVersion: string;
    private readonly snapshotManager: VmSnapshotManager;
    private readonly runDirManager: VmRunDirectoryManager;
    private readonly uidAllocator = new VmUidAllocator();
    private readonly cidAllocator = new VmCidAllocator();

    private readonly processes = new Map<string, ChildProcess>();
    private readonly vsockBridges = new Map<string, FirecrackerVsockBridge>();
    private readonly runDirectories = new Map<string, VmRunDirectory>();
    /**
     * vmId -> 宿主 pid。进程重启后 `processes` 为空，靠这张表 + pidfile 兜底回收
     * 孤儿 Firecracker 进程（否则它们会静默吃满宿主内存而准入看不见）。
     */
    private readonly pids = new Map<string, number>();
    /** /proc 根目录（测试可注入假 procfs） */
    private readonly procRoot: string;
    /**
     * 快照制作的并发闸门（信号量）。
     *
     * ## 为什么必须有
     *
     * 多台 VM 若同时首次启动且 kernel/rootfs 相同，它们的 templateHash 也相同，
     * 于是会**并发写同一个快照文件**，且各自 pause/resume 触发 vsock 断连重连。
     * 真机 10 并发实测：两台不同租户（tenant-02 / tenant-04）稳定复现
     * "vsock agent 20s 未就绪"；关闭快照后 10/10 通过 —— 确认是快照路径的
     * 并发竞态，而非并发能力不足。
     *
     * 因此按 templateHash 串行化：**同一模板只让一台 VM 制作快照**，其余等待
     * 后复用结果。不同模板仍可并行。
     */
    private readonly snapshotGate: KeyedSemaphore<string>;

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
        this.socketRoot = config.socketRoot
            ?? process.env.HARNESS_VM_SOCKET_ROOT
            ?? join(tmpdir(), "harness-vm-sockets");
        this.vsockPort = config.vsockPort ?? 5000;
        this.useJailer = config.useJailer ?? (process.env.HARNESS_USE_JAILER !== "false");
        this.snapshotsEnabled = config.snapshotsEnabled
            ?? (process.env.HARNESS_VM_SNAPSHOTS_ENABLED === "true");
        this.guestAgentVersion = config.guestAgentVersion
            ?? process.env.HARNESS_GUEST_AGENT_VERSION
            ?? "1.0.0";
        this.snapshotManager = new VmSnapshotManager({
            ...(config.snapshotPoolDir !== undefined || process.env.HARNESS_VM_SNAPSHOT_POOL_DIR !== undefined
                ? { snapshotPoolDir: config.snapshotPoolDir ?? process.env.HARNESS_VM_SNAPSHOT_POOL_DIR }
                : {}),
        });

        this.runDirManager = new VmRunDirectoryManager({ runtimeRoot: this.vmRuntimeRoot });
        this.procRoot = config.procRoot ?? "/proc";
        // 同一 templateHash 的快照制作必须串行（默认并发上限 1）。
        this.snapshotGate = new KeyedSemaphore<string>(
            config.snapshotConcurrency ?? Number(process.env.HARNESS_VM_SNAPSHOT_CONCURRENCY ?? "1"),
        );

        // 非 jailer 模式禁止启用快照：Firecracker 快照会把 block device 的
        // path_on_host 原样固化进 vm.snap。非 jailer 下该路径是宿主上的
        // 每 Run 绝对路径，后续恢复的 VM 无法各自替换成自己的运行目录，
        // 最终会共用黄金 VM 的工作区磁盘，造成跨租户串写且 terminate 导出为空。
        // jailer 模式下每个 VM 有独立 chroot/mount namespace，固化路径是
        // /rootfs.ext4、/workspace.ext4，因此每台 VM 仍各自独立。
        if (this.snapshotsEnabled && this.useJailer === false) {
            throw new Error(
                "非 jailer 模式不允许启用 microVM 快照加速：快照会固化宿主绝对磁盘路径，"
                + "多台恢复 VM 将共享同一工作区磁盘（跨租户串写、产物无法导出）。"
                + "请设置 HARNESS_USE_JAILER=true，或关闭 HARNESS_VM_SNAPSHOTS_ENABLED。",
            );
        }
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

    /**
     * 非 jailer 模式下分配短路径 Unix socket。
     *
     * Unix domain socket 的 sun_path 只有 108 字节（含 NUL）。运行目录
     * <vmRuntimeRoot>/<sandboxId>/ 在生产部署里很容易超过这个长度，导致
     * Firecracker 启动即失败：Failed to bind and run the HTTP server:
     * IO error: path must be shorter than SUN_LEN。这里把 socket 放到独立短根
     * 目录，并用 sandboxId 的 SHA-256 前 16 位做子目录，既短又稳定。
     */
    private socketDirFor(sandboxId: string): string {
        const short = createHash("sha256").update(sandboxId).digest("hex").slice(0, 16);
        return resolve(this.socketRoot, short);
    }

    private allocateSocketPaths(sandboxId: string): {
        readonly apiSocketPath: string;
        readonly vsockUdsPath: string;
    } {
        const dir = this.socketDirFor(sandboxId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const apiSocketPath = join(dir, "firecracker.socket");
        const vsockUdsPath = join(dir, "vsock.sock");
        const maxBytes = 107;
        const candidates = [["API socket", apiSocketPath], ["vsock UDS", vsockUdsPath]] as const;
        for (const entry of candidates) {
            const bytes = Buffer.byteLength(entry[1], "utf8");
            if (bytes > maxBytes) {
                throw new Error(
                    "Firecracker " + entry[0] + " 路径过长（" + bytes + " 字节 > " + maxBytes + "）：" + entry[1]
                    + "。Unix domain socket 受 SUN_LEN 限制；请将 HARNESS_VM_SOCKET_ROOT 设为更短的目录（例如 /tmp/harness-vm-sockets）。",
                );
            }
        }
        return { apiSocketPath, vsockUdsPath };
    }

    private removeSocketDir(sandboxId: string): void {
        try {
            rmSync(this.socketDirFor(sandboxId), { recursive: true, force: true });
        } catch {
            // best-effort：socket 清理失败不得掩盖 terminate 主流程。
        }
    }

    /** 快照共用的模板指纹；镜像未配置时返回 null（调用方据此禁用加速）。 */
    computeTemplateHash(): string | null {
        if (!this.kernelPath || !this.rootfsPath) {
            return null;
        }
        return this.snapshotManager.computeTemplateHash(
            this.kernelPath,
            this.rootfsPath,
            this.guestAgentVersion,
        );
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
        timeoutMs = 10_000,
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const data = JSON.stringify(payload);
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                if (timer !== undefined) clearTimeout(timer);
                fn();
            };
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
                    settle(() => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve();
                        } else {
                            reject(new Error(`Firecracker API error [${path}]: ${res.statusCode} ${body}`));
                        }
                    });
                });
            });
            timer = setTimeout(() => {
                const error = new Error(
                    `Firecracker API 超时 [${path}]：${timeoutMs}ms 内未完成；`
                    + "拒绝无限期等待（snapshot/create 等重操作请放宽 timeoutMs）。",
                );
                settle(() => reject(error));
                req.destroy(error);
            }, timeoutMs);
            req.on("error", (error) => settle(() => reject(error)));
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

        // 单一事实来源：cgroup（jailer）与 /machine-config（guest）必须用同一组资源值。
        // 此前两处各自兜底（cgroup 512MiB / guest 256MiB），未显式传值时会产生
        // "cgroup 限额与 guest 实际内存不一致"的错位。
        const vcpuCount = options.cpuCount ?? DEFAULT_VCPU_COUNT;
        const memoryMb = options.memoryMb ?? DEFAULT_MEMORY_MIB;

        let proc: ChildProcess | undefined;
        let childStderr = "";
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
                // 注意：这里**不要**创建 chroot 内的 run/ 目录来放共享文件。
                // jailer 会把 chroot 的 /run 在独立 mount namespace 中重挂为
                // tmpfs（真机实测 size=26371712k、inode=1），任何放在 /run 下的
                // socket 或快照文件都会被该 tmpfs 遮蔽：宿主写入后 Firecracker
                // 在 jail 内看不到，宿主侧也读不到 Firecracker 创建的 socket。
                // 因此所有需要跨 jail 边界访问的东西一律放 chroot **根目录**。

                // 异步复制到 chroot 内部
                await copyFileReflink(this.kernelPath, resolve(chrootRoot, "kernel.bin"));
                await copyFileReflink(this.rootfsPath, resolve(chrootRoot, "rootfs.ext4"));
                await copyFileReflink(workspaceTemplate, resolve(chrootRoot, "workspace.ext4"));

                // 4. 分配 UID/GID 并 chown
                const { uid, gid } = this.uidAllocator.allocate(options.id);
                const chownProc = Bun.spawn(["chown", "-R", `${uid}:${gid}`, chrootRoot]);
                await chownProc.exited;

                apiSocketOnHost = resolve(chrootRoot, "firecracker.socket");
                vsockUdsOnHost = resolve(chrootRoot, "vsock.sock");
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
                const cgroupArgs = buildJailerCgroupArgs(vcpuCount, memoryMb);

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

                const sockets = this.allocateSocketPaths(options.id);
                apiSocketOnHost = sockets.apiSocketPath;
                vsockUdsOnHost = sockets.vsockUdsPath;
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
            proc.stderr?.on("data", (chunk: Buffer | string) => {
                if (childStderr.length < 8192) childStderr += chunk.toString();
            });
            proc.on("error", (err) => {
                console.error(`[Firecracker] Process error for sandbox ${options.id}:`, err);
            });

            // 进程一启动就落盘 pid 并写 pidfile。
            //
            // 这是**跨重启回收孤儿 VM 的唯一凭据**：Harness 崩溃或被 kill 后，
            // 内存里的 processes Map 会随之消失，但 pidfile 还在。下次启动时
            // reapOrphanVms() 靠它找到并杀掉遗留的 Firecracker 进程，避免这些
            // 进程静默吃满宿主内存而容量准入完全看不见（→ 超卖 → 别人的 VM 被 OOM）。
            if (proc.pid !== undefined) {
                this.pids.set(options.id, proc.pid);
                writePidFile(dir.root, proc.pid, basename(this.binaryPath), options.id);
            }

            // 6. 等待 API Socket 出现
            const maxWaitMs = 1500;
            const start = Date.now();
            while (!existsSync(apiSocketOnHost) && Date.now() - start < maxWaitMs) {
                if (proc.exitCode !== null || proc.signalCode !== null) break;
                await new Promise((r) => setTimeout(r, 20));
            }
            if (!existsSync(apiSocketOnHost)) {
                const exited = proc.exitCode !== null || proc.signalCode !== null;
                const status = exited
                    ? "（进程已退出：code=" + String(proc.exitCode) + ", signal=" + String(proc.signalCode) + "）"
                    : "（进程仍在运行，但未创建 socket）";
                const stderrDetail = childStderr.trim().length > 0
                    ? "；stderr: " + childStderr.trim()
                    : "；stderr 为空";
                throw new Error(
                    "Firecracker API Socket 未能在 " + maxWaitMs + "ms 内就绪：" + apiSocketOnHost
                    + status + stderrDetail,
                );
            }

            // 7. Firecracker API 配置
            // Phase 3 快照说明：restore 与快照制作之间，块设备 backing 文件内容
            // 必须一致（rootfs/工作区盘均为同一模板的逐份复制，内容相同，
            // 满足 Firecracker 对非 diff 快照的这一约束）。
            const templateHash = this.snapshotsEnabled
                ? this.snapshotManager.computeTemplateHash(
                    this.kernelPath,
                    this.rootfsPath,
                    this.guestAgentVersion,
                )
                : null;
            const canRestore = templateHash !== null && this.snapshotManager.hasSnapshot(templateHash);

            if (canRestore && templateHash !== null) {
                // 快速路径：加载黄金快照并直接恢复。
                //
                // 官方约束（swagger /snapshot/load: "Only accepted on a fresh
                // Firecracker process (before configuring any resource other
                // than the Logger and Metrics)"）：恢复前**不能**配置任何资源。
                // 原实现先 PUT /drives/* 与 /vsock 再 load，真机报
                // 400 "Loading a microVM snapshot not allowed after configuring
                // boot-specific resources."。因此这里必须最先调用 load，
                // 块设备与 vsock 配置全部来自快照本身。
                const poolPaths = this.snapshotManager.getSnapshotPaths(templateHash);
                let snapForApi = poolPaths.snapshotPath;
                let memForApi = poolPaths.memFilePath;
                if (chrootRootForVm !== undefined) {
                    // jailer 降权后只能访问 chroot 内部：复制快照进去
                    const snapInChroot = resolve(chrootRootForVm, "restore.snap");
                    const memInChroot = resolve(chrootRootForVm, "restore.mem");
                    await copyFileReflink(poolPaths.snapshotPath, snapInChroot);
                    await copyFileReflink(poolPaths.memFilePath, memInChroot);
                    snapForApi = "/restore.snap";
                    memForApi = "/restore.mem";
                }
                await this.putSocket(apiSocketOnHost, "/snapshot/load", {
                    snapshot_path: snapForApi,
                    mem_file_path: memForApi,
                    enable_diff_snapshots: false,
                    track_dirty_pages: false,
                    // 快照里固化的是黄金 VM 的 vsock UDS 路径，必须覆盖为本 Run 的
                    // 私有 socket，否则 vsock 桥会连到上一个 VM 留下的地址。
                    //
                    // 字段名是 `uds_path`（小写下划线），Firecracker 的 VsockOverride
                    // 定义中它是 required。写成 `UDS_PATH` 会被 serde 拒绝：
                    // 400 missing field `uds_path`（真机实测 v1.17.0）。
                    vsock_override: {
                        uds_path: this.useJailer ? "/vsock.sock" : vsockUdsOnHost,
                    },
                    resume_vm: true,
                }, "PUT", 60_000);
            } else {
                // 冷启动路径：完整配置再开机。
                await this.putSocket(apiSocketOnHost, "/boot-source", {
                    kernel_image_path: kernelPathForApi,
                    boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/init",
                });

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
                    uds_path: this.useJailer ? "/vsock.sock" : vsockUdsOnHost,
                });

                await this.putSocket(apiSocketOnHost, "/machine-config", {
                    vcpu_count: vcpuCount,
                    mem_size_mib: memoryMb,
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
            //
            //    【并发闸门】同一 templateHash 的快照制作必须串行。多台 VM 同时
            //    首次启动会并发写同一个 vm.snap/mem.snap，并各自 pause/resume
            //    触发 vsock 断连重连 —— 真机 10 并发下稳定复现"vsock agent 20s
            //    未就绪"。这里用 KeyedSemaphore 按 templateHash 串行化：同一模板
            //    只让一台真正制作，其余等待后直接复用成果（既避免竞态，也省掉
            //    一次昂贵的 pause/resume + vsock 重连）。
            if (this.snapshotsEnabled && !canRestore && templateHash !== null) {
                // madeByThisVm：本 VM 是否真的执行了 pause/create（决定要不要重连 vsock）
                let madeByThisVm = false;
                try {
                    await this.snapshotGate.runExclusive(templateHash, async () => {
                        // 等到闸门时，先复查：可能前一台已经把快照做出来了。
                        // 此时直接复用，无需再 pause/resume（也就无需 vsock 重连）。
                        if (this.snapshotManager.hasSnapshot(templateHash)) {
                            return;
                        }

                        this.snapshotManager.ensureDir(templateHash);
                        const poolPaths = this.snapshotManager.getSnapshotPaths(templateHash);
                        let snapForApi = poolPaths.snapshotPath;
                        let memForApi = poolPaths.memFilePath;
                        let snapInChroot: string | undefined;
                        let memInChroot: string | undefined;
                        if (chrootRootForVm !== undefined) {
                            snapInChroot = resolve(chrootRootForVm, "golden.snap");
                            memInChroot = resolve(chrootRootForVm, "golden.mem");
                            snapForApi = "/golden.snap";
                            memForApi = "/golden.mem";
                        }

                        let paused = false;
                        try {
                            await this.setVmState(apiSocketOnHost, "Paused");
                            paused = true;
                            await this.putSocket(apiSocketOnHost, "/snapshot/create", {
                                snapshot_type: "Full",
                                snapshot_path: snapForApi,
                                mem_file_path: memForApi,
                            }, "PUT", 60_000);
                            if (snapInChroot !== undefined && memInChroot !== undefined) {
                                await copyFileReflink(snapInChroot, poolPaths.snapshotPath);
                                await copyFileReflink(memInChroot, poolPaths.memFilePath);
                            }
                            madeByThisVm = true;
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
                    });
                } catch (snapshotErr) {
                    console.error(
                        `[Firecracker] 黄金快照制作失败（template=${templateHash}），`
                        + "后续 VM 将回退完整开机路径：",
                        snapshotErr,
                    );
                }

                // 快照制作会 PATCH /vm Paused 冻结 vCPU。guest 内的 socat 与
                // agent 在此期间被冻结，宿主侧已建立的 vsock 连接会被对端关闭
                // （真机实测：快照生成后 bridge 抛 "Vsock connection closed
                // unexpectedly"）。恢复 vCPU 后必须重连，否则该 VM 永远不可用。
                //
                // 只有**本 VM 真的做了 pause/create** 才需要重连；若只是等闸门后
                // 复用了别人的快照，本 VM 的 guest 从未被冻结，连接依然有效。
                if (madeByThisVm) {
                    await vsockBridge.reconnectAfterGuestResume(20000, 250)
                        .catch((reconnectErr) => {
                            throw new Error(
                                `快照后 vsock agent 重连失败，该 VM 不可用：`
                                + `${reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)}`,
                            );
                        });
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
     *
     * ## 为什么要 pid 兜底
     *
     * `this.processes` 是进程内 Map，Harness 重启后为空。仅靠 Map 查句柄会在
     * 重启后杀不掉任何进程，VM 变成吃内存的孤儿。因此这里额外维护一份
     * `vmPid -> runDir` 映射，并落盘 pidfile（见 vm-orphan-reaper.ts），
     * 使进程重启后仍可寻址并回收。
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
        } else {
            // 内存 Map 查不到（典型场景：Harness 重启后回收上一个进程的遗留 VM）。
            // 改用 pid 兜底，否则这里会静默返回，VM 继续吃宿主内存。
            const pid = this.pids.get(vmId);
            if (pid !== undefined) {
                this.pids.delete(vmId);
                const binary = basename(this.binaryPath);
                // 只杀"经 /proc 验活确为我们的 Firecracker"的 pid。
                // 进程已不存在或 pid 已被系统复用为别的程序时，绝不能盲杀。
                if (isFirecrackerProcess(pid, binary, this.procRoot)) {
                    const signalled = killPid(pid);
                    // 发出 SIGKILL ≠ 进程已死。必须 await 确认退出，否则 terminate
                    // 会接着删目录，制造出一个不可寻址的孤儿 —— 正是要消灭的那类泄漏。
                    const exited = signalled && await waitForExitAsync(pid);
                    if (!exited) {
                        throw new Error(
                            `无法终止 Firecracker 进程 pid=${pid}（vmId=${vmId}）：`
                            + "SIGKILL 后进程仍存活。拒绝在进程存活时继续，"
                            + "避免删除运行目录后该进程变成不可寻址的孤儿、"
                            + "持续占用宿主内存且容量准入不可见。",
                        );
                    }
                }
            }
        }

        // 等待 100ms 确保 guest 写盘完全停止
        await new Promise((r) => setTimeout(r, 100));
    }

    /**
     * 启动时回收孤儿 VM 进程。必须在创建任何新 VM 之前调用。
     *
     * 没有这一步的话，上一进程崩溃/被杀后留下的 Firecracker 会一直占着内存，
     * 而容量准入看不见它们 → 超卖 → 别人的 VM 被 OOM。
     */
    reapOrphanVms(options: { readonly dryRun?: boolean } = {}): Promise<ReapOrphansReport> {
        return reapOrphans(this.vmRuntimeRoot, {
            binaryName: basename(this.binaryPath),
            procRoot: this.procRoot,
            ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
        });
    }

    async terminate(vmId: string): Promise<void> {
        // 顺序至关重要：**先停进程，再删目录**。
        // 反过来（先删目录）会让进程失去可寻址凭据，变成杀不掉的孤儿。
        //
        // stopVm() 抛错意味着进程仍存活（pid 兜底 kill 失败）。此时**必须中断**，
        // 绝不能继续删目录——那正好制造出我们要消灭的那种不可寻址孤儿。
        await this.stopVm(vmId);

        // 进程已确认停止（或本就不存在），现在才安全清理目录。
        // pidfile 位于运行目录内，dir.dispose() 会一并删除。
        const dir = this.runDirectories.get(vmId);
        if (dir) {
            await dir.dispose();
            this.runDirectories.delete(vmId);
        }
        this.pids.delete(vmId);
        await this.runDirManager.dispose(vmId);
        this.removeSocketDir(vmId);

        // 释放 UID 与 CID
        this.uidAllocator.release(vmId);
        this.cidAllocator.release(vmId);
    }
}
