import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceCaptureStore } from "../../src/workspaces/workspace-capture-store.ts";

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "harness-capture-"));
    const source = join(root, "workspace");
    await mkdir(source);
    const store = new WorkspaceCaptureStore(join(root, "captures"));
    const input = { userId: "user-a", workspaceId: "workspace-a", attemptId: "attempt-a", sourcePath: source };
    return { root, source, store, input };
}

test("基线和成果各自保存真实文件，覆盖大文件、隐藏目录和空目录", async () => {
    const { root, source, store, input } = await fixture();
    try {
        await mkdir(join(source, ".git"));
        await mkdir(join(source, "empty"));
        await writeFile(join(source, ".git", "metadata"), "metadata");
        const large = Buffer.alloc(2 * 1024 * 1024 + 17, 42);
        await writeFile(join(source, "large.bin"), large);
        await writeFile(join(source, "a.txt"), "before");
        const baseline = await store.captureBaseline(input);
        expect(baseline.manifest.entries.map((entry) => entry.path)).toEqual([
            ".git", ".git/metadata", "a.txt", "empty", "large.bin",
        ]);
        expect(await readFile(join(baseline.filesPath, "large.bin"))).toEqual(large);
        expect(baseline.manifest.entries.find((entry) => entry.path === "large.bin"))
            .toMatchObject({ hash: createHash("sha256").update(large).digest("hex"), size: large.length });
        await writeFile(join(source, "a.txt"), "after");
        const result = await store.captureResult(input);
        await writeFile(join(source, "a.txt"), "later");
        expect(await readFile(join(baseline.filesPath, "a.txt"), "utf8")).toBe("before");
        expect(await readFile(join(result.filesPath, "a.txt"), "utf8")).toBe("after");
        expect((await store.get(input, "result"))?.manifest).toEqual(result.manifest);
        expect(baseline.manifest.entries.find((entry) => entry.path === "a.txt"))
            .not.toEqual(result.manifest.entries.find((entry) => entry.path === "a.txt"));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("不支持的符号链接拒绝整个捕获，不能留下已发布的半份基线", async () => {
    const { root, source, store, input } = await fixture();
    try {
        await writeFile(join(source, "safe"), "ok");
        await symlink("safe", join(source, "link"));
        await expect(store.captureBaseline(input)).rejects.toThrow("Unsupported symbolic link");
        expect(await store.get(input, "baseline")).toBeNull();
        expect(await readFile(join(source, "safe"), "utf8")).toBe("ok");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("硬链接不会被静默降级成普通文件", async () => {
    const { root, source, store, input } = await fixture();
    try {
        await writeFile(join(source, "a"), "content");
        await link(join(source, "a"), join(source, "b"));
        await expect(store.captureBaseline(input)).rejects.toThrow("hard-linked");
        expect(await store.get(input, "baseline")).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("Linux 特殊权限不会被静默丢弃", async () => {
    const { root, source, store, input } = await fixture();
    try {
        await writeFile(join(source, "a"), "content");
        // Bun's fs.chmod may mask special bits on Linux; use the OS chmod so
        // this test actually exercises a setuid file.
        const chmodProcess = Bun.spawn(["chmod", "4755", join(source, "a")]);
        expect(await chmodProcess.exited).toBe(0);
        await expect(store.captureBaseline(input)).rejects.toThrow("special mode bits");
        expect(await store.get(input, "baseline")).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("超过文件或字节上限时拒绝捕获，允许修正后重试", async () => {
    const { root, source, input } = await fixture();
    try {
        await writeFile(join(source, "a"), "12345");
        const limited = new WorkspaceCaptureStore(join(root, "limited"), { maxBytes: 4 });
        await expect(limited.captureBaseline(input)).rejects.toThrow("maximum bytes");
        expect(await limited.get(input, "baseline")).toBeNull();
        const retry = new WorkspaceCaptureStore(join(root, "limited"), { maxBytes: 5 });
        expect((await retry.captureBaseline(input)).manifest.entries).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("重复捕获不会覆盖已发布成果，且结果需要匹配的基线", async () => {
    const { root, source, store, input } = await fixture();
    try {
        await writeFile(join(source, "a"), "first");
        await expect(store.captureResult(input)).rejects.toThrow("without its baseline");
        const first = await store.captureBaseline(input);
        await writeFile(join(source, "a"), "second");
        await expect(store.captureBaseline(input)).rejects.toThrow();
        expect(await readFile(join(first.filesPath, "a"), "utf8")).toBe("first");
        expect(await store.get({ ...input, userId: "another-user" }, "baseline")).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("拒绝来源和暂存目录相互包含", async () => {
    const { root, source, input } = await fixture();
    try {
        const overlapping = new WorkspaceCaptureStore(join(source, "captures"));
        await expect(overlapping.captureBaseline(input)).rejects.toThrow("must not overlap");
        expect(existsSync(join(source, "captures"))).toBe(false);
        await symlink(source, join(root, "alias"));
        const aliased = new WorkspaceCaptureStore(join(root, "alias", "captures"));
        await expect(aliased.captureBaseline(input)).rejects.toThrow("must not overlap");
        expect(existsSync(join(source, "captures"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("并发创建同一基线最多成功一次，不能覆盖已发布副本", async () => {
    const { root, source, store, input } = await fixture();
    try {
        await writeFile(join(source, "a"), "original");
        const results = await Promise.allSettled([store.captureBaseline(input), store.captureBaseline(input)]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        const capture = await store.get(input, "baseline");
        expect(capture).not.toBeNull();
        expect(await readFile(join(capture!.filesPath, "a"), "utf8")).toBe("original");
    } finally { await rm(root, { recursive: true, force: true }); }
});
