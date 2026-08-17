import { expect, test } from "bun:test";

import {
    openHarnessDatabase,
    runMigrations,
} from "../../src/storage/database.ts";

interface TableNameRow {
    name: string;
}

interface MigrationVersionRow {
    version: number;
}

test("打开新数据库时会创建当前版本所需的表", () => {
    // :memory: 会为当前测试创建一个独立的临时 SQLite 数据库。
    // 测试结束后关闭连接，数据库内容也会随之消失。
    const db = openHarnessDatabase(":memory:");

    try {
        const rows = db
            .query<TableNameRow, []>(`
                SELECT name
                FROM sqlite_master
                WHERE type = 'table';
            `)
            .all();

        const tableNames = rows.map((row) => row.name);

        expect(tableNames).toContain("schema_migrations");
        expect(tableNames).toContain("agent_runs");
        expect(tableNames).toContain("run_events");
        expect(tableNames).toContain("tool_executions");
        expect(tableNames).toContain("checkpoints");
        expect(tableNames).toContain("resource_snapshots");
        expect(tableNames).toContain("policy_decisions");
        expect(tableNames).toContain("harness_templates");
        expect(tableNames).toContain("harness_template_versions");
        expect(tableNames).toContain("runtime_capability_profiles");
        expect(tableNames).toContain("harness_instances");
        expect(tableNames).toContain("harness_sessions");
        expect(tableNames).toContain("run_attempts");
        expect(tableNames).toContain("effective_policy_snapshots");
        expect(tableNames).toContain("policy_compilations");
        expect(tableNames).toContain("tool_policy_decisions");
        expect(tableNames).toContain("sandboxes");
        expect(tableNames).toContain("api_credentials");
        expect(tableNames).toContain("workspaces");
        expect(tableNames).toContain("access_audit_events");
        expect(tableNames).toContain("run_output_chunks");
        expect(tableNames).toContain("run_workspace_snapshots");
        expect(tableNames).toContain("run_workspace_diffs");
        expect(tableNames).toContain("run_artifacts");
    } finally {
        db.close();
    }
});

test("重复运行 migration 不会重复应用已有版本", () => {
    const db = openHarnessDatabase(":memory:");

    try {
        // openHarnessDatabase 已经运行过一次 migration。
        // 再运行一次用于验证 migration runner 的幂等性。
        runMigrations(db);

        const rows = db
            .query<MigrationVersionRow, []>(`
                SELECT version
                FROM schema_migrations
                ORDER BY version ASC;
            `)
            .all();

        expect(rows.map((row) => row.version)).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
        ]);
    } finally {
        db.close();
    }
});
