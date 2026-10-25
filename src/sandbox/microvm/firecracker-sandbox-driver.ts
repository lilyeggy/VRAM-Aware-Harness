import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
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
import { SHARED_BASE_FILE_MODE, shareBaseFile, type ShareBaseFileOutcome } from "./shared-base-files.ts";
import {
    isFirecrackerProcess,
    killPid,
    reapOrphans,
    waitForExitAsync,
    writePidFile,
    type ReapOrphansReport,
} from "./vm-orphan-reaper.ts";

/**
 * guest 内核命令行里"与业务无关、纯粹为省冷启动时间"的部分。
 *
 * 真机实测（172.17.43.193 / jailer + fc117 / 256MB guest）：不加这些参数时冷启动
 * 1338~1462ms，其中 ~850ms 花在内核 initcall 上——内核时间线里有两段空白：
 * 0.091s→0.348s（257ms）与 0.363s→0.861s（498ms），都在 i8042（PS/2 键盘控制器）
 * 探测上。Firecracker 不提供 PS/2 设备（宿主日志有 `Failed to trigger i8042 kbd
 * interrupt (disabled by guest OS)`），这几段就是纯粹的等超时。
 *
 * 加上 `i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd` 后：guest userspace
 * 从 uptime 0.85s 提前到 0.05~0.06s，冷启动 1338ms → 539ms（-60%），
 * 首次制作快照 2235ms → 1452ms。热恢复（快照）不受影响，仍 ~103ms。
 *
 * 这些参数只影响 PS/2 输入设备探测，无头 guest 不需要键盘/鼠标。
 */
export const COLD_START_BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/init i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd";

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
    /**
     * 分阶段耗时追踪（默认读 HARNESS_VM_PHASE_TRACE=1）。
     *
     * 打开后每创建一台 VM 会往 stderr 打 `[vm-phase] <sandboxId> <阶段> <ms>`，
     * 用于回答"快照恢复为什么不是几毫秒"这类问题：把磁盘复制、chown、进程启动、
     * socket 等待、快照文件复制、/snapshot/load、vsock 握手逐段拆开。
     */
    readonly phaseTrace?: boolean;

    /**
     * 冷启动内核日志开关（默认关）。
     *
     * 内核串口日志写到 Firecracker 进程的 stdout，而宿主侧并不消费它
     * （驱动只接管 stderr，stdout 走 pipe 无人读），所以逐行启动日志是
     * 纯粹的浪费。默认加 quiet loglevel=3 只压日志等级，panic 级别仍会
     * 打印；排障时用 HARNESS_VM_BOOT_VERBOSE=1 或 config.verboseBoot 打开。
     */
    readonly verboseBoot?: boolean;

    /**
     * 可选：把 guest 串口输出追加到 `<dir>/<sandboxId>.serial.log`。
     *
     * 串口是观察冷启动的唯一窗口：guest 侧 /etc/boot-mark 会往 console 打
     * `harness-boot <阶段> uptime=<秒>`，用来回答"冷启动 ~1.2s 花在 init 的哪一步"
     * （宿主侧 [vm-phase] 只能看到内核首行与 socat 监听两个点，中间是黑盒）。
     * serialTail 只是内存里最近 8KB、进程退出即丢，落盘才能事后分析。
     * 默认关（生产不落盘），排障时用 HARNESS_VM_SERIAL_LOG_DIR 或 config.serialLogDir 打开。
     */
    readonly serialLogDir?: string;

    /**
     * 追加到 guest 内核命令行末尾的额外参数（默认取 `HARNESS_VM_EXTRA_BOOT_ARGS`）。
     *
     * 用来在不重编镜像的前提下调内核：真机实测冷启动 ~1.33s 里约 0.85s 花在
     * 内核 initcall，其中 i8042（PS/2 键盘控制器）探测在 Firecracker 上纯属
     * 白等超时（宿主日志里有 `Failed to trigger i8042 kbd interrupt`）。
     * `i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd` 可跳过这些探测。
     */
    readonly extraBootArgs?: string;

    /**
     * `/snapshot/create` 是否等待快照文件 fsync 落盘（默认 false = 不等）。
     *
     * 真机实测（256MiB guest，jailer，ext4）——**这个旋钮没有收益**：等 fsync 753ms、
     * 不等 756ms。原因是 256MiB 的 dump 本身就要约 750ms（≈340MiB/s，受宿主回写/NVMe
     * 带宽约束），期间后台 writeback 已把大部分脏页写掉，等 fsync 时几乎无剩余工作。
     * 因此**默认保持持久（true）**；`HARNESS_VM_SNAPSHOT_SYNC_FILES=0` 只留给"宿主确实
     * 等 fsync 更慢"的环境使用——关闭时驱动会在发布后异步补一次 `fsyncPublished`，
     * 把"宿主崩溃丢快照"的窗口收窄（快照池始终是可重建缓存，预热 timer 可重建）。
     */
    readonly snapshotSyncFiles?: boolean;
    /**
     * 快照类型（默认 `Full`，`HARNESS_VM_SNAPSHOT_TYPE=Diff` 切 Diff）。
     *
     * `Full` 会把整份 guest 内存逐页写盘（256MiB 实测约 750ms，见
     * docs/vm-startup-optimizations.zh-CN.md O7）；`Diff` 走脏页/`mincore` 近似，
     * 只写"可能非零"的页，生成稀疏文件（官方文档：**刚启动过的 VM 的 diff
     * 快照可以直接 resume**，从快照恢复过的 VM 的 diff 才需要先与 base 合并）。
     * 我们的黄金快照恰好是"刚完整启动并握手成功的 VM"，符合可直接 resume 的前提。
     */
    readonly snapshotType?: "Full" | "Diff";
    /**
     * 共享只读基础文件（默认开启，`HARNESS_VM_SHARE_BASE_FILES=0` 关闭）。
     *
     * 开启后内核与快照文件（vm.snap / mem.snap）不再逐 VM 拷进 chroot，
     * 而是硬链接进 VM 目录：同 inode、零拷贝，多台 VM 共享同一份。
     * 安全前提见 shared-base-files.ts（Firecracker 官方 MAP_PRIVATE 只读映射）。
     */
    readonly shareBaseFiles?: boolean;
    /**
     * 是否把 rootfs 也作为共享只读盘（默认开启，`HARNESS_VM_SHARE_ROOTFS=0` 关闭）。
     *
     * 关闭时 rootfs 仍逐 VM 复制且可写（旧行为）。开启后 rootfs 以
     * `is_read_only: true` 挂给 guest，guest 根文件系统只读。
     */
    readonly shareRootfs?: boolean;
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
    if (exitCode === 0) {
        return;
    }
    const errText = await new Response(proc.stderr).text();
    // 非 Linux 宿主（macOS/BSD cp 不支持 --reflink）退化为普通复制：
    // reflink 只是省拷贝的优化，缺了它不该让整个沙箱不可用。
    const fallback = Bun.spawn(["cp", src, dst], { stdout: "ignore", stderr: "pipe" });
    const fallbackExit = await fallback.exited;
    if (fallbackExit !== 0) {
        const fallbackErr = await new Response(fallback.stderr).text();
        throw new Error(`Failed to copy ${src} to ${dst}: ${errText} / ${fallbackErr}`);
    }
}


export const WORKSPACE_SEED_ENV = "HARNESS_VM_WORKSPACE_SEED";

/** 播种容量预估：ext4 元数据与目录项需要额外空间，按内容 1.1 倍 + 8MiB 预留。 */
export function workspaceSeedRequiredBytes(seedBytes: number): number {
    return Math.ceil(seedBytes * 1.1) + 8 * 1024 * 1024;
}

/**
 * 本 Run 工作区盘的块数：恒等于模板容量（4096B/块）。
 * 容量必须与黄金快照一致——快照恢复复用同一盘 geometry，
 * 每 Run 现场放大容量会让恢复出的 VM 与快照状态错位。
 */
export function computeWorkspaceImageBlocks(templateBytes: number): number {
    return Math.max(1024, Math.floor(templateBytes / 4096));
}

/** 统计播种目录内容（跳过 lost+found 与导出临时目录），用于容量预检。 */
export function summarizeSeedDirectory(dir: string): { entries: number; bytes: number } {
    let entries = 0;
    let bytes = 0;
    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (entry.name === "lost+found" || entry.name.startsWith(".tmp-")) {
                continue;
            }
            const itemPath = join(current, entry.name);
            if (entry.isDirectory()) {
                entries += 1;
                walk(itemPath);
                continue;
            }
            if (entry.isFile()) {
                entries += 1;
                bytes += statSync(itemPath).size;
            }
        }
    };
    walk(dir);
    return { entries, bytes };
}

/**
 * F-K 修复：把宿主工作区目录播种进本 Run 的工作区盘。
 *
 * 每个 Run 的工作区盘原本只是模板副本（空 ext4），于是 guest 看不到用户上次
 * Run 写进工作区的文件——真机证据：同一 workspace 连续三个 Run，
 * 写 persist.txt 成功之后 `ls -1` 只回 lost+found、`cat persist.txt` 报
 * "No such file or directory"（见 docs/full-coverage-report.zh-CN.md F-K）。
 * 宿主工作区目录才是持久资产，因此非空时用 `mke2fs -d` 播种；
 * 目录为空或显式设置 HARNESS_VM_WORKSPACE_SEED=0 时保留模板复制快路径。
 */
export async function prepareWorkspaceDiskFromHost(
    templatePath: string,
    seedPath: string | undefined,
    destination: string,
): Promise<{ seeded: boolean }> {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (
        seedPath === undefined
        || process.env[WORKSPACE_SEED_ENV] === "0"
        || existsSync(seedPath) === false
    ) {
        await copyFileReflink(templatePath, destination);
        return { seeded: false };
    }
    const seed = summarizeSeedDirectory(seedPath);
    if (seed.entries === 0) {
        await copyFileReflink(templatePath, destination);
        return { seeded: false };
    }
    const templateBytes = statSync(templatePath).size;
    const required = workspaceSeedRequiredBytes(seed.bytes);
    if (required > templateBytes) {
        throw new Error(
            `工作区内容 ${seed.bytes}B 超过模板容量 ${templateBytes}B：`
            + "请扩大 FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH 指向的 ext4 模板并重建快照池"
            + "（盘容量必须与黄金快照一致，不得在每 Run 现场放大）。",
        );
    }
    const blocks = computeWorkspaceImageBlocks(templateBytes);
    // 宿主机未装 e2fsprogs 时退化为空盘模板复制并留一行警告：
    // 仅缺一个工具就让所有 Run 失败不合理；退化不等于静默（有日志可查）。
    if (Bun.which("mke2fs") === null) {
        console.warn("[workspace-seed] mke2fs 不可用，退化为空盘模板（guest 看不到工作区既有文件）");
        await copyFileReflink(templatePath, destination);
        return { seeded: false };
    }
    const proc = Bun.spawn(
        [
            "mke2fs", "-q", "-t", "ext4", "-F", "-L", "workspace",
            "-b", "4096", "-d", seedPath, destination, String(blocks),
        ],
        { stdout: "ignore", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode === 0) {
        return { seeded: true };
    }
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`工作区磁盘播种失败（mke2fs -d ${seedPath}）：${stderr}`);
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
    private readonly shareBaseFiles: boolean;
    private readonly shareRootfs: boolean;
    private readonly guestAgentVersion: string;
    private readonly phaseTrace: boolean;
    private readonly verboseBoot: boolean;
    private readonly serialLogDir: string | null;
    private readonly extraBootArgs: string;
    private readonly snapshotSyncFiles: boolean;
    private readonly snapshotType: "Full" | "Diff";
    private serialLogDirReady = false;
    /**
     * guest 串口（内核启动日志）尾巴，按 sandbox 存最近 8KB。
     *
     * 两个作用：① 诊断（冷启动/握手失败时能看到 guest 卡在哪）；② 必须**消费**
     * stdout —— 它是 pipe，不读就会在 guest 打印较多时把 Firecracker 进程堵死。
     */
    private readonly serialTail = new Map<string, string>();
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
     * 真机 10 并发实测：两台不同用户（user-02 / user-04）稳定复现
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
        this.shareBaseFiles = config.shareBaseFiles
            ?? (process.env.HARNESS_VM_SHARE_BASE_FILES !== "0");
        // rootfs 共享默认**关闭**：共享后 rootfs 只能以只读 virtio 盘挂给 guest
        // （同一 inode 不能给多台 VM 写），guest 内除 /workspace 外全部只读，
        // `pip install`/编译缓存这类写 /tmp、$HOME 的工具会 EROFS 失败。
        // 收益是把热恢复从 ~200ms 降到 ~100ms（真机实测），按需显式开启。
        this.shareRootfs = this.shareBaseFiles
            && (config.shareRootfs ?? (process.env.HARNESS_VM_SHARE_ROOTFS === "1"));
        // 该值参与 computeTemplateHash(kernel, rootfs, agentVersion)：换 guest agent 实现
        // 必须提升它，否则会复用旧 agent 的黄金快照（真机踩过）。2.0.0 = 静态 C agent
        // （guest/agent/agent.c，自监听 vsock，替换掉 socat + 96MB Bun 产物）。
        this.guestAgentVersion = config.guestAgentVersion
            ?? process.env.HARNESS_GUEST_AGENT_VERSION
            ?? "2.0.0";
        this.phaseTrace = config.phaseTrace ?? (process.env.HARNESS_VM_PHASE_TRACE === "1");
        this.verboseBoot = config.verboseBoot ?? (process.env.HARNESS_VM_BOOT_VERBOSE === "1");
        this.serialLogDir = config.serialLogDir ?? process.env.HARNESS_VM_SERIAL_LOG_DIR ?? null;
        this.extraBootArgs = (config.extraBootArgs ?? process.env.HARNESS_VM_EXTRA_BOOT_ARGS ?? "").trim();
        this.snapshotSyncFiles = config.snapshotSyncFiles
            ?? (process.env.HARNESS_VM_SNAPSHOT_SYNC_FILES === "0" ? false : true);
        this.snapshotType = config.snapshotType
            ?? (process.env.HARNESS_VM_SNAPSHOT_TYPE === "Diff" ? "Diff" : "Full");
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
        // 最终会共用黄金 VM 的工作区磁盘，造成跨用户串写且 terminate 导出为空。
        // jailer 模式下每个 VM 有独立 chroot/mount namespace，固化路径是
        // /rootfs.ext4、/workspace.ext4，因此每台 VM 仍各自独立。
        if (this.snapshotsEnabled && this.useJailer === false) {
            throw new Error(
                "非 jailer 模式不允许启用 microVM 快照加速：快照会固化宿主绝对磁盘路径，"
                + "多台恢复 VM 将共享同一工作区磁盘（跨用户串写、产物无法导出）。"
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

    /**
     * guest 串口输出：第一次拿到数据即"内核开始执行"，用它把冷启动的
     * vsock-handshake（~1.3s）拆成"内核启动"与"guest 用户态 + agent 就绪"。
     * 同时把 stdout 读掉（pipe 必须消费），并保留尾巴用于诊断。
     */
    private onSerialOutput(sandboxId: string, chunk: Buffer | string, spawnAtMs: number): void {
        this.writeSerialLog(sandboxId, chunk);
        const existing = this.serialTail.get(sandboxId);
        if (existing === undefined) {
            this.tracePhase(sandboxId, "serial-first-line", spawnAtMs);
        }
        const text = existing === undefined ? chunk.toString() : existing + chunk.toString();
        this.serialTail.set(sandboxId, text.slice(-8192));
    }

    /**
     * 把串口分片追加到 `<serialLogDir>/<sandboxId>.serial.log`（可选，默认关）。
     * 写失败只告警：串口日志是排障手段，不能因为它把 VM 创建搞崩。
     */
    /** 把 HARNESS_VM_EXTRA_BOOT_ARGS 追加到内核命令行（空串则原样返回）。 */
    private withExtraBootArgs(base: string): string {
        return this.extraBootArgs.length === 0 ? base : `${base} ${this.extraBootArgs}`;
    }

    private writeSerialLog(sandboxId: string, chunk: Buffer | string): void {
        const dir = this.serialLogDir;
        if (dir === null) {
            return;
        }
        try {
            if (this.serialLogDirReady === false) {
                mkdirSync(dir, { recursive: true });
                this.serialLogDirReady = true;
            }
            appendFileSync(join(dir, `${sandboxId}.serial.log`), chunk);
        } catch (error) {
            console.error(`[Firecracker] 串口日志写入失败：${String(error)}`);
        }
    }

    private tracePhase(sandboxId: string, phase: string, startedAt: number): void {
        if (this.phaseTrace === false) {
            return;
        }
        console.error(`[vm-phase] ${sandboxId} ${phase} ${Date.now() - startedAt}ms`);
    }

    /** 记录共享方式（linked = 硬链接零拷贝，copied = 跨设备/无权限时的复制兜底）。 */
    private traceShare(
        sandboxId: string,
        kernel: ShareBaseFileOutcome,
        rootfs: ShareBaseFileOutcome,
    ): void {
        if (this.phaseTrace === false) {
            return;
        }
        console.error(`[vm-phase] ${sandboxId} share kernel=${kernel} rootfs=${rootfs}`);
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
        let spawnAtMs = 0;
        const createStartedAt = Date.now();
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
            // 分阶段耗时追踪用的游标（见 tracePhase）
            let phaseAt = Date.now();
            // jailer chroot 根（快照文件必须放进 chroot 才能被降权后的
            // Firecracker 进程访问）；非 jailer 模式为 undefined。
            let chrootRootForVm: string | undefined;
            // rootfs 是否以共享只读盘挂给 guest（决定 /drives/rootfs.is_read_only）。
            let sharedRootfsReadOnly = false;
            // 工作区盘是否由宿主工作区目录播种（F-K）。
            // 播种盘的 ext4 布局与黄金快照时的工作区盘不同，恢复快照的 guest 内存里
            // 持有旧盘缓存（真机实测第二轮 cat 报 `Bad message`，diff 为空）；因此播种
            // Run 一律冷启动：不恢复快照、也不制作快照（见下方 canRestore 与 make-snapshot）。
            let workspaceDiskSeeded = false;

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

                // 3.1 工作区盘必须每 Run 私有可写 → 逐份复制。
                // 内核/rootfs 在共享模式下不在这里复制：硬链接要放在 chown 之后，
                // 否则 `chown -R` 会把模板/池内文件的属主一起改掉。
                phaseAt = Date.now();
                workspaceDiskSeeded = (await prepareWorkspaceDiskFromHost(workspaceTemplate, options.workspaceSeedPath, resolve(chrootRoot, "workspace.ext4"))).seeded;
                if (this.shareBaseFiles === false) {
                    await copyFileReflink(this.kernelPath, resolve(chrootRoot, "kernel.bin"));
                    await copyFileReflink(this.rootfsPath, resolve(chrootRoot, "rootfs.ext4"));
                } else if (this.shareRootfs === false) {
                    // 只共享内核/快照、不共享 rootfs 时，rootfs 仍是本 VM 私有的
                    // 可写盘：必须在 chown **之前**复制，否则它归 root 所有而
                    // Firecracker 以 VM uid 打开 O_RDWR → EACCES（真机实测）。
                    await copyFileReflink(this.rootfsPath, resolve(chrootRoot, "rootfs.ext4"));
                }
                this.tracePhase(options.id, "copy-disks", phaseAt);

                // 4. 分配 UID/GID 并 chown
                const { uid, gid } = this.uidAllocator.allocate(options.id);
                phaseAt = Date.now();
                const chownProc = Bun.spawn(["chown", "-R", `${uid}:${gid}`, chrootRoot]);
                await chownProc.exited;
                this.tracePhase(options.id, "chown-chroot", phaseAt);

                // 4.1 共享只读基础文件：硬链接（同 inode、零拷贝）。
                // 放在 chown 之后 → 模板与池内文件保持原属主；0444 保证
                // 降权后的 Firecracker 只能读，不能改（官方要求不可变）。
                if (this.shareBaseFiles) {
                    phaseAt = Date.now();
                    const kernelShare = await shareBaseFile(
                        this.kernelPath,
                        resolve(chrootRoot, "kernel.bin"),
                        { fallbackCopy: copyFileReflink },
                    );
                    let rootfsShare: ShareBaseFileOutcome = "copied";
                    if (this.shareRootfs) {
                        rootfsShare = await shareBaseFile(
                            this.rootfsPath,
                            resolve(chrootRoot, "rootfs.ext4"),
                            { fallbackCopy: copyFileReflink },
                        );
                    }
                    // 注意：RO 标志必须跟随"是否请求共享"，不能跟随链接结果。
                    // shareBaseFile 无论硬链接还是退化复制都会 chmod 0444，
                    // 而降权后的 Firecracker 对 is_read_only=false 的盘会以 O_RDWR
                    // 打开 → 0444 直接 EACCES（真机实测：Drive config error ...
                    // Permission denied /rootfs.ext4）。共享时以只读 virtio 盘挂载，
                    // 既避免多台 VM 写同一 inode，也保证打开方式与文件权限一致。
                    sharedRootfsReadOnly = this.shareRootfs;
                    this.tracePhase(options.id, "share-base", phaseAt);
                    this.traceShare(options.id, kernelShare, rootfsShare);
                }

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

                phaseAt = Date.now();
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
                phaseAt = Date.now();
                if (this.shareRootfs) {
                    await shareBaseFile(
                        this.rootfsPath,
                        dir.rootfsPath(),
                        { fallbackCopy: copyFileReflink },
                    );
                    sharedRootfsReadOnly = this.shareRootfs;
                } else {
                    await copyFileReflink(this.rootfsPath, dir.rootfsPath());
                }
                workspaceDiskSeeded = (await prepareWorkspaceDiskFromHost(workspaceTemplate, options.workspaceSeedPath, dir.workspaceDiskPath())).seeded;
                this.tracePhase(options.id, "copy-disks", phaseAt);

                const sockets = this.allocateSocketPaths(options.id);
                apiSocketOnHost = sockets.apiSocketPath;
                vsockUdsOnHost = sockets.vsockUdsPath;
                workspaceDiskHostPath = dir.workspaceDiskPath();

                kernelPathForApi = this.kernelPath;
                rootfsPathForApi = dir.rootfsPath();
                workspacePathForApi = dir.workspaceDiskPath();

                phaseAt = Date.now();
                spawnAtMs = phaseAt;
                proc = spawn(this.binaryPath, ["--api-sock", apiSocketOnHost], {
                    stdio: ["ignore", "pipe", "pipe"],
                    detached: false,
                });
            }

            this.processes.set(options.id, proc);
            proc.stderr?.on("data", (chunk: Buffer | string) => {
                if (childStderr.length < 8192) childStderr += chunk.toString();
            });
            // spawnAt：jailer 与非 jailer 两条分支的 spawn 位置不同，只有其中一条会
            // 提前设好 spawnAtMs；这里兜底取"进程已建立"的时刻，保证 serial-first-line
            // 记的是"距离进程启动多久"，而不是一个没被赋值的 0（会打印出整个 epoch）。
            const spawnAt = spawnAtMs === 0 ? Date.now() : spawnAtMs;
            proc.stdout?.on("data", (chunk: Buffer | string) => {
                this.onSerialOutput(options.id, chunk, spawnAt);
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
            this.tracePhase(options.id, "spawn-process", phaseAt);
            const start = Date.now();
            phaseAt = start;
            while (!existsSync(apiSocketOnHost) && Date.now() - start < maxWaitMs) {
                if (proc.exitCode !== null || proc.signalCode !== null) break;
                await new Promise((r) => setTimeout(r, 20));
            }
            this.tracePhase(options.id, "api-socket-wait", phaseAt);
            phaseAt = Date.now();
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
            const canRestore = templateHash != null && workspaceDiskSeeded === false && this.snapshotManager.hasSnapshot(templateHash);

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
                    // jailer 降权后只能访问 chroot 内部：把快照放进 chroot。
                    const snapInChroot = resolve(chrootRootForVm, "restore.snap");
                    const memInChroot = resolve(chrootRootForVm, "restore.mem");
                    if (this.shareBaseFiles) {
                        // 硬链接共享：零拷贝，且池内文件被替换/删除也不影响
                        // 本 VM（硬链接持有 inode）。内存文件按官方要求只读。
                        await shareBaseFile(poolPaths.snapshotPath, snapInChroot, {
                            fallbackCopy: copyFileReflink,
                            mode: SHARED_BASE_FILE_MODE,
                        });
                        await shareBaseFile(poolPaths.memFilePath, memInChroot, {
                            fallbackCopy: copyFileReflink,
                            mode: SHARED_BASE_FILE_MODE,
                        });
                        this.tracePhase(options.id, "share-snapshot", phaseAt);
                    } else {
                        await copyFileReflink(poolPaths.snapshotPath, snapInChroot);
                        await copyFileReflink(poolPaths.memFilePath, memInChroot);
                        this.tracePhase(options.id, "copy-snapshot", phaseAt);
                    }
                    snapForApi = "/restore.snap";
                    memForApi = "/restore.mem";
                    phaseAt = Date.now();
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
                this.tracePhase(options.id, "snapshot-load", phaseAt);
                phaseAt = Date.now();
            } else {
                // 冷启动路径：完整配置再开机。
                await this.putSocket(apiSocketOnHost, "/boot-source", {
                    kernel_image_path: kernelPathForApi,
                    // 默认 quiet：内核逐行启动日志写 Firecracker stdout，宿主不消费，
                    // 纯浪费（真机冷启动 vsock-handshake 1.3s 里含内核启动+agent 就绪）。
                    // HARNESS_VM_BOOT_VERBOSE=1 可恢复完整日志用于排障。
                    boot_args: this.withExtraBootArgs(
                        this.verboseBoot
                            ? `${COLD_START_BOOT_ARGS} printk.time=1 loglevel=7 initcall_debug`
                            : `${COLD_START_BOOT_ARGS} quiet loglevel=3 printk.time=1`,
                    ),
                });

                await this.putSocket(apiSocketOnHost, "/drives/rootfs", {
                    drive_id: "rootfs",
                    path_on_host: rootfsPathForApi,
                    is_root_device: true,
                    // 共享 rootfs 是同一 inode 被多台 VM 共用：必须只读，
                    // 否则一台 VM 的写入会污染所有 VM 的根文件系统。
                    is_read_only: sharedRootfsReadOnly,
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
                this.tracePhase(options.id, "api-config-cold", phaseAt);
                phaseAt = Date.now();
            }

            // 8. 建立 vsock agent 连接并握手（带重试：等待 guest 内核启动 + socat 监听）
            const vsockBridge = new FirecrackerVsockBridge(vsockUdsOnHost, this.vsockPort, (phase) =>
                this.tracePhase(options.id, phase, phaseAt),
            );
            // 冷启动：短超时（300ms）+ 密重试（100ms）。握手本身亚毫秒级，
            // 缩短单次超时只是把"等一个注定失败的连接"从 1000ms 降到 300ms。
            await vsockBridge.connectWithRetry(20000, 50, 300);
            this.tracePhase(options.id, "vsock-handshake", phaseAt);
            phaseAt = Date.now();
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
            // reusedSnapshot：本 VM 没做快照，只是在闸门里等到别人做好后复用（在 if 外声明，
            // 因为后面的 make-snapshot 埋点要按它决定记不记时）。埋点必须区分“真的写了
            // 256MB 内存镜像”和“只是等闸门”，否则并发冷启动看起来像每台都在写快照。
            let reusedSnapshot = false;
            if (this.snapshotsEnabled && canRestore === false && workspaceDiskSeeded === false && templateHash !== null) {
                // madeByThisVm：本 VM 是否真的执行了 pause/create（决定要不要重连 vsock）
                let madeByThisVm = false;
                try {
                    await this.snapshotGate.runExclusive(templateHash, async () => {
                        // 等到闸门时，先复查：可能前一台已经把快照做出来了。
                        // 此时直接复用，无需再 pause/resume（也就无需 vsock 重连）。
                        if (this.snapshotManager.hasSnapshot(templateHash)) {
                            reusedSnapshot = true;
                            this.tracePhase(options.id, "snapshot-reuse", phaseAt);
                            return;
                        }

                        // 快照先写 staging，成功后 rename 发布（见 publishStaging）：
                        // 绝不原地截断池内文件 —— 运行中的 VM 用硬链接映射着它。
                        const stagingDir = this.snapshotManager.createStagingDir(templateHash);
                        const stagingPaths = this.snapshotManager.stagingSnapshotPaths(stagingDir);
                        let snapForApi = stagingPaths.snapshotPath;
                        let memForApi = stagingPaths.memFilePath;
                        let snapInChroot: string | undefined;
                        let memInChroot: string | undefined;
                        if (chrootRootForVm !== undefined) {
                            snapInChroot = resolve(chrootRootForVm, "golden.snap");
                            memInChroot = resolve(chrootRootForVm, "golden.mem");
                            snapForApi = "/golden.snap";
                            memForApi = "/golden.mem";
                        }

                        let paused = false;
                        let published = false;
                        try {
                            await this.setVmState(apiSocketOnHost, "Paused");
                            paused = true;
                            await this.putSocket(apiSocketOnHost, "/snapshot/create", {
                                snapshot_type: this.snapshotType,
                                snapshot_path: snapForApi,
                                mem_file_path: memForApi,
                                sync_snapshot_files: this.snapshotSyncFiles,
                            }, "PUT", 60_000);
                            if (snapInChroot !== undefined && memInChroot !== undefined) {
                                // jailer 下 Firecracker 把快照写在 chroot 内（同一 /data 文件系统），
                                // 这里**硬链接**进 staging 即可：同 inode、零拷贝。用 cp 复制会让 512MB
                                // 内存镜像在 create 路径里多走一遍"读+写"（ext4 无 reflink，--reflink=auto
                                // 退化为全量拷贝）。跨设备时 shareBaseFile 自动退回复制。
                                await shareBaseFile(snapInChroot, stagingPaths.snapshotPath, {
                                    fallbackCopy: copyFileReflink,
                                    mode: SHARED_BASE_FILE_MODE,
                                });
                                await shareBaseFile(memInChroot, stagingPaths.memFilePath, {
                                    fallbackCopy: copyFileReflink,
                                    mode: SHARED_BASE_FILE_MODE,
                                });
                            }
                            this.snapshotManager.publishStaging(templateHash, stagingDir);
                            published = true;
                            madeByThisVm = true;
                            // sync_snapshot_files:false 时前台不等落盘：异步补一次 fsync，
                            // 让"宿主崩溃丢快照"的窗口尽量小，且不阻塞本次 create。
                            if (this.snapshotSyncFiles === false) {
                                void this.snapshotManager.fsyncPublished(templateHash).catch((fsyncErr) => {
                                    console.error(
                                        `[Firecracker] 后台 fsync 快照失败（template=${templateHash}）：`,
                                        fsyncErr,
                                    );
                                });
                            }
                        } finally {
                            if (published === false) {
                                this.snapshotManager.discardStaging(stagingDir);
                            }
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

            if (reusedSnapshot === false) {
                this.tracePhase(options.id, "make-snapshot", phaseAt);
            }
            this.tracePhase(options.id, "total", createStartedAt);
            return {
                id: options.id,
                driver: "firecracker",
                vmPid: proc.pid,
                guestCid,
                workspacePath: options.workspacePath,
                workspaceDiskHostPath,
                warmHit: canRestore,
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
