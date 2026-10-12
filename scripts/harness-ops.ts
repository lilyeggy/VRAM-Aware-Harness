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
    pruneArtifacts,
    pruneSnapshotPool,
    pruneVmRuntime,
    restoreSqliteDatabase,
} from "../src/ops/harness-maintenance.ts";
import { VmSnapshotManager } from "../src/sandbox/microvm/vm-snapshot-manager.ts";

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

/**
 * 快照池清理时要豁免的目录名（= templateHash）。
 *
 * 默认用与 Broker 相同的算法算出"当前模板"的哈希并豁免它：当前快照目录的 mtime
 * 就是发布时刻，预热命中时不会 touch，纯 mtime TTL 会把唯一在用的快照删掉。
 * 需要豁免额外模板时用 `--protect-template <hash>`；显式关闭用
 * `--no-protect-current-template`（只在确实想连当前快照一起清的时候用）。
 */
function resolveProtectedTemplateHashes(args:Args):string[] {
    const hashes:string[] = [];
    const explicit = args["protect-template"];
    if (typeof explicit === "string" && explicit.length > 0) {
        hashes.push(explicit);
    }
    if (args["no-protect-current-template"] === true) {
        return hashes;
    }
    const kernelPath = process.env.FIRECRACKER_KERNEL_PATH;
    const rootfsPath = process.env.FIRECRACKER_ROOTFS_PATH;
    if (kernelPath === undefined || rootfsPath === undefined) {
        return hashes;
    }
    const agentVersion = process.env.HARNESS_GUEST_AGENT_VERSION ?? "2.0.0";
    const current = new VmSnapshotManager({}).computeTemplateHash(
        kernelPath,
        rootfsPath,
        agentVersion,
    );
    if (hashes.includes(current) === false) {
        hashes.push(current);
    }
    return hashes;
}

function usage():void {
    console.log(`Harness 单机运维 CLI

命令：
  disk-check --path <路径> [--warn 80] [--critical 90]
  backup --database <sqlite> --backup-dir <目录> [--keep 7]
  restore --backup <sqlite> --database <sqlite> [--force]
  cleanup --vm-runtime <目录> --snapshot-pool <目录> [--artifacts <目录> --database <sqlite>] [--max-age-hours 24] [--max-snapshots 8] [--apply]
          [--protect-template <hash>] [--no-protect-current-template]
          （snapshot-pool 未配置 FIRECRACKER_KERNEL_PATH/FIRECRACKER_ROOTFS_PATH 时默认跳过清理）

cleanup 的 snapshot-pool 默认豁免"当前模板"快照（按 FIRECRACKER_KERNEL_PATH /
FIRECRACKER_ROOTFS_PATH / HARNESS_GUEST_AGENT_VERSION 算 templateHash），
避免 mtime TTL 把唯一在用的黄金快照删掉。
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
            ? { removed:[], kept:0, protected:[], dryRun }
            : pruneVmRuntime({
                runtimeRoot:stringArg(args, "vm-runtime"),
                maxAgeMs,
                dryRun,
            });
        // 保护名单靠 FIRECRACKER_KERNEL_PATH / FIRECRACKER_ROOTFS_PATH 算出来。
        // 生产上 harness-maintenance 是 root 直跑 CLI，很容易漏掉这几个变量，
        // 一旦为空就会被 mtime TTL 把唯一在用的黄金快照删掉（真机复现：
        // snapshotPoolProtected=0 且待删列表里就是当前模板目录）。所以取不到
        // 当前模板时默认拒绝清理快照池，除非显式 --no-protect-current-template。
        const templateResolvable = process.env.FIRECRACKER_KERNEL_PATH !== undefined
            && process.env.FIRECRACKER_ROOTFS_PATH !== undefined;
        const skipSnapshotPool = args["snapshot-pool"] !== undefined
            && templateResolvable === false
            && args["no-protect-current-template"] !== true;
        const snapshotPool = args["snapshot-pool"] === undefined || skipSnapshotPool
            ? { removed:[], kept:0, protected:[], dryRun }
            : pruneSnapshotPool({
                poolDir:stringArg(args, "snapshot-pool"),
                maxAgeMs,
                maxEntries:numberArg(args, "max-snapshots", 8),
                dryRun,
                protectedNames:resolveProtectedTemplateHashes(args),
            });
        const artifacts = args.artifacts === undefined
            ? { removed:[], files:0, dryRun }
            : pruneArtifacts({
                artifactRoot:stringArg(args, "artifacts"),
                databasePath:stringArg(args, "database"),
                maxAgeMs,
                dryRun,
            });
        console.log(JSON.stringify({ vmRuntime, snapshotPool, artifacts }));
        console.log(
            `HARNESS_OPS_CLEANUP_OK dryRun=${dryRun} vmRuntimeRemoved=${vmRuntime.removed.length} snapshotPoolRemoved=${snapshotPool.removed.length} snapshotPoolProtected=${snapshotPool.protected.length} artifactsRemoved=${artifacts.removed.length} artifactFiles=${artifacts.files}`,
        );
        if (snapshotPool.protected.length > 0) {
            console.log(`HARNESS_OPS_CLEANUP_PROTECTED ${snapshotPool.protected.join(",")}`);
        }
        if (skipSnapshotPool) {
            console.log(
                "HARNESS_OPS_CLEANUP_SNAPSHOT_POOL_SKIPPED reason=no-current-template"
                + "（缺少 FIRECRACKER_KERNEL_PATH/FIRECRACKER_ROOTFS_PATH，无法算出当前模板，"
                + "拒绝按 mtime 清理快照池；确认要清理可显式加 --no-protect-current-template）",
            );
        }
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
