import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VmSnapshotManager } from "../../src/sandbox/microvm/vm-snapshot-manager.ts";

function makePool(): { root: string; manager: VmSnapshotManager } {
    const root = mkdtempSync(join(tmpdir(), "snap-publish-"));
    return { root, manager: new VmSnapshotManager({ snapshotPoolDir: root }) };
}

const HASH = "a".repeat(64);

describe("VmSnapshotManager：快照原子发布（共享只读前提）", () => {
    test("staging 发布后成为最终快照目录", () => {
        const { root, manager } = makePool();
        try {
            const staging = manager.createStagingDir(HASH);
            const staged = manager.stagingSnapshotPaths(staging);
            writeFileSync(staged.snapshotPath, "VM-SNAP");
            writeFileSync(staged.memFilePath, "MEM-SNAP");
            manager.publishStaging(HASH, staging);

            const finalPaths = manager.getSnapshotPaths(HASH);
            expect(existsSync(staging)).toBe(false);
            expect(readFileSync(finalPaths.snapshotPath, "utf8")).toBe("VM-SNAP");
            expect(readFileSync(finalPaths.memFilePath, "utf8")).toBe("MEM-SNAP");
            expect(manager.hasSnapshot(HASH)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("发布新快照不会改动正在运行的 VM 已映射的旧 inode", () => {
        const { root, manager } = makePool();
        try {
            const first = manager.createStagingDir(HASH);
            const firstPaths = manager.stagingSnapshotPaths(first);
            writeFileSync(firstPaths.snapshotPath, "VM-V1");
            writeFileSync(firstPaths.memFilePath, "MEM-V1");
            manager.publishStaging(HASH, first);

            // 模拟一台运行中的 VM：硬链接池内内存文件（共享只读模式的真实行为）
            const inUse = join(root, "in-use-mem.snap");
            const poolPaths = manager.getSnapshotPaths(HASH);
            linkSync(poolPaths.memFilePath, inUse);
            const inUseIno = readFileSync(inUse, "utf8");
            expect(inUseIno).toBe("MEM-V1");

            const second = manager.createStagingDir(HASH);
            const secondPaths = manager.stagingSnapshotPaths(second);
            writeFileSync(secondPaths.snapshotPath, "VM-V2");
            writeFileSync(secondPaths.memFilePath, "MEM-V2");
            manager.publishStaging(HASH, second);

            // 池内是新的；运行中的 VM 仍读到旧内容（旧 inode 未被截断）
            expect(readFileSync(manager.getSnapshotPaths(HASH).memFilePath, "utf8")).toBe("MEM-V2");
            expect(readFileSync(inUse, "utf8")).toBe("MEM-V1");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("staging 缺文件时拒绝发布，discardStaging 清理", () => {
        const { root, manager } = makePool();
        try {
            const staging = manager.createStagingDir(HASH);
            const staged = manager.stagingSnapshotPaths(staging);
            writeFileSync(staged.snapshotPath, "ONLY-VM-SNAP");
            expect(() => manager.publishStaging(HASH, staging)).toThrow("staging 目录缺少快照文件");
            expect(manager.hasSnapshot(HASH)).toBe(false);
            manager.discardStaging(staging);
            expect(existsSync(staging)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
