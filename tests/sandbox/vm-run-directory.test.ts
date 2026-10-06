import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { statSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { VmRunDirectoryManager } from "../../src/sandbox/microvm/vm-run-directory";

describe("VmRunDirectoryManager", () => {
    const testRuntimeRoot = resolve(process.cwd(), "data/test-vm-runtime");

    beforeEach(() => {
        rmSync(testRuntimeRoot, { recursive: true, force: true });
        mkdirSync(testRuntimeRoot, { recursive: true });
    });

    afterEach(() => {
        rmSync(testRuntimeRoot, { recursive: true, force: true });
    });

    it("创建目录权限为 0700 (stat mode & 0o777 === 0o700)", async () => {
        const manager = new VmRunDirectoryManager({ runtimeRoot: testRuntimeRoot });
        const dir = manager.allocate("sbx-valid-123");

        expect(existsSync(dir.root)).toBe(true);
        const st = statSync(dir.root);
        expect(st.mode & 0o777).toBe(0o700);

        expect(dir.socketPath()).toBe(resolve(dir.root, "firecracker.socket"));
        expect(dir.vsockUdsPath()).toBe(resolve(dir.root, "vsock.sock"));
        expect(dir.rootfsPath()).toBe(resolve(dir.root, "rootfs.ext4"));
        expect(dir.workspaceDiskPath()).toBe(resolve(dir.root, "workspace.ext4"));

        await dir.dispose();
        expect(existsSync(dir.root)).toBe(false);
    });

    it("非法 sandboxId（含 ..、/、超长、空）抛错", () => {
        const manager = new VmRunDirectoryManager({ runtimeRoot: testRuntimeRoot });

        expect(() => manager.allocate("../escape")).toThrow(/Invalid sandboxId/);
        expect(() => manager.allocate("foo/bar")).toThrow(/Invalid sandboxId/);
        expect(() => manager.allocate("")).toThrow(/Invalid sandboxId/);
        expect(() => manager.allocate("a".repeat(65))).toThrow(/Invalid sandboxId/);
        expect(() => manager.allocate("has spaces")).toThrow(/Invalid sandboxId/);
        expect(() => manager.allocate("evil;rm -rf")).toThrow(/Invalid sandboxId/);
    });

    it("dispose 幂等、listOrphans 返回实际目录且忽略不存在根目录", async () => {
        const manager = new VmRunDirectoryManager({ runtimeRoot: testRuntimeRoot });

        expect(manager.listOrphans()).toEqual([]);

        const dir1 = manager.allocate("sbx-orphan-1");
        const dir2 = manager.allocate("sbx-orphan-2");

        const orphans = manager.listOrphans().sort();
        expect(orphans).toEqual(["sbx-orphan-1", "sbx-orphan-2"]);

        // dispose 幂等测试
        await manager.dispose("sbx-orphan-1");
        expect(existsSync(dir1.root)).toBe(false);
        await manager.dispose("sbx-orphan-1"); // 重复调用不报错
        expect(manager.listOrphans()).toEqual(["sbx-orphan-2"]);

        await dir2.dispose();
        await dir2.dispose(); // 重复调用不报错
        expect(manager.listOrphans()).toEqual([]);

        // 当 runtimeRoot 不存在时
        const nonExistentManager = new VmRunDirectoryManager({
            runtimeRoot: resolve(testRuntimeRoot, "non-existent"),
        });
        expect(nonExistentManager.listOrphans()).toEqual([]);
        await nonExistentManager.dispose("any-id"); // 依然不报错
    });
});
