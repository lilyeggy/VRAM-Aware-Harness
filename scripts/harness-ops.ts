#!/usr/bin/env bun
/**
 * 单机运维 CLI：磁盘水位、SQLite 备份/恢复、VM 运行目录与快照池清理。
 *
 * 用法：
 *   bun run scripts/harness-ops.ts disk-check --path / [--warn 80] [--critical 90]
 *   bun run scripts/harness-ops.ts backup --database data/harness.sqlite --backup-dir data/backups [--keep 7]
 *   bun run scripts/harness-ops.ts restore --backup data/backups/harness-...sqlite --database data/harness.sqlite [--force]
 *   bun run scripts/harness-ops.ts cleanup --vm-runtime /var/lib/harness/vm --snapshot-pool /var/lib/harness/snapshots [--max-age-hours 24] [--max-snapshots 8] [--apply]
 *
 * cleanup 默认 dry-run，只打印将要删除的路径；确认后加 --apply。
 */
import {
    backupSqliteDatabase,
    checkDiskUsage,
    pruneSnapshotPool,
    pruneVmRuntime,
    restoreSqliteDatabase,
} from "../src/ops/harness-maintenance.ts";

type Args = Record<string, string | boolean>;

function parseArgs(argv:string[]):{ command:string; args:Args } {
    const [command = "help", ...rest] = argv;
    const args:Args = {};
    for (let i = 0; i < rest.length; i += 1) {
        const token = rest[i]!;
        if (!token.startsWith("--")) {
            throw new Error(`无法识别的参数：${token}`);
        }
        const key = token.slice(2);
        const next = rest[i + 1];
        if (next === undefined || next.startsWith("--")) {
            args[key] = true;
        } else {
            args[key] = next;
            i += 1;
        }
    }
    return { command, args };
}

function stringArg(args:Args, name:string):string {
    const value = args[name];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`缺少参数 --${name}`);
    }
    return value;
}

function numberArg(args:Args, name:string, fallback:number):number {
    const value = args[name];
    if (value === undefined || value === true) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`--${name} 必须是数字`);
    }
    return parsed;
}

function usage():void {
    console.log(`Harness 单机运维 CLI

命令：
  disk-check --path <路径> [--warn 80] [--critical 90]
  backup --database <sqlite> --backup-dir <目录> [--keep 7]
  restore --backup <sqlite> --database <sqlite> [--force]
  cleanup --vm-runtime <目录> --snapshot-pool <目录> [--max-age-hours 24] [--max-snapshots 8] [--apply]
`);
}

const { command, args } = parseArgs(process.argv.slice(2));

try {
    if (command === "disk-check") {
        const status = checkDiskUsage(stringArg(args, "path"), {
            warnPercent:numberArg(args, "warn", 80),
            criticalPercent:numberArg(args, "critical", 90),
        });
        console.log(JSON.stringify(status));
        console.log(
            `HARNESS_OPS_DISK_OK level=${status.level} used=${status.usage.usedPercent}% availableBytes=${status.usage.availableBytes}`,
        );
        if (status.level === "critical") {
            process.exitCode = 2;
        }
    } else if (command === "backup") {
        const result = backupSqliteDatabase({
            databasePath:stringArg(args, "database"),
            backupDir:stringArg(args, "backup-dir"),
            keep:numberArg(args, "keep", 7),
        });
        console.log(JSON.stringify(result));
        console.log(
            `HARNESS_OPS_BACKUP_OK path=${result.backupPath} bytes=${result.bytes} pruned=${result.pruned.length}`,
        );
    } else if (command === "restore") {
        restoreSqliteDatabase({
            backupPath:stringArg(args, "backup"),
            databasePath:stringArg(args, "database"),
            force:args.force === true,
        });
        console.log(`HARNESS_OPS_RESTORE_OK database=${stringArg(args, "database")}`);
    } else if (command === "cleanup") {
        const maxAgeMs = numberArg(args, "max-age-hours", 24) * 60 * 60 * 1000;
        const dryRun = args.apply !== true;
        const vmRuntime = args["vm-runtime"] === undefined
            ? { removed:[], kept:0, dryRun }
            : pruneVmRuntime({
                runtimeRoot:stringArg(args, "vm-runtime"),
                maxAgeMs,
                dryRun,
            });
        const snapshotPool = args["snapshot-pool"] === undefined
            ? { removed:[], kept:0, dryRun }
            : pruneSnapshotPool({
                poolDir:stringArg(args, "snapshot-pool"),
                maxAgeMs,
                maxEntries:numberArg(args, "max-snapshots", 8),
                dryRun,
            });
        console.log(JSON.stringify({ vmRuntime, snapshotPool }));
        console.log(
            `HARNESS_OPS_CLEANUP_OK dryRun=${dryRun} vmRuntimeRemoved=${vmRuntime.removed.length} snapshotPoolRemoved=${snapshotPool.removed.length}`,
        );
    } else {
        usage();
        if (command !== "help" && command !== "--help") {
            process.exitCode = 1;
        }
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
