import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync("src/sandbox/microvm/firecracker-sandbox-driver.ts", "utf8");

describe("Firecracker 驱动 · 分阶段耗时追踪", () => {
  test("支持 HARNESS_VM_PHASE_TRACE 与 config.phaseTrace 覆盖", () => {
    expect(source).toContain('process.env.HARNESS_VM_PHASE_TRACE === "1"');
    expect(source).toContain("readonly phaseTrace?: boolean;");
    expect(source).toContain("[vm-phase]");
  });

  test("覆盖创建 VM 的每个阶段（用于回答“快照恢复为什么不是几毫秒”）", () => {
    for (const phase of [
      "copy-disks", "chown-chroot", "spawn-process", "api-socket-wait",
      "copy-snapshot", "snapshot-load", "api-config-cold", "vsock-handshake", "total"
    ]) {
      expect(source).toContain('"' + phase + '"');
    }
  });

  test("默认关闭：不设环境变量时零开销（只读一个布尔）", () => {
    expect(source).toContain("if (this.phaseTrace === false) {");
  });
});
