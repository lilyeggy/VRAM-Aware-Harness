import type { Database } from "bun:sqlite";
import type { WorkspaceDiff, WorkspaceFileSnapshot } from "./workspace-snapshot.ts";

export type WorkspaceSnapshotPhase = "BEFORE" | "AFTER";

interface SnapshotRow {
    manifestJson: string;
}

interface DiffRow {
    diffJson: string;
}

/** SQLite boundary for the user-visible, post-run Workspace evidence. */
export class RunWorkspaceResultStore {
    constructor(private readonly db: Database) {}

    saveSnapshot(
        runId: string,
        phase: WorkspaceSnapshotPhase,
        manifest: readonly WorkspaceFileSnapshot[],
    ): void {
        this.db.query<unknown, {
            runId: string; phase: WorkspaceSnapshotPhase; manifestJson: string; capturedAt: string;
        }>(`
            INSERT INTO run_workspace_snapshots (run_id, phase, manifest_json, captured_at)
            VALUES ($runId, $phase, $manifestJson, $capturedAt)
            ON CONFLICT(run_id, phase) DO UPDATE SET
                manifest_json = excluded.manifest_json,
                captured_at = excluded.captured_at;
        `).run({ runId, phase, manifestJson: JSON.stringify(manifest), capturedAt: new Date().toISOString() });
    }

    getSnapshot(runId: string, phase: WorkspaceSnapshotPhase): WorkspaceFileSnapshot[] | null {
        const row = this.db.query<SnapshotRow, { runId: string; phase: WorkspaceSnapshotPhase }>(`
            SELECT manifest_json AS manifestJson FROM run_workspace_snapshots
            WHERE run_id = $runId AND phase = $phase;
        `).get({ runId, phase });
        return row === null ? null : parseSnapshot(row.manifestJson);
    }

    saveDiff(runId: string, diff: WorkspaceDiff): void {
        this.db.query<unknown, { runId: string; diffJson: string; createdAt: string }>(`
            INSERT INTO run_workspace_diffs (run_id, diff_json, created_at)
            VALUES ($runId, $diffJson, $createdAt)
            ON CONFLICT(run_id) DO UPDATE SET
                diff_json = excluded.diff_json,
                created_at = excluded.created_at;
        `).run({ runId, diffJson: JSON.stringify(diff), createdAt: new Date().toISOString() });
    }

    getDiff(runId: string): WorkspaceDiff | null {
        const row = this.db.query<DiffRow, { runId: string }>(`
            SELECT diff_json AS diffJson FROM run_workspace_diffs WHERE run_id = $runId;
        `).get({ runId });
        return row === null ? null : parseDiff(row.diffJson);
    }
}

function parseSnapshot(value: string): WorkspaceFileSnapshot[] {
    return JSON.parse(value) as WorkspaceFileSnapshot[];
}

function parseDiff(value: string): WorkspaceDiff {
    return JSON.parse(value) as WorkspaceDiff;
}
