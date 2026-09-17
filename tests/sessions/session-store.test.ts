import { expect, test } from "bun:test";
import { createConversation } from "../../src/sessions/harness-session.ts";
import { HarnessSessionStore } from "../../src/sessions/harness-session-store.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

test("Session 固定归属 Tenant 和 Workspace，并按最近消息排序", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        db.query(`
            INSERT INTO workspaces (id, tenant_id, name, root_path, created_at)
            VALUES ('workspace-a', 'tenant-a', 'project', '/tmp/project-a', '2026-08-30T00:00:00.000Z')
        `).run();
        const store = new HarnessSessionStore(db);
        const conversation = createConversation({
            id: "conversation-a",
            tenantId: "tenant-a",
            workspaceId: "workspace-a",
            title: "修复测试",
            createdAt: "2026-08-30T00:00:00.000Z",
        });
        store.create({ ...conversation, runtimeSessionRef: null });

        expect(store.getForTenant(conversation.id, "tenant-a")).toEqual(conversation);
        expect(store.getForTenant(conversation.id, "tenant-b")).toBeNull();
        store.touch(conversation.id, "tenant-a", "2026-08-30T01:00:00.000Z");
        expect(store.listForWorkspace("tenant-a", "workspace-a")[0]).toMatchObject({
            id: "conversation-a",
            workspaceId: "workspace-a",
            updatedAt: "2026-08-30T01:00:00.000Z",
        });
    } finally {
        db.close();
    }
});
