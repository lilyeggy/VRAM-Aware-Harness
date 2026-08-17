import { expect, test } from "bun:test";
import { RunOutputStore } from "../../src/runs/run-output-store.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

test("输出片段按 Run 顺序持久化并可组成最终回答", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        db.exec(`INSERT INTO agent_runs (id, tenant_id, harness_session_id, status, user_input, workspace_path, created_at, updated_at)
            VALUES ('run-output', 'tenant', 'session', 'QUEUED', 'task', '/tmp', 'now', 'now');`);
        const store = new RunOutputStore(db);
        store.append("run-output", "你好，");
        store.append("run-output", "任务已完成。");
        expect(store.list("run-output").map((item) => item.sequence)).toEqual([1, 2]);
        expect(store.finalText("run-output")).toBe("你好，任务已完成。");
    } finally { db.close(); }
});
