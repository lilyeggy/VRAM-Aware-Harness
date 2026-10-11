import type { Database } from "bun:sqlite";
import type { RunAttempt } from "./run-attempt.ts";

export class RunAttemptStore {
    constructor(private readonly db: Database) {}

    create(attempt: RunAttempt): void {
        const parameters = { ...attempt };
        this.db.query<unknown, typeof parameters>(`
            INSERT INTO run_attempts (
                id, run_id, attempt_number, kind,
                policy_snapshot_id, sandbox_id, status, created_at,
                started_at, finished_at, failure_reason,
                lease_owner, lease_expires_at, heartbeat_at
            ) VALUES (
                $id, $runId, $attemptNumber, $kind,
                $policySnapshotId, $sandboxId, $status, $createdAt,
                $startedAt, $finishedAt, $failureReason,
                $leaseOwner, $leaseExpiresAt, $heartbeatAt
            );
        `).run(parameters);
    }

    update(attempt: RunAttempt, previousStatus: string): void {
        const parameters = { ...attempt, previousStatus };
        const result = this.db.query<unknown, typeof parameters>(`
            UPDATE run_attempts SET
                policy_snapshot_id = $policySnapshotId,
                sandbox_id = $sandboxId,
                status = $status,
                started_at = $startedAt,
                finished_at = $finishedAt,
                failure_reason = $failureReason,
                lease_owner = $leaseOwner,
                lease_expires_at = $leaseExpiresAt,
                heartbeat_at = $heartbeatAt
            WHERE id = $id AND status = $previousStatus;
        `).run(parameters);
        if (result.changes !== 1) {
            throw new Error(`RunAttempt 状态已变化：${attempt.id}`);
        }
    }

    get(id: string): RunAttempt | null {
        return this.queryOne("id = $value", id);
    }

    listForRun(runId: string): RunAttempt[] {
        return this.db.query<RunAttempt, { runId: string }>(`
            ${attemptSelect}
            WHERE run_id = $runId
            ORDER BY attempt_number ASC;
        `).all({ runId });
    }

    getBySandboxId(sandboxId: string): RunAttempt | null {
        return this.queryOne("sandbox_id = $value", sandboxId);
    }

    /**
     * §9.8 v1.4 Phase 2：列出 RUNNING 且租约已过期的 Attempt。
     */
    listExpiredLeases(nowIso: string): RunAttempt[] {
        return this.db.query<RunAttempt, { nowIso: string }>(`
            ${attemptSelect}
            WHERE status = 'RUNNING'
              AND lease_owner IS NOT NULL
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at < $nowIso
            ORDER BY lease_expires_at ASC;
        `).all({ nowIso });
    }

    nextAttemptNumber(runId: string): number {
        const row = this.db.query<{ nextNumber: number }, { runId: string }>(`
            SELECT COALESCE(MAX(attempt_number), 0) + 1 AS nextNumber
            FROM run_attempts WHERE run_id = $runId;
        `).get({ runId });
        return row?.nextNumber ?? 1;
    }

    private queryOne(condition: string, value: string): RunAttempt | null {
        return this.db.query<RunAttempt, { value: string }>(`
            ${attemptSelect} WHERE ${condition};
        `).get({ value });
    }
}

const attemptSelect = `
    SELECT id, run_id AS runId, attempt_number AS attemptNumber,
        kind,
        policy_snapshot_id AS policySnapshotId,
        sandbox_id AS sandboxId, status,
        created_at AS createdAt, started_at AS startedAt,
        finished_at AS finishedAt, failure_reason AS failureReason,
        lease_owner AS leaseOwner,
        lease_expires_at AS leaseExpiresAt,
        heartbeat_at AS heartbeatAt
    FROM run_attempts
`;
