import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VmSnapshotManager } from "../../src/sandbox/microvm/vm-snapshot-manager.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), "utf8");

describe("make-snapshot 写盘优化（sync_snapshot_files / 硬链接 / 后台 fsync）", () => {
    it("/snapshot/create 显式传 sync_snapshot_files，默认等落盘（=0 才关闭）", () => {
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain("sync_snapshot_files: this.snapshotSyncFiles");
        // 默认持久（等 fsync）；实测不等并无收益，所以只有显式 =0 才关闭
        expect(driver).toContain('(process.env.HARNESS_VM_SNAPSHOT_SYNC_FILES === "0" ? false : true)');
        expect(driver).toContain("readonly snapshotSyncFiles?: boolean;");
    });

    it("jailer 下 chroot 里的快照硬链接进 staging，而不是再整块复制一遍", () => {
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain("await shareBaseFile(snapInChroot, stagingPaths.snapshotPath, {");
        expect(driver).toContain("await shareBaseFile(memInChroot, stagingPaths.memFilePath, {");
        expect(driver).toContain("fallbackCopy: copyFileReflink");
        // 复制会多走一遍 512MB 读+写（ext4 没有 reflink，--reflink=auto 退化为全量拷贝）
        expect(driver).not.toContain("await copyFileReflink(memInChroot, stagingPaths.memFilePath);");
    });

    it("发布后异步补 fsync（宿主崩溃丢快照的窗口收窄），且不阻塞 create", () => {
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain("void this.snapshotManager.fsyncPublished(templateHash).catch(");
        expect(driver).toContain("if (this.snapshotSyncFiles === false) {");
    });

    it("fsyncPublished 对池内 vm.snap 与 mem.snap 都做 sync，缺文件时抛错（不静默）", async () => {
        const poolDir = mkdtempSync(join(tmpdir(), "vm-snap-fsync-"));
        try {
            const manager = new VmSnapshotManager({ snapshotPoolDir: poolDir });
            const templateHash = "t-fsync";
            const paths = manager.getSnapshotPaths(templateHash);
            manager.ensureDir(templateHash);
            writeFileSync(paths.snapshotPath, "vm");
            writeFileSync(paths.memFilePath, "mem");
            await manager.fsyncPublished(templateHash);

            rmSync(paths.memFilePath, { force: true });
            let failed = false;
            try {
                await manager.fsyncPublished(templateHash);
            } catch {
                failed = true;
            }
            expect(failed).toBe(true);
            expect(existsSync(paths.snapshotPath)).toBe(true);
        } finally {
            rmSync(poolDir, { recursive: true, force: true });
        }
    });
});
