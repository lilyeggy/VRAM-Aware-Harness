import type { Database } from "bun:sqlite";
import type { SandboxRecord } from "./sandbox-provider.ts";
import type { SandboxRuntimeEvidence, SandboxSpec } from "./sandbox-profile.ts";

interface SandboxRow {
    id: string;
    runId: string;
    policySnapshotId: string;
    provider: string;
    profile: SandboxRecord["profile"];
    runtime: string;
    specJson: string;
    runtimeEvidenceJson: string;
    status: SandboxRecord["status"];
    workspacePath: string;
    secretNamesJson: string;
    createdAt: string;
    updatedAt: string;
    failureReason: string | null;
}

export class SandboxStore {
    constructor(private readonly db: Database) {}

    create(record: SandboxRecord): void {
        const parameters = {
            id: record.id,
            runId: record.runId,
            policySnapshotId: record.policySnapshotId,
            provider: record.provider,
            profile: record.profile,
            runtime: record.runtime,
            specJson: JSON.stringify(record.spec),
            runtimeEvidenceJson: JSON.stringify(record.runtimeEvidence),
            status: record.status,
            workspacePath: record.workspacePath,
            secretNamesJson: JSON.stringify(record.secretNames),
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            failureReason: record.failureReason,
        };
        this.db.query<unknown, typeof parameters>(`
            INSERT INTO sandboxes (
                id, run_id, policy_snapshot_id, provider,
                profile, runtime, spec_json, runtime_evidence_json,
                status, workspace_path, secret_names_json,
                created_at, updated_at, failure_reason
            ) VALUES (
                $id, $runId, $policySnapshotId, $provider,
                $profile, $runtime, $specJson, $runtimeEvidenceJson,
                $status, $workspacePath, $secretNamesJson,
                $createdAt, $updatedAt, $failureReason
            );
        `).run(parameters);
    }

    update(record: SandboxRecord, previousStatus: string): void {
        const parameters = {
            id: record.id,
            status: record.status,
            updatedAt: record.updatedAt,
            failureReason: record.failureReason,
            previousStatus,
            runtimeEvidenceJson: JSON.stringify(record.runtimeEvidence),
        };
        const result = this.db.query<unknown, typeof parameters>(`
            UPDATE sandboxes SET status = $status,
                updated_at = $updatedAt, failure_reason = $failureReason,
                runtime_evidence_json = $runtimeEvidenceJson
            WHERE id = $id AND status = $previousStatus;
        `).run(parameters);
        if (result.changes !== 1) {
            throw new Error(`Sandbox 状态已变化：${record.id}`);
        }
    }

    get(id: string): SandboxRecord | null {
        const row = this.db.query<SandboxRow, { id: string }>(`
            SELECT id, run_id AS runId,
                policy_snapshot_id AS policySnapshotId, provider,
                profile, runtime, spec_json AS specJson,
                runtime_evidence_json AS runtimeEvidenceJson,
                status, workspace_path AS workspacePath,
                secret_names_json AS secretNamesJson,
                created_at AS createdAt, updated_at AS updatedAt,
                failure_reason AS failureReason
            FROM sandboxes WHERE id = $id;
        `).get({ id });
        return row === null ? null : mapSandboxRow(row);
    }

    listUnsettled(): SandboxRecord[] {
        // 单条查询直接取全列：旧实现先查 id 再逐个 get，每个 record
        // 两次 SQL 往返，启动对账时是 N+1。
        const rows = this.db.query<SandboxRow, []>(`
            SELECT id, run_id AS runId,
                policy_snapshot_id AS policySnapshotId, provider,
                profile, runtime, spec_json AS specJson,
                runtime_evidence_json AS runtimeEvidenceJson,
                status, workspace_path AS workspacePath,
                secret_names_json AS secretNamesJson,
                created_at AS createdAt, updated_at AS updatedAt,
                failure_reason AS failureReason
            FROM sandboxes
            WHERE status IN ('PROVISIONING', 'ACTIVE')
            ORDER BY created_at ASC, id ASC;
        `).all();
        return rows.map(mapSandboxRow);
    }
}

function mapSandboxRow(row: SandboxRow): SandboxRecord {
    return {
        id: row.id,
        runId: row.runId,
        policySnapshotId: row.policySnapshotId,
        provider: row.provider,
        profile: row.profile,
        runtime: row.runtime,
        spec: JSON.parse(row.specJson) as SandboxSpec,
        runtimeEvidence: JSON.parse(row.runtimeEvidenceJson) as SandboxRuntimeEvidence,
        status: row.status,
        workspacePath: row.workspacePath,
        secretNames: Object.freeze(JSON.parse(row.secretNamesJson) as string[]),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        failureReason: row.failureReason,
    };
}
