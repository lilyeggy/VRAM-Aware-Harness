import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
    pruneArtifacts,
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

test("pruneSnapshotPool 豁免当前模板哈希（mtime TTL 不得删掉在用的黄金快照）", () => {
    const pool = join(tempDir(), "snapshots-protected");
    mkdirSync(pool);
    const now = new Date("2026-10-10T12:00:00.000Z");
    const current = join(pool, "hash-current");
    const stale = join(pool, "hash-stale");
    for (const path of [current, stale]) {
        mkdirSync(path);
    }
    // 当前模板的快照比旧模板更旧（预热命中时不会 touch，mtime 会一直停在那里）
    setAge(current, 30 * 86_400_000, now);
    setAge(stale, 1 * 86_400_000, now);

    const result = pruneSnapshotPool({
        poolDir:pool,
        maxAgeMs:1 * 3_600_000,
        maxEntries:0,
        dryRun:false,
        now,
        protectedNames:["hash-current"],
    });

    expect(result.removed).toEqual([stale]);
    expect(result.protected).toEqual(["hash-current"]);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(stale)).toBe(false);
});

test("harness-ops cleanup 默认豁免当前模板快照（源码守卫）", () => {
    const source = readFileSync(
        new URL("../../scripts/harness-ops.ts", import.meta.url),
        "utf8",
    );
    expect(source).toContain("function resolveProtectedTemplateHashes(args:Args):string[]");
    expect(source).toContain("protectedNames:resolveProtectedTemplateHashes(args)");
    expect(source).toContain('const agentVersion = process.env.HARNESS_GUEST_AGENT_VERSION ?? "2.0.0";');
    expect(source).toContain('args["no-protect-current-template"] === true');
    expect(source).toContain("snapshotPoolProtected=${snapshotPool.protected.length}");
    expect(source).toContain("computeTemplateHash(");

    const maintenance = readFileSync(
        new URL("../../deploy/harness-maintenance.sh.example", import.meta.url),
        "utf8",
    );
    expect(maintenance).toContain("read_broker_env FIRECRACKER_KERNEL_PATH");
    expect(maintenance).toContain("read_broker_env FIRECRACKER_ROOTFS_PATH");
    expect(maintenance).toContain("read_broker_env HARNESS_GUEST_AGENT_VERSION");
});

test("pruneArtifacts 按 Run 最新 artifact 时间清理目录与索引行", () => {
    const dir = tempDir();
    const databasePath = join(dir, "harness.sqlite");
    const db = new Database(databasePath, { create:true });
    db.exec(`
        CREATE TABLE run_artifacts (
            run_id TEXT NOT NULL,
            path TEXT NOT NULL,
            hash TEXT NOT NULL,
            size INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, path)
        );
    `);
    const now = new Date("2026-10-11T12:00:00.000Z");
    const oldIso = new Date(now.getTime() - 48 * 3_600_000).toISOString();
    const newIso = new Date(now.getTime() - 1 * 3_600_000).toISOString();
    db.query("INSERT INTO run_artifacts VALUES (?,?,?,?,?)")
        .run("old-run", "a.txt", "h", 1, oldIso);
    db.query("INSERT INTO run_artifacts VALUES (?,?,?,?,?)")
        .run("new-run", "b.txt", "h", 1, newIso);
    db.close();

    const artifactRoot = join(dir, "artifacts");
    mkdirSync(join(artifactRoot, "old-run"), { recursive:true });
    writeFileSync(join(artifactRoot, "old-run", "a.txt"), "a");
    mkdirSync(join(artifactRoot, "new-run"), { recursive:true });
    writeFileSync(join(artifactRoot, "new-run", "b.txt"), "b");

    const dry = pruneArtifacts({
        artifactRoot, databasePath, maxAgeMs:24 * 3_600_000, dryRun:true, now,
    });
    expect(dry.removed).toEqual(["old-run"]);
    expect(existsSync(join(artifactRoot, "old-run"))).toBe(true);

    const applied = pruneArtifacts({
        artifactRoot, databasePath, maxAgeMs:24 * 3_600_000, dryRun:false, now,
    });
    expect(applied.removed).toEqual(["old-run"]);
    expect(existsSync(join(artifactRoot, "old-run"))).toBe(false);
    expect(existsSync(join(artifactRoot, "new-run"))).toBe(true);

    const check = new Database(databasePath);
    const remaining = check.query("SELECT run_id FROM run_artifacts").all() as { run_id:string }[];
    check.close();
    expect(remaining.map((row) => row.run_id)).toEqual(["new-run"]);
});
