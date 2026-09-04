import { transitionHarnessInstance } from "../instances/harness-instance.ts";
import type { HarnessInstanceStore } from "../instances/harness-instance-store.ts";
import { finishRunAttempt } from "../runs/run-attempt.ts";
import type { RunAttemptStore } from "../runs/run-attempt-store.ts";
import type { SandboxProvider, SandboxRecord } from "./sandbox-provider.ts";
import type { SandboxStore } from "./sandbox-store.ts";

/**
 * Reconciles database state with execution environments left by a crashed
 * single-node service. Cleanup is a startup barrier: the scheduler must not
 * start new work while an old container may still be running.
 */
export class SandboxStartupReconciler {
    constructor(
        private readonly sandboxes: SandboxStore,
        private readonly provider: SandboxProvider,
        private readonly attempts: RunAttemptStore,
        private readonly instances: HarnessInstanceStore,
    ) {}

    async reconcile(): Promise<void> {
        const failures: string[] = [];
        for (const record of this.sandboxes.listUnsettled()) {
            try {
                await this.cleanup(record);
                this.markLost(record, "PROCESS_RESTART:遗留执行环境已回收");
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                this.markCleanupFailure(record, `STARTUP_CLEANUP_FAILED:${reason}`);
                failures.push(`${record.id}:${reason}`);
            }
        }
        if (failures.length > 0) {
            throw new Error(`Sandbox 启动对账失败，拒绝启动：${failures.join(";")}`);
        }
    }

    private async cleanup(record: SandboxRecord): Promise<void> {
        if (this.provider.cleanupStale === undefined) {
            throw new Error(`Provider ${record.provider} 不支持遗留环境清理`);
        }
        await this.provider.cleanupStale(record);
    }

    private markLost(record: SandboxRecord, reason: string): void {
        const timestamp = new Date().toISOString();
        this.sandboxes.update({
            ...record,
            status: "LOST",
            updatedAt: timestamp,
            failureReason: reason,
        }, record.status);
        this.convergeControlPlane(record, timestamp, reason);
    }

    private markCleanupFailure(record: SandboxRecord, reason: string): void {
        const timestamp = new Date().toISOString();
        this.sandboxes.update({
            ...record,
            // Keep it unsettled so every later start retries cleanup. Marking it
            // terminal here could allow the next start to ignore a live orphan.
            status: record.status,
            updatedAt: timestamp,
            failureReason: reason,
        }, record.status);
        this.convergeControlPlane(record, timestamp, reason);
    }

    private convergeControlPlane(
        record: SandboxRecord,
        timestamp: string,
        reason: string,
    ): void {
        const attempt = this.attempts.getBySandboxId(record.id);
        if (attempt?.status === "RUNNING") {
            this.attempts.update(
                finishRunAttempt(attempt, "INTERRUPTED", timestamp),
                attempt.status,
            );
        }
        const instance = this.instances.get(record.instanceId);
        if (instance?.actualState === "ACTIVE") {
            this.instances.update(
                transitionHarnessInstance(
                    instance,
                    "FAILED",
                    timestamp,
                    `SANDBOX_RECONCILE:${reason}`,
                ),
                instance.actualState,
            );
        }
    }
}
