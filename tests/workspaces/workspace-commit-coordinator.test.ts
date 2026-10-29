import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceCommitCoordinator } from "../../src/workspaces/workspace-commit-coordinator.ts";

test("并发任务不同文件均可提交，同一文件冲突时整个结果不提交且成果保留", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-commit-test-"));
    const workspace = join(root, "workspace");
    const a = join(root, "a"); const b = join(root, "b"); const c = join(root, "c");
    await Promise.all([workspace, a, b, c].map((p) => mkdir(p)));
    const coordinator = new WorkspaceCommitCoordinator(join(root, "captures"));
    const input = (attemptId: string, sourcePath: string) => ({ userId: "u", workspaceId: "w", attemptId, sourcePath });
    try {
        await writeFile(join(workspace, "one"), "old");
        await Promise.all(["a", "b", "c"].map((id) => coordinator.baseline(input(id, workspace))));
        await writeFile(join(a, "one"), "A");
        await writeFile(join(b, "one"), "old"); await writeFile(join(b, "two"), "B");
        await writeFile(join(c, "one"), "C"); await writeFile(join(c, "three"), "C");
        await Promise.all([coordinator.result(input("a", a)), coordinator.result(input("b", b)), coordinator.result(input("c", c))]);
        expect(await coordinator.commit(input("a", workspace))).toEqual({ conflicts: [] });
        expect(await coordinator.commit(input("b", workspace))).toEqual({ conflicts: [] });
        expect(await coordinator.commit(input("c", workspace))).toEqual({ conflicts: ["one"] });
        expect(await readFile(join(workspace, "one"), "utf8")).toBe("A");
        expect(await readFile(join(workspace, "two"), "utf8")).toBe("B");
        await expect(readFile(join(workspace, "three"))).rejects.toThrow();
        expect(await readFile(join(c, "three"), "utf8")).toBe("C");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("提交中途丢失工作区时，下次基线恢复旧目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-recover-test-"));
    const workspace = join(root, "workspace");
    const tx = join(root, ".workspace.harness-transaction");
    try {
        await mkdir(workspace); await writeFile(join(workspace, "one"), "old"); await mkdir(tx);
        await rename(workspace, join(tx, "backup"));
        const coordinator = new WorkspaceCommitCoordinator(join(root, "captures"));
        await coordinator.baseline({ userId: "u", workspaceId: "w", attemptId: "a", sourcePath: workspace });
        expect(await readFile(join(workspace, "one"), "utf8")).toBe("old");
    } finally { await rm(root, { recursive: true, force: true }); }
});

for (const phase of ["before-exchange", "after-exchange", "after-receipt"] as const) {
    test(`进程在 ${phase} 被杀后可对账并安全重试`, async () => {
        const root = await mkdtemp(join(tmpdir(), "workspace-kill-test-"));
        const workspace = join(root, "workspace"); const result = join(root, "result");
        const captures = join(root, "captures"); const script = join(root, "child.ts");
        const input = { userId: "u", workspaceId: "w", attemptId: "attempt", sourcePath: workspace };
        try {
            await mkdir(workspace); await mkdir(result);
            await writeFile(join(workspace, "file"), "before"); await writeFile(join(result, "file"), "after");
            const coordinator = new WorkspaceCommitCoordinator(captures);
            await coordinator.baseline(input); await coordinator.result({ ...input, sourcePath: result });
            const modulePath = new URL("../../src/workspaces/workspace-commit-coordinator.ts", import.meta.url).pathname;
            await writeFile(script, `import { WorkspaceCommitCoordinator } from ${JSON.stringify(modulePath)};\n`
                + `const c = new WorkspaceCommitCoordinator(${JSON.stringify(captures)}, async p => { if (p === ${JSON.stringify(phase)}) process.kill(process.pid, 'SIGKILL'); });\n`
                + `await c.commit(${JSON.stringify(input)});\n`);
            const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "pipe" });
            expect(await child.exited).not.toBe(0);
            const recovered = new WorkspaceCommitCoordinator(captures);
            const receipt = await recovered.getReceipt(input);
            expect(receipt?.status ?? null).toBe(phase === "before-exchange" ? null : "COMMITTED");
            expect(await recovered.commit(input)).toEqual({ conflicts: [] });
            expect(await readFile(join(workspace, "file"), "utf8")).toBe("after");
            await writeFile(join(workspace, "file"), "later");
            expect(await recovered.commit(input)).toEqual({ conflicts: [] });
            expect(await readFile(join(workspace, "file"), "utf8")).toBe("later");
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}

test("目录身份与提交意图不匹配时保留证据并阻止后续写入", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-unknown-test-"));
    const workspace = join(root, "workspace"); const tx = join(root, ".workspace.harness-transaction");
    const input = { userId: "u", workspaceId: "w", attemptId: "a", sourcePath: workspace };
    try {
        await mkdir(workspace); await mkdir(tx); await mkdir(join(tx, "candidate"));
        const live = await stat(workspace);
        await writeFile(join(tx, "intent.json"), JSON.stringify({ ...input, version: 1,
            oldDev: live.dev, oldIno: live.ino, newDev: live.dev, newIno: live.ino }));
        const coordinator = new WorkspaceCommitCoordinator(join(root, "captures"));
        expect((await coordinator.getReceipt(input))?.status).toBe("UNKNOWN");
        await expect(coordinator.baseline({ ...input, attemptId: "other" })).rejects.toThrow("提交结果未知");
        expect((await stat(join(tx, "candidate"))).isDirectory()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
});
