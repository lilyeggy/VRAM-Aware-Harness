import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("microVM 启动加速台账", () => {
  test("台账存在并规定记录格式与流程地图", () => {
    const doc = read("docs/vm-startup-optimizations.zh-CN.md");
    expect(doc).toContain("持续累积");
    expect(doc).toContain("背景");
    expect(doc).toContain("机制");
    expect(doc).toContain("实测");
    expect(doc).toContain("代价");
    expect(doc).toContain("提交");
    // 流程地图必须覆盖两条启动路径与关键阶段名
    expect(doc).toContain("冷启动路径");
    expect(doc).toContain("快照恢复路径");
    for (const phase of [
      "copy-disks",
      "api-socket-wait",
      "vsock-handshake",
      "make-snapshot",
      "copy-snapshot",
      "snapshot-load",
      "share-base",
      "share-snapshot",
    ]) {
      expect(doc).toContain(phase);
    }
  });

  test("已实施优化条目与真机数字齐全", () => {
    const doc = read("docs/vm-startup-optimizations.zh-CN.md");
    expect(doc).toContain("O1");
    expect(doc).toContain("warmHit");
    expect(doc).toContain("O2");
    expect(doc).toContain("HARNESS_VM_PHASE_TRACE");
    expect(doc).toContain("O3");
    expect(doc).toContain("HARNESS_VM_SHARE_BASE_FILES");
    expect(doc).toContain("HARNESS_VM_SHARE_ROOTFS");
    expect(doc).toContain("498.3ms");
    expect(doc).toContain("175.9ms");
    expect(doc).toContain("101.3ms");
    expect(doc).toContain("578e132");
  });

  test("保留对旧错误结论的更正记录", () => {
    const doc = read("docs/vm-startup-optimizations.zh-CN.md");
    expect(doc).toContain("更正记录");
    expect(doc).toContain("sharing of memory pages and read only disks");
    expect(doc).toContain("MAP_PRIVATE");
  });

  test("README 指向台账", () => {
    expect(read("README.md")).toContain("docs/vm-startup-optimizations.zh-CN.md");
  });
});
