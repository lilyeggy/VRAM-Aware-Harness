import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService } from "../../src/workspaces/workspace-service.ts";
import type { Workspace, WorkspaceStore } from "../../src/workspaces/workspace-store.ts";

class MemoryWorkspaceStore {
    created: Workspace[] = [];
    create(workspace: Workspace): void { this.created.push(workspace); }
    getForTenant(): Workspace | null { return null; }
    listForTenant(): Workspace[] { return []; }
}

test("容器模式 Workspace 在创建时交给实际容器 UID", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-workspace-owner-"));
    try {
        const store = new MemoryWorkspaceStore();
        const uid = process.getuid?.();
        if (uid === undefined) return;
        const service = new WorkspaceService(root, store as unknown as WorkspaceStore, uid);
        const workspace = service.create("tenant-a", "project");
        expect(statSync(workspace.rootPath).uid).toBe(uid);
        expect(store.created).toHaveLength(1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
