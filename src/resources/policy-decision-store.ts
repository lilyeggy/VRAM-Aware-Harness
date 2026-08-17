import type { Database } from "bun:sqlite";

import type {
    PolicyDecision,
} from "./execution-policy.ts";
import type {
    ResourceObservationSource,
    ResourceSnapshot,
} from "./resource-observer.ts";

interface ResourceSnapshotRow {
    snapshotId: string;
    observedAt: string;
    sourcesJson: string;
    gpuTotalMemoryMiB: number | null;
    gpuUsedMemoryMiB: number | null;
    gpuFreeMemoryMiB: number | null;
    gpuUtilizationPercent: number | null;
    runningRequests: number | null;
    waitingRequests: number | null;
    kvCacheUsagePercent: number | null;
    inputTokensPerSecond: number | null;
    outputTokensPerSecond: number | null;
}

/**
 * ResourceAdmissionService 只依赖这个最小写入协议。
 * 测试可以提供内存 Fake，真实运行时由 PolicyDecisionStore 实现。
 */
export interface PolicyDecisionRecorder {
    save(
        decision: PolicyDecision,
        snapshot: ResourceSnapshot | null,
    ): void;
}

/**
 * PolicyDecisionStore 是资源准入决策与 SQLite 之间的持久化边界。
 *
 * 它不负责观测资源、资源分类或 START/QUEUE 判断，只负责保证：
 * - 成功观测的 Snapshot 与 Decision 一起保存；
 * - 观测失败的 Decision 明确保存失败原因，不伪造 Snapshot；
 * - 一个 Run 的多次决策按时间保留，供排队和审计查询使用。
 */
export class PolicyDecisionStore
implements PolicyDecisionRecorder {
    constructor(private readonly db: Database) {}

    save(
        decision: PolicyDecision,
        snapshot: ResourceSnapshot | null,
    ): void {
        this.assertEvidenceMatchesDecision(decision, snapshot);

        const saveTransaction = this.db.transaction(() => {
            if (snapshot !== null) {
                this.saveImmutableSnapshot(snapshot);
            }

            const parameters = {
                decisionId: decision.decisionId,
                runId: decision.runId,
                action: decision.action,
                reasonCode: decision.reasonCode,
                resourceSnapshotId:
                    decision.resourceSnapshotId,
                pressure: decision.pressure,
                observationFailureReason:
                    decision.observationFailureReason,
                decidedAt: decision.decidedAt,
            };

            this.db
                .query<unknown, typeof parameters>(`
                    INSERT INTO policy_decisions (
                        decision_id,
                        run_id,
                        action,
                        reason_code,
                        resource_snapshot_id,
                        pressure,
                        observation_failure_reason,
                        decided_at
                    )
                    VALUES (
                        $decisionId,
                        $runId,
                        $action,
                        $reasonCode,
                        $resourceSnapshotId,
                        $pressure,
                        $observationFailureReason,
                        $decidedAt
                    );
                `)
                .run(parameters);
        });

        saveTransaction();
    }

    get(decisionId: string): PolicyDecision | null {
        return this.db
            .query<PolicyDecision, { decisionId: string }>(`
                SELECT
                    decision_id AS decisionId,
                    run_id AS runId,
                    action,
                    reason_code AS reasonCode,
                    resource_snapshot_id AS resourceSnapshotId,
                    pressure,
                    observation_failure_reason
                        AS observationFailureReason,
                    decided_at AS decidedAt
                FROM policy_decisions
                WHERE decision_id = $decisionId;
            `)
            .get({ decisionId });
    }

    /**
     * 返回一个 Run 的完整准入历史，而不是只返回最后一次决定。
     * decided_at 相同时使用 rowid 保证结果顺序稳定。
     */
    listForRun(runId: string): PolicyDecision[] {
        return this.db
            .query<PolicyDecision, { runId: string }>(`
                SELECT
                    decision_id AS decisionId,
                    run_id AS runId,
                    action,
                    reason_code AS reasonCode,
                    resource_snapshot_id AS resourceSnapshotId,
                    pressure,
                    observation_failure_reason
                        AS observationFailureReason,
                    decided_at AS decidedAt
                FROM policy_decisions
                WHERE run_id = $runId
                ORDER BY decided_at ASC, rowid ASC;
            `)
            .all({ runId });
    }

    getSnapshot(snapshotId: string): ResourceSnapshot | null {
        const row = this.db
            .query<ResourceSnapshotRow, { snapshotId: string }>(`
                SELECT
                    snapshot_id AS snapshotId,
                    observed_at AS observedAt,
                    sources_json AS sourcesJson,
                    gpu_total_memory_mib AS gpuTotalMemoryMiB,
                    gpu_used_memory_mib AS gpuUsedMemoryMiB,
                    gpu_free_memory_mib AS gpuFreeMemoryMiB,
                    gpu_utilization_percent AS gpuUtilizationPercent,
                    running_requests AS runningRequests,
                    waiting_requests AS waitingRequests,
                    kv_cache_usage_percent AS kvCacheUsagePercent,
                    input_tokens_per_second AS inputTokensPerSecond,
                    output_tokens_per_second AS outputTokensPerSecond
                FROM resource_snapshots
                WHERE snapshot_id = $snapshotId;
            `)
            .get({ snapshotId });

        return row === null ? null : this.snapshotFromRow(row);
    }

    private saveImmutableSnapshot(snapshot: ResourceSnapshot): void {
        const existing = this.getSnapshot(snapshot.snapshotId);

        if (existing !== null) {
            if (
                this.canonicalSnapshot(existing)
                !== this.canonicalSnapshot(snapshot)
            ) {
                throw new Error(
                    `ResourceSnapshot ID 对应不同内容：${snapshot.snapshotId}`,
                );
            }

            return;
        }

        const parameters = {
            snapshotId: snapshot.snapshotId,
            observedAt: snapshot.observedAt,
            sourcesJson: JSON.stringify(snapshot.sources),
            gpuTotalMemoryMiB: snapshot.gpuTotalMemoryMiB,
            gpuUsedMemoryMiB: snapshot.gpuUsedMemoryMiB,
            gpuFreeMemoryMiB: snapshot.gpuFreeMemoryMiB,
            gpuUtilizationPercent:
                snapshot.gpuUtilizationPercent,
            runningRequests: snapshot.runningRequests,
            waitingRequests: snapshot.waitingRequests,
            kvCacheUsagePercent: snapshot.kvCacheUsagePercent,
            inputTokensPerSecond: snapshot.inputTokensPerSecond,
            outputTokensPerSecond: snapshot.outputTokensPerSecond,
        };

        this.db
            .query<unknown, typeof parameters>(`
                INSERT INTO resource_snapshots (
                    snapshot_id,
                    observed_at,
                    sources_json,
                    gpu_total_memory_mib,
                    gpu_used_memory_mib,
                    gpu_free_memory_mib,
                    gpu_utilization_percent,
                    running_requests,
                    waiting_requests,
                    kv_cache_usage_percent,
                    input_tokens_per_second,
                    output_tokens_per_second
                )
                VALUES (
                    $snapshotId,
                    $observedAt,
                    $sourcesJson,
                    $gpuTotalMemoryMiB,
                    $gpuUsedMemoryMiB,
                    $gpuFreeMemoryMiB,
                    $gpuUtilizationPercent,
                    $runningRequests,
                    $waitingRequests,
                    $kvCacheUsagePercent,
                    $inputTokensPerSecond,
                    $outputTokensPerSecond
                );
            `)
            .run(parameters);
    }

    private assertEvidenceMatchesDecision(
        decision: PolicyDecision,
        snapshot: ResourceSnapshot | null,
    ): void {
        const isObservationFailure =
            decision.reasonCode === "RESOURCE_OBSERVATION_FAILED";

        if (isObservationFailure) {
            if (
                snapshot !== null
                || decision.resourceSnapshotId !== null
                || decision.observationFailureReason === null
                || decision.action !== "QUEUE"
                || decision.pressure !== "UNKNOWN"
            ) {
                throw new Error(
                    "观测失败决策必须 QUEUE，且只能携带失败原因",
                );
            }

            return;
        }

        if (
            snapshot === null
            || decision.resourceSnapshotId !== snapshot.snapshotId
            || decision.observationFailureReason !== null
        ) {
            throw new Error(
                "成功观测决策必须引用与 Decision 匹配的 Snapshot",
            );
        }
    }

    private snapshotFromRow(
        row: ResourceSnapshotRow,
    ): ResourceSnapshot {
        return {
            snapshotId: row.snapshotId,
            observedAt: row.observedAt,
            sources: JSON.parse(
                row.sourcesJson,
            ) as ResourceObservationSource[],
            gpuTotalMemoryMiB: row.gpuTotalMemoryMiB,
            gpuUsedMemoryMiB: row.gpuUsedMemoryMiB,
            gpuFreeMemoryMiB: row.gpuFreeMemoryMiB,
            gpuUtilizationPercent: row.gpuUtilizationPercent,
            runningRequests: row.runningRequests,
            waitingRequests: row.waitingRequests,
            kvCacheUsagePercent: row.kvCacheUsagePercent,
            inputTokensPerSecond: row.inputTokensPerSecond,
            outputTokensPerSecond: row.outputTokensPerSecond,
        };
    }

    private canonicalSnapshot(snapshot: ResourceSnapshot): string {
        return JSON.stringify({
            snapshotId: snapshot.snapshotId,
            observedAt: snapshot.observedAt,
            sources: [...snapshot.sources],
            gpuTotalMemoryMiB: snapshot.gpuTotalMemoryMiB,
            gpuUsedMemoryMiB: snapshot.gpuUsedMemoryMiB,
            gpuFreeMemoryMiB: snapshot.gpuFreeMemoryMiB,
            gpuUtilizationPercent:
                snapshot.gpuUtilizationPercent,
            runningRequests: snapshot.runningRequests,
            waitingRequests: snapshot.waitingRequests,
            kvCacheUsagePercent: snapshot.kvCacheUsagePercent,
            inputTokensPerSecond: snapshot.inputTokensPerSecond,
            outputTokensPerSecond: snapshot.outputTokensPerSecond,
        });
    }
}
