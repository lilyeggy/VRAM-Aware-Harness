import { diffWorkspace, snapshotWorkspace, type WorkspaceDiff, type WorkspaceFileSnapshot } from "./workspace-snapshot.ts";
import type { RunWorkspaceResultStore } from "./run-workspace-result-store.ts";
import type { RunArtifact, RunArtifactStore } from "./run-artifact-store.ts";

/** Captures a bounded before/after manifest and makes its user result durable. */
export class RunWorkspaceResultCoordinator {
    private readonly beforeByRun = new Map<string, readonly WorkspaceFileSnapshot[]>();

    constructor(
        private readonly store?: RunWorkspaceResultStore,
        private readonly artifacts?: RunArtifactStore,
    ) {}

    async captureBefore(runId: string, workspacePath: string): Promise<void> {
        const before = await snapshotWorkspace(workspacePath);
        this.beforeByRun.set(runId, before);
        this.store?.saveSnapshot(runId, "BEFORE", before);
    }

    async captureAfter(runId: string, workspacePath: string): Promise<WorkspaceDiff | null> {
        const before = this.beforeByRun.get(runId) ?? this.store?.getSnapshot(runId, "BEFORE");
        this.beforeByRun.delete(runId);
        if (before === undefined || before === null) return null;
        const after = await snapshotWorkspace(workspacePath);
        const diff = diffWorkspace(before, after);
        this.store?.saveSnapshot(runId, "AFTER", after);
        this.store?.saveDiff(runId, diff);
        return diff;
    }

    getDiff(runId: string): WorkspaceDiff | null { return this.store?.getDiff(runId) ?? null; }

    async captureArtifacts(runId: string, workspacePath: string): Promise<RunArtifact[]> {
        const diff = this.getDiff(runId);
        if (diff === null || this.artifacts === undefined) return [];
        return this.artifacts.capture(runId, workspacePath, [
            ...diff.added,
            ...diff.modified.map((item) => item.after),
        ]);
    }

    listArtifacts(runId: string): RunArtifact[] { return this.artifacts?.list(runId) ?? []; }
    readArtifact(runId: string, path: string): Promise<Uint8Array | null> {
        return this.artifacts?.read(runId, path) ?? Promise.resolve(null);
    }
}
