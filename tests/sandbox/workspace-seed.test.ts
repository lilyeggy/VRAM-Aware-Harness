import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    computeWorkspaceImageBlocks,
    prepareWorkspaceDiskFromHost,
    summarizeSeedDirectory,
    workspaceSeedRequiredBytes,
    WORKSPACE_SEED_ENV,
} from "../../src/sandbox/microvm/firecracker-sandbox-driver.ts";

const scratchDirs: string[] = [];
const hasMke2fs = Bun.which("mke2fs") !== null;
const hasDebugfs = Bun.which("debugfs") !== null;

function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "workspace-seed-test-"));
    scratchDirs.push(dir);
    return dir;
}

function makeTemplate(dir: string, bytes: number): string {
    const template = join(dir, "workspace-template.ext4");
    const proc = Bun.spawnSync(["truncate", "-s", String(bytes), template]);
    if (proc.exitCode === 0) {
        return template;
    }
    writeFileSync(template, Buffer.alloc(bytes));
    return template;
}

afterEach(() => {
    while (scratchDirs.length > 0) {
        const dir = scratchDirs.pop();
        if (dir === undefined) {
            continue;
        }
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("工作区磁盘播种（F-K 修复）", () => {
    test("容量预检与块数换算：盘容量恒等于模板容量", () => {
        expect(workspaceSeedRequiredBytes(0)).toBe(8 * 1024 * 1024);
        expect(computeWorkspaceImageBlocks(128 * 1024 * 1024)).toBe(32768);
        // 极小的模板也要保证 mke2fs 可用（下限 1024 块 = 4MiB）
        expect(computeWorkspaceImageBlocks(1024)).toBe(1024);
    });

    test("summarizeSeedDirectory 统计内容并跳过 lost+found 与导出临时目录", () => {
        const dir = scratch();
        mkdirSync(join(dir, "lost+found"));
        mkdirSync(join(dir, ".tmp-dump-123"));
        mkdirSync(join(dir, "sub"));
        writeFileSync(join(dir, "a.txt"), "aaaa");
        writeFileSync(join(dir, "sub", "b.txt"), "bb");
        writeFileSync(join(dir, "lost+found", "ignored"), "xxxxx");
        const summary = summarizeSeedDirectory(dir);
        // 目录 sub + 文件 a.txt + 文件 sub/b.txt
        expect(summary.entries).toBe(3);
        expect(summary.bytes).toBe(6);
    });

    test("工作区为空时走模板复制快路径（不调用 mke2fs）", async () => {
        const dir = scratch();
        const template = makeTemplate(dir, 4 * 1024 * 1024);
        const seed = join(dir, "workspace");
        mkdirSync(seed);
        const dest = join(dir, "out", "workspace.ext4");
        const emptyResult = await prepareWorkspaceDiskFromHost(template, seed, dest);
        expect(emptyResult.seeded).toBe(false);
        expect(statSync(dest).size).toBe(statSync(template).size);
    });

    test.skipIf(hasMke2fs === false)("非空工作区被播种进本 Run 的盘", async () => {
        const dir = scratch();
        const template = makeTemplate(dir, 16 * 1024 * 1024);
        const seed = join(dir, "workspace");
        mkdirSync(seed);
        writeFileSync(join(seed, "persist.txt"), "persist-check-123\n");
        const dest = join(dir, "out", "workspace.ext4");
        const seededResult = await prepareWorkspaceDiskFromHost(template, seed, dest);
        expect(seededResult.seeded).toBe(true);
        expect(statSync(dest).size).toBe(statSync(template).size);
        if (hasDebugfs === false) {
            expect(statSync(dest).size).toBeGreaterThan(0);
            return;
        }
        const listing = Bun.spawnSync(["debugfs", "-R", "ls -l /", dest]);
        const text = new TextDecoder().decode(listing.stdout);
        expect(text).toContain("persist.txt");
    });

    test.skipIf(hasMke2fs === false)("内容超过模板容量时 fail-closed（放大会破坏快照 geometry）", async () => {
        const dir = scratch();
        const template = makeTemplate(dir, 4 * 1024 * 1024);
        const seed = join(dir, "workspace");
        mkdirSync(seed);
        writeFileSync(join(seed, "big.bin"), Buffer.alloc(8 * 1024 * 1024));
        const dest = join(dir, "out", "workspace.ext4");
        let message = "";
        try {
            const escapeResult = await prepareWorkspaceDiskFromHost(template, seed, dest);
            expect(escapeResult.seeded).toBe(false);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("超过模板容量");
    });

    test.skipIf(hasMke2fs === false)("HARNESS_VM_WORKSPACE_SEED=0 时退回模板复制（逃生阀）", async () => {
        const dir = scratch();
        const template = makeTemplate(dir, 16 * 1024 * 1024);
        const seed = join(dir, "workspace");
        mkdirSync(seed);
        writeFileSync(join(seed, "persist.txt"), "persist-check-123\n");
        const dest = join(dir, "out", "workspace.ext4");
        const previous = process.env[WORKSPACE_SEED_ENV];
        process.env[WORKSPACE_SEED_ENV] = "0";
        try {
            await prepareWorkspaceDiskFromHost(template, seed, dest);
        } finally {
            if (previous === undefined) {
                delete process.env[WORKSPACE_SEED_ENV];
            } else {
                process.env[WORKSPACE_SEED_ENV] = previous;
            }
        }
        expect(statSync(dest).size).toBe(statSync(template).size);
        if (hasDebugfs) {
            const listing = Bun.spawnSync(["debugfs", "-R", "ls -l /", dest]);
            const text = new TextDecoder().decode(listing.stdout);
            expect(text).not.toContain("persist.txt");
        }
    });

    test("接线守卫：Provider 传宿主工作区目录，驱动两条创建路径都经过播种", () => {
        const provider = readFileSync("src/sandbox/microvm/microvm-sandbox-provider.ts", "utf8");
        expect(provider).toContain("workspaceSeedPath: input.workspacePath");
        const driver = readFileSync("src/sandbox/microvm/firecracker-sandbox-driver.ts", "utf8");
        const seeded = driver.match(/prepareWorkspaceDiskFromHost\(workspaceTemplate, options\.workspaceSeedPath/g);
        expect(seeded === null ? 0 : seeded.length).toBe(2);
        // 直接复制工作区模板的旧路径必须全部消失（否则 jailer/非 jailer 会漏掉播种）
        expect(driver).not.toContain("copyFileReflink(workspaceTemplate");
        expect(driver).toContain("mke2fs");
        // 播种盘的 ext4 布局与快照时不同（真机第二轮 cat 报 Bad message）：播种 Run 必须冷启动
        expect(driver).toContain("workspaceDiskSeeded === false && this.snapshotManager.hasSnapshot");
        expect(driver).toContain("canRestore === false && workspaceDiskSeeded === false");
        expect(driver).toContain("workspaceDiskSeeded = (await prepareWorkspaceDiskFromHost");
        expect(driver).toContain("return { seeded: true };");
    });
});
