import { Database } from "bun:sqlite";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    statSync,
    statfsSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * 单机运维最小闭环：磁盘水位、SQLite 备份/恢复、VM 运行目录与快照池清理。
 *
 * 这些函数只做本地文件系统操作，不依赖 Harness 运行时；CLI（scripts/harness-ops.ts）
 * 与 systemd timer/人工 runbook 都复用它，避免备份/清理逻辑散落在 shell 里。
 */

export interface DiskUsage {
    path:string;
    totalBytes:number;
    usedBytes:number;
    availableBytes:number;
    usedPercent:number;
}

export interface DiskUsageThresholds {
    warnPercent:number;
    criticalPercent:number;
}

export interface DiskUsageStatus {
    usage:DiskUsage;
    level:"ok" | "warn" | "critical";
}

export function readDiskUsage(path:string):DiskUsage {
    const stats = statfsSync(path);
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - stats.bfree * stats.bsize;
    const usedPercent = totalBytes === 0 ? 0 : (usedBytes / totalBytes) * 100;
    return {
        path,
        totalBytes,
        usedBytes,
        availableBytes,
        usedPercent:Number(usedPercent.toFixed(2)),
    };
}

export function classifyDiskUsage(
    usage:DiskUsage,
    thresholds:DiskUsageThresholds,
):DiskUsageStatus {
    if (thresholds.criticalPercent < thresholds.warnPercent) {
        throw new Error("criticalPercent 不能小于 warnPercent");
    }
    const level = usage.usedPercent >= thresholds.criticalPercent
        ? "critical"
        : usage.usedPercent >= thresholds.warnPercent
            ? "warn"
            : "ok";
    return { usage, level };
}

export function checkDiskUsage(
    path:string,
    thresholds:DiskUsageThresholds,
):DiskUsageStatus {
    return classifyDiskUsage(readDiskUsage(path), thresholds);
}

export interface BackupResult {
    backupPath:string;
    bytes:number;
    pruned:string[];
}

export function backupSqliteDatabase(input:{
    databasePath:string;
    backupDir:string;
    keep?:number;
    now?:Date;
}):BackupResult {
    if (!existsSync(input.databasePath)) {
        throw new Error(`数据库不存在：${input.databasePath}`);
    }
    const keep = input.keep ?? 7;
    if (!Number.isInteger(keep) || keep < 1) {
        throw new Error("keep 必须是 >= 1 的整数");
    }
    mkdirSync(input.backupDir, { recursive:true });
    const backupPath = join(
        input.backupDir,
        `harness-${formatTimestamp(input.now ?? new Date())}.sqlite`,
    );
    if (existsSync(backupPath)) {
        throw new Error(`备份文件已存在：${backupPath}`);
    }
    const database = new Database(input.databasePath);
    try {
        // VACUUM INTO 生成一致性快照，不需要停写；目标文件不存在时由 SQLite 创建。
        database.run("VACUUM INTO ?", [backupPath]);
    } finally {
        database.close();
    }
    const pruned = pruneBackups(input.backupDir, keep);
    return {
        backupPath,
        bytes:statSync(backupPath).size,
        pruned,
    };
}

export function restoreSqliteDatabase(input:{
    backupPath:string;
    databasePath:string;
    force?:boolean;
}):void {
    if (!existsSync(input.backupPath)) {
        throw new Error(`备份文件不存在：${input.backupPath}`);
    }
    if (existsSync(input.databasePath) && input.force !== true) {
        throw new Error(
            `目标数据库已存在：${input.databasePath}；确认要覆盖请加 --force`,
        );
    }
    mkdirSync(dirname(input.databasePath), { recursive:true });
    copyFileSync(input.backupPath, input.databasePath);
    // 覆盖主库后必须清掉旧 WAL/SHM，否则 SQLite 可能把旧日志重放到新库上。
    for (const sidecar of [`${input.databasePath}-wal`, `${input.databasePath}-shm`]) {
        rmSync(sidecar, { force:true });
    }
}

export function pruneBackups(backupDir:string, keep:number):string[] {
    if (!existsSync(backupDir)) {
        return [];
    }
    const candidates = readdirSync(backupDir)
        .filter((name) => /^harness-\d{8}T\d{6}Z?\.sqlite$/.test(name))
        .map((name) => ({
            name,
            path:join(backupDir, name),
            mtimeMs:statSync(join(backupDir, name)).mtimeMs,
        }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    const pruned:string[] = [];
    for (const candidate of candidates.slice(keep)) {
        rmSync(candidate.path, { force:true });
        pruned.push(candidate.path);
    }
    return pruned;
}

export interface PruneResult {
    removed:string[];
    kept:number;
    /** 命中 protectedNames 而始终保留的条目名（快照池用来豁免当前模板哈希）。 */
    protected:string[];
    dryRun:boolean;
}

export function pruneVmRuntime(input:{
    runtimeRoot:string;
    maxAgeMs:number;
    dryRun?:boolean;
    now?:Date;
}):PruneResult {
    return pruneDirectories({
        root:input.runtimeRoot,
        maxAgeMs:input.maxAgeMs,
        maxEntries:Number.POSITIVE_INFINITY,
        dryRun:input.dryRun,
        now:input.now,
    });
}

export function pruneSnapshotPool(input:{
    poolDir:string;
    maxAgeMs:number;
    maxEntries?:number;
    dryRun?:boolean;
    now?:Date;
    /**
     * 永不删除的条目名（池目录名就是 templateHash）。
     *
     * 当前在用的黄金快照目录的 mtime 就是它被发布的时间，而预热命中时
     * `VM_PREWARM_SKIP` 不会 touch 目录 —— 纯 mtime TTL 会在若干小时后把
     * 唯一在用的快照删掉，直到下一次预热重建之间落进来的 Run 吃完整冷启动
     * （见 docs/research/cold-start-standby-pool.md §5.3）。
     */
    protectedNames?:readonly string[];
}):PruneResult {
    return pruneDirectories({
        root:input.poolDir,
        maxAgeMs:input.maxAgeMs,
        maxEntries:input.maxEntries ?? Number.POSITIVE_INFINITY,
        dryRun:input.dryRun,
        now:input.now,
        protectedNames:input.protectedNames,
    });
}

function pruneDirectories(input:{
    root:string;
    maxAgeMs:number;
    maxEntries:number;
    dryRun?:boolean;
    now?:Date;
    protectedNames?:readonly string[];
}):PruneResult {
    const dryRun = input.dryRun === true;
    const nowMs = (input.now ?? new Date()).getTime();
    if (!existsSync(input.root)) {
        return { removed:[], kept:0, protected:[], dryRun };
    }
    const protectedSet = new Set(input.protectedNames ?? []);
    const protectedEntries:string[] = [];
    const entries = readdirSync(input.root, { withFileTypes:true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => {
            if (protectedSet.has(entry.name)) {
                protectedEntries.push(entry.name);
                return false;
            }
            return true;
        })
        .map((entry) => {
            const path = join(input.root, entry.name);
            return { path, mtimeMs:statSync(path).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const removed:string[] = [];
    entries.forEach((entry, index) => {
        const tooOld = nowMs - entry.mtimeMs > input.maxAgeMs;
        const overLimit = index >= input.maxEntries;
        if (!tooOld && !overLimit) {
            return;
        }
        removed.push(entry.path);
        if (!dryRun) {
            rmSync(entry.path, { recursive:true, force:true });
        }
    });
    return {
        removed,
        kept:entries.length - removed.length,
        protected:protectedEntries,
        dryRun,
    };
}

export interface ArtifactPruneResult {
    /** 被清理的 Run id 列表。 */
    removed:string[];
    /** 随目录一起删除的 artifact 行数。 */
    files:number;
    dryRun:boolean;
}

/**
 * F9：按 Run 最新 artifact 时间清理过期 artifact 目录与索引行。
 * 目录布局与 RunArtifactStore 一致：<artifactRoot>/<runId>/<path>。
 */
export function pruneArtifacts(input:{
    artifactRoot:string;
    databasePath:string;
    maxAgeMs:number;
    dryRun?:boolean;
    now?:Date;
}):ArtifactPruneResult {
    const dryRun = input.dryRun === true;
    const nowMs = (input.now ?? new Date()).getTime();
    if (existsSync(input.artifactRoot) === false) {
        return { removed:[], files:0, dryRun };
    }
    const database = new Database(input.databasePath);
    try {
        const cutoff = new Date(nowMs - input.maxAgeMs).toISOString();
        const runs = database.query<
            { runId:string; count:number },
            string
        >(`
            SELECT run_id AS runId, COUNT(*) AS count
            FROM run_artifacts
            GROUP BY run_id
            HAVING MAX(created_at) < ?;
        `).all(cutoff);
        const removed:string[] = [];
        let files = 0;
        for (const run of runs) {
            removed.push(run.runId);
            files += run.count;
            if (dryRun === false) {
                rmSync(join(input.artifactRoot, run.runId), { recursive:true, force:true });
                database.query("DELETE FROM run_artifacts WHERE run_id = ?;")
                    .run(run.runId);
            }
        }
        return { removed, files, dryRun };
    } finally {
        database.close();
    }
}

function formatTimestamp(date:Date):string {
    return date.toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
}
