import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        expect(tableNames).toContain("harness_sessions");
        expect(tableNames).toContain("run_attempts");
        expect(tableNames).toContain("effective_policy_snapshots");
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

test("v6 只为旧 Run 回填唯一匹配的用户工作区", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        db.exec(`INSERT INTO workspaces (id, user_id, name, root_path, created_at)
            VALUES ('w1', 'u1', 'one', '/tmp/one', 'now'),
                   ('w2', 'u1', 'two', '/tmp/two', 'now');
            INSERT INTO harness_sessions (id, user_id, workspace_id, title, runtime_session_ref, created_at, updated_at)
            VALUES ('s1', 'u1', NULL, NULL, 'old-ref', 'now', 'now'),
                   ('s2', 'u1', NULL, NULL, 'old-ref', 'now', 'now');
            INSERT INTO agent_runs (id, user_id, harness_session_id, status, user_input,
                workspace_path, created_at, updated_at)
            VALUES ('r1', 'u1', 's1', 'QUEUED', 'x', '/tmp/one', 'now', 'now'),
                   ('r2', 'u1', 's2', 'QUEUED', 'x', '/tmp/missing', 'now', 'now'),
                   ('r3', 'u2', 's3', 'QUEUED', 'x', '/tmp/one', 'now', 'now'),
                   ('r4', 'u1', 's4', 'QUEUED', 'x', '/tmp/two', 'now', 'now');
            DELETE FROM schema_migrations WHERE version = 6;`);
        runMigrations(db);
        const rows = db.query<{ id: string; workspaceId: string | null }, []>(
            "SELECT id, workspace_id AS workspaceId FROM agent_runs ORDER BY id",
        ).all();
        expect(rows).toEqual([
            { id: "r1", workspaceId: "w1" },
            { id: "r2", workspaceId: null },
            { id: "r3", workspaceId: null },
            { id: "r4", workspaceId: "w2" },
        ]);
        expect(db.query<{ id: string; workspaceId: string | null }, []>(
            "SELECT id, workspace_id AS workspaceId FROM harness_sessions ORDER BY id",
        ).all()).toEqual([
            { id: "s1", workspaceId: "w1" },
            { id: "s2", workspaceId: null },
            { id: "s4", workspaceId: "w2" },
        ]);
    } finally { db.close(); }
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

        expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
        db.close();
    }
});


test("v5 migration 把旧库的 tenant_id 列原地改名为 user_id", () => {
    // 构造一个 v1.6 时代的旧库：把列名回退成 tenant_id，并删掉 v5 的版本记录。
    const db = openHarnessDatabase(":memory:");

    try {
        const legacyTables = [
            "agent_runs",
            "workspaces",
            "harness_sessions",
            "api_credentials",
            "access_audit_events",
            "effective_policy_snapshots",
        ];

        for (const table of legacyTables) {
            db.exec("ALTER TABLE " + table + " RENAME COLUMN user_id TO tenant_id;");
        }
        db.exec("DELETE FROM schema_migrations WHERE version IN (5, 6);");

        runMigrations(db);

        const columns = (table: string) =>
            db
                .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
                .all(table)
                .map((column) => column.name);

        for (const table of legacyTables) {
            expect(columns(table)).toContain("user_id");
            expect(columns(table)).not.toContain("tenant_id");
        }

        const versions = db
            .query<MigrationVersionRow, []>("SELECT version FROM schema_migrations ORDER BY version ASC")
            .all()
            .map((row) => row.version);
        expect(versions).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
        db.close();
    }
});

interface PragmaJournalRow {
    journal_mode?: string;
}

interface PragmaTimeoutRow {
    timeout?: number;
}

test("数据库连接启用 WAL 与 busy_timeout，避免跨进程备份与写入互斥", () => {
    const memory = openHarnessDatabase(":memory:");
    try {
        // :memory: 不支持 WAL，SQLite 会保持 memory journal；但 busy_timeout 仍应生效。
        expect(memory.query<PragmaJournalRow, []>("PRAGMA journal_mode;").get()?.journal_mode)
            .toBe("memory");
        expect(memory.query<PragmaTimeoutRow, []>("PRAGMA busy_timeout;").get()?.timeout)
            .toBe(5000);
    } finally {
        memory.close();
    }

    const dir = mkdtempSync(join(tmpdir(), "harness-db-pragma-"));
    const path = join(dir, "harness.sqlite");
    const fileDb = openHarnessDatabase(path);
    try {
        expect(fileDb.query<PragmaJournalRow, []>("PRAGMA journal_mode;").get()?.journal_mode)
            .toBe("wal");
        expect(fileDb.query<PragmaTimeoutRow, []>("PRAGMA busy_timeout;").get()?.timeout)
            .toBe(5000);
    } finally {
        fileDb.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
