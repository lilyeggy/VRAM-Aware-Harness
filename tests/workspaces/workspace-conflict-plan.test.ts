import { expect, test } from "bun:test";
import type { WorkspaceCaptureEntry, WorkspaceCaptureKind, WorkspaceCaptureManifest } from "../../src/workspaces/workspace-capture-store.ts";
import { planWorkspaceChanges } from "../../src/workspaces/workspace-conflict-plan.ts";

const file = (path: string, hash: string): WorkspaceCaptureEntry => ({ path, kind: "file", mode: 0o644, size: 1, hash });
const dir = (path: string): WorkspaceCaptureEntry => ({ path, kind: "directory", mode: 0o755 });
const manifest = (kind: WorkspaceCaptureKind, entries: WorkspaceCaptureEntry[]): WorkspaceCaptureManifest => ({
    version: 1, kind, userId: "user", workspaceId: "ws", attemptId: "attempt", entries,
});
const plan = (base: WorkspaceCaptureEntry[], result: WorkspaceCaptureEntry[], current: WorkspaceCaptureEntry[]) =>
    planWorkspaceChanges(manifest("baseline", base), manifest("result", result), manifest("baseline", current));

test("不同文件可提交，同一文件的并发修改报告冲突", () => {
    const base = [file("a", "1"), file("b", "1")];
    expect(plan(base, [file("a", "2"), file("b", "1")], [file("a", "1"), file("b", "2")]))
        .toEqual({ changes: ["a"], conflicts: [] });
    expect(plan(base, [file("a", "2"), file("b", "1")], [file("a", "3"), file("b", "1")]))
        .toEqual({ changes: ["a"], conflicts: ["a"] });
});

test("删除目录不会丢失并发新增或修改的子文件", () => {
    const base = [dir("d"), file("d/a", "1")];
    expect(plan(base, [], [dir("d"), file("d/a", "2"), file("d/b", "1")]).conflicts)
        .toEqual(["d/a", "d/b"]);
});

test("相同新增目录下不同文件可并行提交，父目录被替换时报冲突", () => {
    expect(plan([], [dir("d"), file("d/a", "1")], [dir("d"), file("d/b", "1")]).conflicts).toEqual([]);
    expect(plan([dir("d")], [dir("d"), file("d/a", "1")], [file("d", "2")]).conflicts).toEqual(["d/a"]);
});

test("拒绝逃逸路径、重复路径和不匹配的执行身份", () => {
    expect(() => plan([], [file("../outside", "1")], [])).toThrow("Invalid Workspace capture path");
    expect(() => plan([], [file("a", "1"), file("a", "2")], [])).toThrow("Invalid Workspace capture path");
    expect(() => planWorkspaceChanges(manifest("baseline", []), { ...manifest("result", []), attemptId: "other" }, manifest("baseline", []))).toThrow();
});
