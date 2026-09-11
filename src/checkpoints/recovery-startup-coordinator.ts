import type {
    RecoveryExecutionResult,
    RecoveryExecutor,
} from "./recovery-executor.ts";
import type {
    RecoveryService,
} from "./recovery-service.ts";

export interface QueuedRunRestorer {
    restore():void;
}

export interface StartupSandboxReconciler {
    reconcile(): Promise<void>;
}

/**
 * N19：启动时清理实例槽位残留。返回被修正的实例，供启动日志交代。
 */
export interface StartupInstanceSlotReconciler {
    reconcileStaleSlotsForStartup(): readonly unknown[];
}

/**
 * 把启动扫描和恢复任务入队串成 HarnessApplication 的启动恢复步骤。
 *
 * 这里不直接 drain：HarnessApplication 会在 recover 完成后启动 QueuePump，
 * 由 Pump 使用与普通提交相同的资源准入和调度路径推进恢复任务。
 */
export class RecoveryStartupCoordinator {
    private lastResults: readonly RecoveryExecutionResult[] = [];

    constructor(
        private readonly recoveryService:
            Pick<RecoveryService, "scanInterruptedRuns">,
        private readonly recoveryExecutor:
            Pick<RecoveryExecutor, "execute">,
        private readonly queuedRunRestorer:QueuedRunRestorer,
        private readonly sandboxReconciler?: StartupSandboxReconciler,
        /**
         * N19：必须**早于**任何恢复执行调用。上次进程执行中被杀会把实例留在
         * `FAILED + active_run_count=1`，而 FAILED 的实例再也拿不到槽位——
         * 不清掉这个残留，下面 `execute()` 里每个恢复任务都会撞
         * INSTANCE_NOT_READY 活锁，而且每次尝试都泄漏一个沙箱。
         */
        private readonly instanceSlotReconciler?: StartupInstanceSlotReconciler,
    ) {}

    async recover(): Promise<void> {
        // N19：先修上次进程留下的实例槽位残留，再放行任何恢复执行。
        const reconciled =
            this.instanceSlotReconciler?.reconcileStaleSlotsForStartup() ?? [];
        if (reconciled.length > 0) {
            console.warn(
                `[startup] N19 修正 ${reconciled.length} 个实例的槽位残留`
                + `（上次进程异常退出的遗留），已重置为可服务状态：`
                + reconciled.map((item) => JSON.stringify(item)).join("; "),
            );
        }

        // 必须先停止旧进程可能遗留的执行环境，再允许恢复任务重新入队。
        await this.sandboxReconciler?.reconcile();
        // 先恢复旧的 QUEUED Run；随后扫描产生的新恢复任务会由
        // RecoveryExecutor 直接加入同一个 Scheduler，不会重复恢复。
        this.queuedRunRestorer.restore();

        const plans = this.recoveryService.scanInterruptedRuns();

        this.lastResults = await this.recoveryExecutor.execute(plans);
    }

    getLastResults(): readonly RecoveryExecutionResult[] {
        return this.lastResults;
    }
}
