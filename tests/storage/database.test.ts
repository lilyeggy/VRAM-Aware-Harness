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
        expect(tableNames).toContain("resource_snapshots");
        expect(tableNames).toContain("policy_decisions");
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

        expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
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
