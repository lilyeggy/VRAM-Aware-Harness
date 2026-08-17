import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diffWorkspace, snapshotWorkspace } from "../../src/workspaces/workspace-snapshot.ts";

test("不存在的 Workspace 形成空 manifest，而不是阻断任务收敛", async () => {
    expect(await snapshotWorkspace(`/tmp/harness-missing-${crypto.randomUUID()}`)).toEqual([]);
});

test("Workspace 快照忽略非交付目录，并生成新增修改删除 Diff", async () => {
    const root = `/tmp/harness-snapshot-${crypto.randomUUID()}`;
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "a.txt"), "before");
    await writeFile(join(root, ".git", "ignored"), "secret");
    const before = await snapshotWorkspace(root);
    await writeFile(join(root, "a.txt"), "after");
    await writeFile(join(root, "new.txt"), "new");
    const after = await snapshotWorkspace(root);
    const diff = diffWorkspace(before, after);
    expect(before.map((file) => file.path)).toEqual(["a.txt"]);
    expect(diff.added.map((file) => file.path)).toEqual(["new.txt"]);
    expect(diff.modified.map((item) => item.after.path)).toEqual(["a.txt"]);
    expect(diff.deleted).toEqual([]);
    await rm(root, { recursive: true, force: true });
});
