import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunWorkspaceResultCoordinator } from "../../src/workspaces/run-workspace-result.ts";
import { RunWorkspaceResultStore } from "../../src/workspaces/run-workspace-result-store.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import { RunArtifactStore } from "../../src/workspaces/run-artifact-store.ts";

test("Run 前后 Workspace 快照生成用户结果 Diff", async () => {
    const root = `/tmp/harness-result-${crypto.randomUUID()}`;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "before");
    const result = new RunWorkspaceResultCoordinator();
    await result.captureBefore("run", root);
    await writeFile(join(root, "a.txt"), "after");
    await writeFile(join(root, "artifact.txt"), "artifact");
    const diff = await result.captureAfter("run", root);
    expect(diff?.modified.map((item) => item.after.path)).toEqual(["a.txt"]);
    expect(diff?.added.map((item) => item.path)).toEqual(["artifact.txt"]);
    await rm(root, { recursive: true, force: true });
});

test("Workspace Diff 可在协调器重建后从 SQLite 读取", async () => {
    const root = `/tmp/harness-persisted-result-${crypto.randomUUID()}`;
    const db = openHarnessDatabase(":memory:");
    await mkdir(root, { recursive: true });
    try {
        // 外键要求运行记录存在；此处只验证 Store，因此用最小父记录关闭外键约束。
        db.exec("PRAGMA foreign_keys = OFF;");
        await writeFile(join(root, "result.txt"), "before");
        const first = new RunWorkspaceResultCoordinator(new RunWorkspaceResultStore(db));
        await first.captureBefore("persisted-run", root);
        await writeFile(join(root, "result.txt"), "after");
        await first.captureAfter("persisted-run", root);
        const second = new RunWorkspaceResultCoordinator(new RunWorkspaceResultStore(db));
        expect(second.getDiff("persisted-run")?.modified).toHaveLength(1);
    } finally {
        db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("终态 Run 把已验证的新增文件保存为不可变 Artifact", async () => {
    const root = `/tmp/harness-artifact-workspace-${crypto.randomUUID()}`;
    const artifacts = `/tmp/harness-artifact-store-${crypto.randomUUID()}`;
    const db = openHarnessDatabase(":memory:");
    try {
        db.exec("PRAGMA foreign_keys = OFF;");
        await mkdir(root, { recursive: true });
        const runId = crypto.randomUUID();
        const result = new RunWorkspaceResultCoordinator(
            new RunWorkspaceResultStore(db),
            new RunArtifactStore(db, artifacts),
        );
        await result.captureBefore(runId, root);
        await writeFile(join(root, "report.txt"), "immutable result");
        await result.captureAfter(runId, root);
        expect((await result.captureArtifacts(runId, root)).map((item) => item.path)).toEqual(["report.txt"]);
        const first = await result.readArtifact(runId, "report.txt");
        expect(first).not.toBeNull();
        expect(new TextDecoder().decode(first!)).toBe("immutable result");
        await writeFile(join(root, "report.txt"), "changed later");
        const afterWorkspaceMutation = await result.readArtifact(runId, "report.txt");
        expect(afterWorkspaceMutation).not.toBeNull();
        expect(new TextDecoder().decode(afterWorkspaceMutation!)).toBe("immutable result");
    } finally {
        db.close();
        await rm(root, { recursive: true, force: true });
        await rm(artifacts, { recursive: true, force: true });
    }
});
