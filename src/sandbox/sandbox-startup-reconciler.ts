import { finishRunAttempt } from "../runs/run-attempt.ts";
import type { RunAttemptStore } from "../runs/run-attempt-store.ts";
import type { SandboxProvider, SandboxRecord } from "./sandbox-provider.ts";
import type { SandboxStatus } from "./sandbox-provider.ts";
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
    ) {}

    async reconcile(): Promise<void> {
        const failures: string[] = [];
        for (const record of this.sandboxes.listUnsettled()) {
            try {
                await this.cleanup(record);
                this.markLost(record, "PROCESS_RESTART:遗留执行环境已回收");
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                failures.push(`${record.id}:${reason}`);
                // 记账本身失败（例如清理期间状态已被其它路径收敛导致乐观锁 CAS 失败）
                // 不应覆盖原始失败原因，也不应中断其余记录的对账。
                try {
                    this.markCleanupFailure(record, `STARTUP_CLEANUP_FAILED:${reason}`);
                } catch (bookkeepingError) {
                    const detail = bookkeepingError instanceof Error
                        ? bookkeepingError.message
                        : String(bookkeepingError);
                    failures.push(`${record.id}:记账失败:${detail}`);
                }
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
        const current = this.sandboxes.get(record.id) ?? record;
        if (isSettledSandboxStatus(current.status)) {
            // 清理期间状态已被别的路径收敛（真机上 Provider 在 terminate 里会把
            // ACTIVE 写成 TERMINATED）。此时再写 LOST 只会撞乐观锁 CAS，表现为
            // “Sandbox 状态已变化：<id>”并让整个启动对账失败，服务拒绝启动。
            this.convergeControlPlane(current, timestamp);
            return;
        }
        try {
            this.sandboxes.update({
                ...current,
                status: "LOST",
                updatedAt: timestamp,
                failureReason: reason,
            }, current.status);
        } catch (error) {
            // CAS 失败只说明状态在别处变过；重读一次，只要不再处于
            // PROVISIONING/ACTIVE 就算已收敛，不应阻塞启动。
            const latest = this.sandboxes.get(record.id);
            if (latest === null || isSettledSandboxStatus(latest.status)) {
                this.convergeControlPlane(latest ?? current, timestamp);
                return;
            }
            throw error;
        }
        this.convergeControlPlane(current, timestamp);
    }

    private markCleanupFailure(record: SandboxRecord, reason: string): void {
        const timestamp = new Date().toISOString();
        const current = this.sandboxes.get(record.id) ?? record;
        if (isSettledSandboxStatus(current.status)) {
            this.convergeControlPlane(current, timestamp);
            return;
        }
        this.sandboxes.update({
            ...current,
            // Keep it unsettled so every later start retries cleanup. Marking it
            // terminal here could allow the next start to ignore a live orphan.
            status: current.status,
            updatedAt: timestamp,
            failureReason: reason,
        }, current.status);
        this.convergeControlPlane(current, timestamp);
    }

    /** PROVISIONING / ACTIVE 之外的登记状态都算已收敛，无需启动对账再动它。 */


    private convergeControlPlane(
        record: SandboxRecord,
        timestamp: string,
    ): void {
        const attempt = this.attempts.getBySandboxId(record.id);
        if (attempt?.status === "RUNNING") {
            this.attempts.update(
                finishRunAttempt(attempt, "INTERRUPTED", timestamp),
                attempt.status,
            );
        }
    }
}

function isSettledSandboxStatus(status: SandboxStatus): boolean {
    return status === "TERMINATED" || status === "LOST" || status === "FAILED";
}
