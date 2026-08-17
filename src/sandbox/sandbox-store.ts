import type { Database } from "bun:sqlite";
import type { SandboxRecord } from "./sandbox-provider.ts";

interface SandboxRow extends Omit<SandboxRecord, "secretNames"> {
    secretNamesJson: string;
}

export class SandboxStore {
    constructor(private readonly db: Database) {}

    create(record: SandboxRecord): void {
        const parameters = {
            ...record,
            secretNamesJson: JSON.stringify(record.secretNames),
        };
        const {
            secretNames: _secretNames,
            ...bindings
        } = parameters;
        this.db.query<unknown, typeof bindings>(`
            INSERT INTO sandboxes (
                id, instance_id, run_id, policy_snapshot_id, provider,
                status, workspace_path, secret_names_json,
                created_at, updated_at, failure_reason
            ) VALUES (
                $id, $instanceId, $runId, $policySnapshotId, $provider,
                $status, $workspacePath, $secretNamesJson,
                $createdAt, $updatedAt, $failureReason
            );
        `).run(bindings);
    }

    update(record: SandboxRecord, previousStatus: string): void {
        const parameters = {
            id: record.id,
            status: record.status,
            updatedAt: record.updatedAt,
            failureReason: record.failureReason,
            previousStatus,
        };
        const result = this.db.query<unknown, typeof parameters>(`
            UPDATE sandboxes SET status = $status,
                updated_at = $updatedAt, failure_reason = $failureReason
            WHERE id = $id AND status = $previousStatus;
        `).run(parameters);
        if (result.changes !== 1) {
            throw new Error(`Sandbox 状态已变化：${record.id}`);
        }
    }

    get(id: string): SandboxRecord | null {
        const row = this.db.query<SandboxRow, { id: string }>(`
            SELECT id, instance_id AS instanceId, run_id AS runId,
                policy_snapshot_id AS policySnapshotId, provider, status,
                workspace_path AS workspacePath,
                secret_names_json AS secretNamesJson,
                created_at AS createdAt, updated_at AS updatedAt,
                failure_reason AS failureReason
            FROM sandboxes WHERE id = $id;
        `).get({ id });
        return row === null ? null : {
            id: row.id,
            instanceId: row.instanceId,
            runId: row.runId,
            policySnapshotId: row.policySnapshotId,
            provider: row.provider,
            status: row.status,
            workspacePath: row.workspacePath,
            secretNames: Object.freeze(JSON.parse(row.secretNamesJson) as string[]),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            failureReason: row.failureReason,
        };
    }
}
