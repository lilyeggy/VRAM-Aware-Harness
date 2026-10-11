export type MicrovmDriverName = "mock" | "e2b" | "firecracker";

/**
 * 启动期孤儿回收的报告。驱动把明细交回调用方，由装配层决定如何告警，
 * 避免"回收失败"被静默吞掉（静默 = 宿主内存泄漏无感知）。
 */
export interface ReapOrphansReportLike {
    /** 成功回收（杀掉进程或确认进程已死并清理目录）的数量 */
    readonly reaped: number;
    /** 逐条明细，供日志与测试断言 */
    readonly details: readonly string[];
    /** 扫描到的 pidfile 总数 */
    readonly scanned: number;
}

export interface MicrovmInstance {
    readonly id: string;
    readonly driver: MicrovmDriverName;
    readonly vmPid?: number;
    readonly guestCid?: number;
    readonly ipAddress?: string;
    readonly workspacePath: string;
    /**
     * P1 修复：本 Run 工作区磁盘在宿主上的真实路径（由驱动创建并回传）。
     * jailer 模式下位于 chroot 内；Provider 终止时据此导出产物，
     * 不得自行推导路径（推导必然与驱动实际布局错位）。
     */
    readonly workspaceDiskHostPath?: string;
    readonly createdAt: string;
    /**
     * 本次 create 是否命中快照快速恢复路径（warm restore）。
     * 由驱动如实回传；Provider 写入 acquisition 供审计/可观测性使用。
     */
    readonly warmHit?: boolean;
}

export interface MicrovmCreateOptions {
    readonly id: string;
    readonly runId: string;
    readonly workspacePath: string;
    /**
     * 工作区磁盘模板（ext4 镜像）路径，用于覆盖驱动级配置。
     * 语义是"模板"：驱动会为每个 Run 复制独立副本，绝不会直接写模板本身。
     */
    readonly workspaceDiskTemplatePath?: string;
    readonly cpuCount?: number;
    readonly memoryMb?: number;
    readonly allowNetwork?: boolean;
    readonly environment?: Readonly<Record<string, string>>;
}

export interface MicrovmExecuteOptions {
    readonly workdir?: string;
    readonly timeoutMs?: number;
    readonly env?: Readonly<Record<string, string>>;
    readonly maxOutputBytes?: number;
    readonly onStdoutChunk?: (chunk: string) => void;
    readonly onStderrChunk?: (chunk: string) => void;
}

export interface MicrovmExecutionResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    /** guest agent 侧超时（SIGTERM→SIGKILL 双信号终止）；不得静默吞掉 */
    readonly timedOut?: boolean;
    /** 输出超过 maxOutputBytes 被截断；不得静默吞掉 */
    readonly truncated?: boolean;
}

export interface MicrovmDriver {
    readonly name: MicrovmDriverName;
    /**
     * P0 修复：驱动必须显式声明自己是否提供真实的硬件级隔离。
     * 桩/测试驱动（mock、未实现的 e2b）必须声明 false，
     * MicrovmSandboxProvider 据此决定 runtimeEvidence.verified 与
     * enforcement 声明，杜绝"假隔离被报告为已验证"。
     */
    readonly providesHardwareIsolation: boolean;
    create(options: MicrovmCreateOptions): Promise<MicrovmInstance>;
    execute(
        vmId: string,
        command: readonly string[],
        options?: MicrovmExecuteOptions,
    ): Promise<MicrovmExecutionResult>;
    terminate(vmId: string): Promise<void>;
    /**
     * P1 修复：停止 VM（杀 guest 进程、关执行通道）但保留运行目录与磁盘，
     * 供调用方在 VM 完全静止后安全导出工作区磁盘；
     * 之后再调 terminate() 做完整清理。terminate 必须在 stopVm 已调用时保持幂等。
     */
    stopVm?(vmId: string): Promise<void>;
    flushFilesystem?(vmId: string): Promise<void>;
    /**
     * P0 修复：回收孤儿 VM 进程。
     *
     * Harness 崩溃/被 kill 后，上一进程留下的 Firecracker 会继续占用宿主内存，
     * 而容量准入看不见它们 → 超卖 → 别人的 VM 被 OOM。驱动应利用 pidfile 与
     * `/proc` 验活，在启动阶段把这些进程杀掉。
     *
     * **必须在创建任何新 VM 之前调用**，否则新旧 VM 可能互相误杀。
     * 实现应做到：只杀"经 `/proc/<pid>/cmdline` 确认确为 Firecracker"的进程，
     * 绝不盲杀 pid（pid 可能已被系统复用）。
     */
    reapOrphanVms?(options?: { readonly dryRun?: boolean }): Promise<ReapOrphansReportLike> | ReapOrphansReportLike;
    isAvailable(): Promise<boolean>;
}
