import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface WorkspaceFileSnapshot {
    readonly path: string;
    readonly hash: string;
    readonly size: number;
}

export interface WorkspaceDiff {
    readonly added: readonly WorkspaceFileSnapshot[];
    readonly modified: readonly { before: WorkspaceFileSnapshot; after: WorkspaceFileSnapshot }[];
    readonly deleted: readonly WorkspaceFileSnapshot[];
}

const ignored = new Set([".git", "node_modules", ".DS_Store"]);

/** A deterministic, bounded file manifest for user-visible Run results. */
export async function snapshotWorkspace(rootPath: string): Promise<WorkspaceFileSnapshot[]> {
    const root = resolve(rootPath);
    const files: WorkspaceFileSnapshot[] = [];
    // A Workspace may have been removed by cleanup while a Run is being
    // finalized. Treat that as an empty manifest so the result becomes a
    // meaningful "deleted" Diff instead of preventing scheduler convergence.
    try {
        const rootInfo = await stat(root);
        if (!rootInfo.isDirectory()) return files;
    } catch (error) {
        if (isMissingPath(error)) return files;
        throw error;
    }
    async function visit(directory: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (isMissingPath(error)) return;
            throw error;
        }
        for (const entry of entries) {
            if (ignored.has(entry.name)) continue;
            const absolute = join(directory, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) { await visit(absolute); continue; }
            if (!entry.isFile()) continue;
            const info = await stat(absolute);
            if (info.size > 2 * 1024 * 1024) continue;
            const body = await readFile(absolute);
            files.push({
                path: relative(root, absolute).replaceAll("\\", "/"),
                hash: createHash("sha256").update(body).digest("hex"),
                size: info.size,
            });
        }
    }
    await visit(root);
    return files.sort((left, right) => left.path.localeCompare(right.path));
}

function isMissingPath(error: unknown): boolean {
    return typeof error === "object" && error !== null
        && "code" in error && error.code === "ENOENT";
}

export function diffWorkspace(
    before: readonly WorkspaceFileSnapshot[],
    after: readonly WorkspaceFileSnapshot[],
): WorkspaceDiff {
    const oldFiles = new Map(before.map((file) => [file.path, file]));
    const newFiles = new Map(after.map((file) => [file.path, file]));
    const added = after.filter((file) => !oldFiles.has(file.path));
    const deleted = before.filter((file) => !newFiles.has(file.path));
    const modified = after.flatMap((file) => {
        const old = oldFiles.get(file.path);
        return old !== undefined && old.hash !== file.hash ? [{ before: old, after: file }] : [];
    });
    return { added, modified, deleted };
}
