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
    ) {}

    async recover(): Promise<void> {
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
