import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    backupSqliteDatabase,
    classifyDiskUsage,
    pruneSnapshotPool,
    pruneVmRuntime,
    restoreSqliteDatabase,
} from "../../src/ops/harness-maintenance.ts";

function tempDir():string {
    return mkdtempSync(join(tmpdir(), "harness-ops-"));
}

function createDatabase(path:string):void {
    const db = new Database(path, { create:true });
    db.exec("CREATE TABLE t(x TEXT); INSERT INTO t VALUES ('hello');");
    db.close();
}

function setAge(path:string, ageMs:number, now:Date):void {
    const timestamp = new Date(now.getTime() - ageMs);
    utimesSync(path, timestamp, timestamp);
}

test("classifyDiskUsage 按阈值分级并拒绝倒置阈值", () => {
    const base = {
        path:"/",
        totalBytes:100,
        usedBytes:50,
        availableBytes:50,
        usedPercent:50,
    };
    expect(classifyDiskUsage(base, { warnPercent:80, criticalPercent:90 }).level).toBe("ok");
    expect(classifyDiskUsage({ ...base, usedPercent:80 }, { warnPercent:80, criticalPercent:90 }).level).toBe("warn");
    expect(classifyDiskUsage({ ...base, usedPercent:95 }, { warnPercent:80, criticalPercent:90 }).level).toBe("critical");
    expect(() => classifyDiskUsage(base, { warnPercent:90, criticalPercent:80 }))
        .toThrow("criticalPercent 不能小于 warnPercent");
});

test("backupSqliteDatabase 生成可查询备份并保留最近 N 份", () => {
    const dir = tempDir();
    const databasePath = join(dir, "harness.sqlite");
    createDatabase(databasePath);

    const backupDir = join(dir, "backups");
    mkdirSync(backupDir);
    const now = new Date("2026-10-10T12:00:00.000Z");
    for (const [name, ageMs] of [
        ["harness-20200101T000000Z.sqlite", 3 * 86_400_000],
        ["harness-20200102T000000Z.sqlite", 2 * 86_400_000],
        ["harness-20200103T000000Z.sqlite", 1 * 86_400_000],
    ] as const) {
        const path = join(backupDir, name);
        writeFileSync(path, "old");
        setAge(path, ageMs, now);
    }

    const result = backupSqliteDatabase({
        databasePath,
        backupDir,
        keep:2,
        now,
    });
    expect(existsSync(result.backupPath)).toBe(true);
    expect(result.pruned.length).toBe(2);

    const backup = new Database(result.backupPath, { readonly:true });
    try {
        expect(backup.query("SELECT x FROM t").get()).toEqual({ x:"hello" });
    } finally {
        backup.close();
    }
});

test("restoreSqliteDatabase 覆盖恢复并清理 WAL/SHM", () => {
    const dir = tempDir();
    const databasePath = join(dir, "harness.sqlite");
    createDatabase(databasePath);
    const backupDir = join(dir, "backups");
    const backup = backupSqliteDatabase({ databasePath, backupDir, keep:7 });

    const restoredPath = join(dir, "restored.sqlite");
    writeFileSync(`${restoredPath}-wal`, "stale");
    restoreSqliteDatabase({
        backupPath:backup.backupPath,
        databasePath:restoredPath,
        force:true,
    });
    expect(existsSync(`${restoredPath}-wal`)).toBe(false);
    const restored = new Database(restoredPath, { readonly:true });
    try {
        expect(restored.query("SELECT x FROM t").get()).toEqual({ x:"hello" });
    } finally {
        restored.close();
    }

    expect(() => restoreSqliteDatabase({
        backupPath:backup.backupPath,
        databasePath:restoredPath,
    })).toThrow("目标数据库已存在");
});

test("pruneVmRuntime 默认 dry-run，apply 后删除过期目录", () => {
    const root = join(tempDir(), "vm");
    mkdirSync(root);
    const now = new Date("2026-10-10T12:00:00.000Z");
    const oldDir = join(root, "old");
    const freshDir = join(root, "fresh");
    mkdirSync(oldDir);
    mkdirSync(freshDir);
    setAge(oldDir, 48 * 3_600_000, now);
    setAge(freshDir, 1_000, now);

    const dry = pruneVmRuntime({ runtimeRoot:root, maxAgeMs:24 * 3_600_000, dryRun:true, now });
    expect(dry.removed).toEqual([oldDir]);
    expect(existsSync(oldDir)).toBe(true);

    const applied = pruneVmRuntime({ runtimeRoot:root, maxAgeMs:24 * 3_600_000, dryRun:false, now });
    expect(applied.removed).toEqual([oldDir]);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
});

test("pruneSnapshotPool 同时按年龄与最大条目数清理", () => {
    const pool = join(tempDir(), "snapshots");
    mkdirSync(pool);
    const now = new Date("2026-10-10T12:00:00.000Z");
    const oldest = join(pool, "hash-oldest");
    const middle = join(pool, "hash-middle");
    const newest = join(pool, "hash-newest");
    for (const path of [oldest, middle, newest]) {
        mkdirSync(path);
    }
    setAge(oldest, 3 * 86_400_000, now);
    setAge(middle, 2 * 86_400_000, now);
    setAge(newest, 1 * 86_400_000, now);

    const byCount = pruneSnapshotPool({
        poolDir:pool,
        maxAgeMs:10 * 86_400_000,
        maxEntries:2,
        dryRun:false,
        now,
    });
    expect(byCount.removed).toEqual([oldest]);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);

    const byAge = pruneSnapshotPool({
        poolDir:pool,
        maxAgeMs:1.5 * 86_400_000,
        maxEntries:10,
        dryRun:false,
        now,
    });
    expect(byAge.removed).toEqual([middle]);
    expect(existsSync(newest)).toBe(true);
});
