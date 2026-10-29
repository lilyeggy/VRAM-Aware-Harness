import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync, statSync } from "node:fs";
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

    it.skipIf(Bun.which("debugfs") === null)("debugfs 对损坏磁盘返回诊断时拒绝假成功", async () => {
        const disk = join(testDir, "invalid.ext4");
        writeFileSync(disk, "not an ext4 image");
        await expect(new WorkspaceDiskExporter().exportToHost(disk, dstDir))
            .rejects.toThrow("debugfs 工作区导出失败");
    });

    it("完整采集目录源时不写入共享工作区，缺失来源直接失败", async () => {
        writeFileSync(join(srcDir, "data"), "result");
        const exporter = new WorkspaceDiskExporter();
        const text = await exporter.withStoppedDiskContents(srcDir, async (source) => readFileSync(join(source, "data"), "utf8"));
        expect(text).toBe("result");
        expect(existsSync(join(dstDir, "data"))).toBe(false);
        await expect(exporter.withStoppedDiskContents(join(testDir, "missing"), async () => undefined)).rejects.toThrow();
    });

    it.skipIf(process.geteuid?.() !== 0 || Bun.which("debugfs") === null || Bun.which("mke2fs") === null)(
        "真实 ext4 完整导出保留文件权限和空目录，并移除空的系统 lost+found", async () => {
            mkdirSync(join(srcDir, "empty"));
            writeFileSync(join(srcDir, "script"), "hello");
            chmodSync(join(srcDir, "script"), 0o751);
            const disk = join(testDir, "disk.ext4");
            expect(Bun.spawnSync(["truncate", "-s", "32M", disk]).exitCode).toBe(0);
            expect(Bun.spawnSync(["mke2fs", "-q", "-t", "ext4", "-F", "-d", srcDir, disk]).exitCode).toBe(0);
            await new WorkspaceDiskExporter().withStoppedDiskContents(disk, async (source) => {
                expect(readFileSync(join(source, "script"), "utf8")).toBe("hello");
                expect(statSync(join(source, "script")).mode & 0o777).toBe(0o751);
                expect(statSync(join(source, "empty")).isDirectory()).toBe(true);
                expect(existsSync(join(source, "lost+found"))).toBe(false);
            });
        },
    );
});
