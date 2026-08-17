import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { WorkspaceFileSnapshot } from "./workspace-snapshot.ts";

export interface RunArtifact extends WorkspaceFileSnapshot {
    readonly runId: string;
    readonly createdAt: string;
}

/** Immutable copies of the user-visible files produced by a terminal Run. */
export class RunArtifactStore {
    private readonly root: string;

    constructor(private readonly db: Database, rootPath: string) {
        this.root = resolve(rootPath);
    }

    async capture(
        runId: string,
        workspacePath: string,
        files: readonly WorkspaceFileSnapshot[],
    ): Promise<RunArtifact[]> {
        const captured: RunArtifact[] = [];
        for (const file of files) {
            const source = resolve(workspacePath, file.path);
            const destination = this.artifactPath(runId, file.path);
            // Defend against a TOCTOU symlink introduced after Workspace snapshotting.
            const info = await lstat(source).catch(() => null);
            if (info === null || !info.isFile() || info.isSymbolicLink() || info.size !== file.size) continue;
            const body = await readFile(source);
            if (createHash("sha256").update(body).digest("hex") !== file.hash) continue;
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            await writeFile(destination, body, { mode: 0o600, flag: "wx" }).catch((error: unknown) => {
                if (isAlreadyExists(error)) return;
                throw error;
            });
            const artifact: RunArtifact = { runId, ...file, createdAt: new Date().toISOString() };
            this.db.query<unknown, { runId: string; path: string; hash: string; size: number; createdAt: string }>(`
                INSERT INTO run_artifacts (run_id, path, hash, size, created_at)
                VALUES ($runId, $path, $hash, $size, $createdAt)
                ON CONFLICT(run_id, path) DO NOTHING;
            `).run(artifact);
            captured.push(artifact);
        }
        return captured;
    }

    list(runId: string): RunArtifact[] {
        return this.db.query<RunArtifact, { runId: string }>(`
            SELECT run_id AS runId, path, hash, size, created_at AS createdAt
            FROM run_artifacts WHERE run_id = $runId ORDER BY path ASC;
        `).all({ runId });
    }

    async read(runId: string, path: string): Promise<Uint8Array | null> {
        const listed = this.db.query<{ path: string }, { runId: string; path: string }>(`
            SELECT path FROM run_artifacts WHERE run_id = $runId AND path = $path;
        `).get({ runId, path });
        if (listed === null) return null;
        return await readFile(this.artifactPath(runId, path)).catch(() => null);
    }

    private artifactPath(runId: string, path: string): string {
        if (!/^[a-f0-9-]{36}$/i.test(runId) || path.length === 0) throw new Error("非法 Artifact 路径");
        const base = resolve(this.root, runId);
        const target = resolve(base, path);
        if (!target.startsWith(`${base}/`)) throw new Error("Artifact 路径越界");
        return target;
    }
}

function isAlreadyExists(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
