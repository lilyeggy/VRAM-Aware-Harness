import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VmSnapshotManager } from "../../src/sandbox/microvm/vm-snapshot-manager.ts";

function runCleanup(extraEnv: Record<string, string>, pool: string): string {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (key.startsWith("FIRECRACKER_")) continue;
        if (key === "HARNESS_GUEST_AGENT_VERSION") continue;
        env[key] = value;
    }
    const result = spawnSync(process.execPath, [
        "run",
        "scripts/harness-ops.ts",
        "cleanup",
        "--snapshot-pool", pool,
        "--max-age-hours", "0",
        "--max-snapshots", "0",
        "--apply",
    ], { env: { ...env, ...extraEnv }, encoding: "utf8" });
    return String(result.stdout ?? "") + String(result.stderr ?? "");
}

describe("harness-ops cleanup 的快照池保护", () => {
    test("算不出当前模板时拒绝清理快照池（生产维护脚本漏配 env 的防护）", () => {
        const root = mkdtempSync(join(tmpdir(), "harness-ops-pool-"));
        const pool = join(root, "pool");
        const templateDir = join(pool, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        mkdirSync(templateDir, { recursive: true });
        writeFileSync(join(templateDir, "vm.snap"), "snapshot");

        const output = runCleanup({}, pool);

        expect(output).toContain("HARNESS_OPS_CLEANUP_SNAPSHOT_POOL_SKIPPED");
        expect(existsSync(templateDir)).toBe(true);
    });

    test("显式保护当前模板时不会删除该模板目录", () => {
        const root = mkdtempSync(join(tmpdir(), "harness-ops-pool-"));
        const pool = join(root, "pool");
        const kernel = join(root, "vmlinux");
        const rootfs = join(root, "rootfs.ext4");
        writeFileSync(kernel, "kernel");
        writeFileSync(rootfs, "rootfs");
        const hash = new VmSnapshotManager({ snapshotPoolDir: pool })
            .computeTemplateHash(kernel, rootfs, "2.0.0");
        const templateDir = join(pool, hash);
        mkdirSync(templateDir, { recursive: true });
        writeFileSync(join(templateDir, "vm.snap"), "snapshot");

        const output = runCleanup({
            FIRECRACKER_KERNEL_PATH: kernel,
            FIRECRACKER_ROOTFS_PATH: rootfs,
            HARNESS_GUEST_AGENT_VERSION: "2.0.0",
        }, pool);

        expect(output.includes("HARNESS_OPS_CLEANUP_SNAPSHOT_POOL_SKIPPED")).toBe(false);
        expect(output).toContain("HARNESS_OPS_CLEANUP_PROTECTED " + hash);
        expect(existsSync(templateDir)).toBe(true);
    });
});
