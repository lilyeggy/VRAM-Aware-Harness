import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { WorkspaceDiskExporter, isWithin } from "../../src/sandbox/microvm/workspace-disk-exporter";

describe("WorkspaceDiskExporter", () => {
    const testDir = resolve(process.cwd(), "data/test-exporter");
    const srcDir = join(testDir, "src");
    const dstDir = join(testDir, "dst");

    beforeEach(() => {
        rmSync(testDir, { recursive: true, force: true });
        mkdirSync(srcDir, { recursive: true });
        mkdirSync(dstDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it("isWithin 安全防线校验", () => {
        expect(isWithin("/srv/workspace", "/srv/workspace/code.py")).toBe(true);
        expect(isWithin("/srv/workspace", "/srv/workspace/nested/dir/file.txt")).toBe(true);
        expect(isWithin("/srv/workspace", "/srv/workspace/../etc/passwd")).toBe(false);
        expect(isWithin("/srv/workspace", "/etc/passwd")).toBe(false);
    });

    it("正确导出嵌套文件，且符号链接一律跳过记入 skipped", async () => {
        // 创建正规文件
        writeFileSync(join(srcDir, "hello.txt"), "hello world");
        mkdirSync(join(srcDir, "sub"), { recursive: true });
        writeFileSync(join(srcDir, "sub/config.json"), JSON.stringify({ key: "val" }));

        // 创建恶意符号链接 (指向 /etc/hosts 或任意外部文件)
        try {
            symlinkSync("/etc/hosts", join(srcDir, "evil_symlink"));
        } catch {
            // 在受限环境下若无法创建外部链接则软链到内部文件
            symlinkSync(join(srcDir, "hello.txt"), join(srcDir, "evil_symlink"));
        }

        const exporter = new WorkspaceDiskExporter();
        const res = await exporter.exportToHost(srcDir, dstDir);

        expect(res.filesWritten).toBe(2);
        expect(res.bytesWritten).toBeGreaterThan(0);
        expect(existsSync(join(dstDir, "hello.txt"))).toBe(true);
        expect(readFileSync(join(dstDir, "hello.txt"), "utf8")).toBe("hello world");
        expect(existsSync(join(dstDir, "sub/config.json"))).toBe(true);

        // 验证符号链接被跳过且记入 skipped
        expect(existsSync(join(dstDir, "evil_symlink"))).toBe(false);
        expect(res.skipped.length).toBe(1);
        expect(res.skipped[0]?.reason).toContain("symbolic link skipped");
    });

    it("源路径不存在时静默返回 0 写入", async () => {
        const exporter = new WorkspaceDiskExporter();
        const res = await exporter.exportToHost("/nonexistent/disk.ext4", dstDir);
        expect(res.filesWritten).toBe(0);
        expect(res.bytesWritten).toBe(0);
        expect(res.skipped).toEqual([]);
    });
});
