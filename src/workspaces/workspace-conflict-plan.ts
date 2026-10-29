import { isAbsolute, posix } from "node:path";
import type { WorkspaceCaptureEntry, WorkspaceCaptureManifest } from "./workspace-capture-store.ts";

export interface WorkspaceConflictPlan {
    readonly changes: readonly string[];
    readonly conflicts: readonly string[];
}

/**
 * Compare a run's baseline and result with the current Workspace. This is only
 * a plan: the caller must hold a Workspace-wide writer lock throughout the
 * current capture, validation and publication, and must publish all or none.
 */
export function planWorkspaceChanges(
    baseline: WorkspaceCaptureManifest,
    result: WorkspaceCaptureManifest,
    current: WorkspaceCaptureManifest,
): WorkspaceConflictPlan {
    if (baseline.kind !== "baseline" || result.kind !== "result"
        || baseline.userId !== result.userId || baseline.workspaceId !== result.workspaceId
        || baseline.attemptId !== result.attemptId || baseline.userId !== current.userId
        || baseline.workspaceId !== current.workspaceId) {
        throw new Error("Workspace captures do not belong to the same execution and Workspace");
    }
    const toMap = (manifest: WorkspaceCaptureManifest) => {
        const map = new Map<string, WorkspaceCaptureEntry>();
        for (const entry of manifest.entries) {
            const path = entry.path;
            if (!path || isAbsolute(path) || path.includes("\\") || posix.normalize(path) !== path
                || path === ".." || path.startsWith("../") || map.has(path)) {
                throw new Error(`Invalid Workspace capture path: ${path}`);
            }
            map.set(path, entry);
        }
        return map;
    };
    const before = toMap(baseline);
    const after = toMap(result);
    const now = toMap(current);
    const equal = (a: WorkspaceCaptureEntry | undefined, b: WorkspaceCaptureEntry | undefined) => {
        if (a === undefined || b === undefined) return a === b;
        if (a.kind !== b.kind || a.mode !== b.mode) return false;
        return a.kind === "directory" || (b.kind === "file" && a.size === b.size && a.hash === b.hash);
    };
    const changes = [...new Set([...before.keys(), ...after.keys()])]
        .filter((path) => !equal(before.get(path), after.get(path))).sort();
    const conflicts = new Set<string>();
    for (const path of changes) {
        const base = before.get(path);
        const target = after.get(path);
        const live = now.get(path);
        // Two independent additions under the same newly created directory can coexist.
        const sameNewDirectory = base === undefined && target?.kind === "directory"
            && live?.kind === "directory" && equal(target, live);
        if (!equal(base, live) && !sameNewDirectory) conflicts.add(path);

        let parent = posix.dirname(path);
        while (parent !== ".") {
            const baseParent = before.get(parent);
            const liveParent = now.get(parent);
            if (baseParent?.kind === "directory" && liveParent?.kind !== "directory") conflicts.add(path);
            if (baseParent === undefined && liveParent !== undefined && liveParent.kind !== "directory") conflicts.add(path);
            parent = posix.dirname(parent);
        }
        // Removing or replacing a directory must not remove another run's descendants.
        if (base?.kind === "directory" && target?.kind !== "directory") {
            const descendants = new Set([...before.keys(), ...now.keys()]);
            for (const child of descendants) {
                if (child.startsWith(`${path}/`) && !equal(before.get(child), now.get(child))) conflicts.add(child);
            }
        }
    }
    return { changes, conflicts: [...conflicts].sort() };
}
