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

export interface WorkspaceSnapshotOptions {
    /** F9：最多扫描的文件数，超过即 fail-closed，避免生成不完整 Diff。 */
    readonly maxFiles?: number;
    /** F9：最大递归深度，超过即 fail-closed。 */
    readonly maxDepth?: number;
}

export class WorkspaceSnapshotLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkspaceSnapshotLimitError";
    }
}

export const DEFAULT_WORKSPACE_SNAPSHOT_MAX_FILES = 20_000;
export const DEFAULT_WORKSPACE_SNAPSHOT_MAX_DEPTH = 32;

const ignored = new Set([".git", "node_modules", ".DS_Store"]);

/** A deterministic, bounded file manifest for user-visible Run results. */
export async function snapshotWorkspace(
    rootPath: string,
    options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceFileSnapshot[]> {
    const maxFiles = options.maxFiles ?? DEFAULT_WORKSPACE_SNAPSHOT_MAX_FILES;
    const maxDepth = options.maxDepth ?? DEFAULT_WORKSPACE_SNAPSHOT_MAX_DEPTH;
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
    async function visit(directory: string, depth: number): Promise<void> {
        if (depth > maxDepth) {
            throw new WorkspaceSnapshotLimitError(
                `Workspace 目录深度超过快照上限 ${maxDepth}，拒绝生成不完整 Diff；`
                + "请清理 workspace 或调大 HARNESS_WORKSPACE_SNAPSHOT_MAX_DEPTH。",
            );
        }
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
            if (entry.isDirectory()) { await visit(absolute, depth + 1); continue; }
            if (entry.isFile() === false) continue;
            if (files.length >= maxFiles) {
                throw new WorkspaceSnapshotLimitError(
                    `Workspace 文件数超过快照上限 ${maxFiles}，拒绝生成不完整 Diff；`
                    + "请清理 workspace 或调大 HARNESS_WORKSPACE_SNAPSHOT_MAX_FILES。",
                );
            }
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
    await visit(root, 0);
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
