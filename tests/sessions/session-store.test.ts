import { expect, test } from "bun:test";
import { createConversation } from "../../src/sessions/harness-session.ts";
import { HarnessSessionStore } from "../../src/sessions/harness-session-store.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

test("Session 固定归属 User 和 Workspace，并按最近消息排序", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        db.query(`
            INSERT INTO workspaces (id, user_id, name, root_path, created_at)
            VALUES ('workspace-a', 'user-a', 'project', '/tmp/project-a', '2026-08-30T00:00:00.000Z')
        `).run();
        const store = new HarnessSessionStore(db);
        const conversation = createConversation({
            id: "conversation-a",
            userId: "user-a",
            workspaceId: "workspace-a",
            title: "修复测试",
            createdAt: "2026-08-30T00:00:00.000Z",
        });
        store.create({ ...conversation, runtimeSessionRef: null });

        expect(store.getForUser(conversation.id, "user-a")).toEqual(conversation);
        expect(store.getForUser(conversation.id, "user-b")).toBeNull();
        store.touch(conversation.id, "user-a", "2026-08-30T01:00:00.000Z");
        expect(store.listForWorkspace("user-a", "workspace-a")[0]).toMatchObject({
            id: "conversation-a",
            workspaceId: "workspace-a",
            updatedAt: "2026-08-30T01:00:00.000Z",
        });
    } finally {
        db.close();
    }
});
