import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("microVM 生命周期基准", () => {
  test("基准脚本存在并暴露关键开关", () => {
    const script = read("scripts/vm-lifecycle-benchmark.ts");
    expect(script).toContain("HARNESS_BENCH_MODE");
    expect(script).toContain("HARNESS_BENCH_CONCURRENCY");
    expect(script).toContain("HARNESS_BENCH_COLD_CONCURRENCY");
    expect(script).toContain("HARNESS_BENCH_EXEC_PROBE");
    expect(script).toContain("VM_BENCHMARK_OK");
    expect(script).toContain("FirecrackerSandboxDriver");
  });

  test("基准文档记录真机数字与 warmHit", () => {
    const doc = read("docs/vm-lifecycle-benchmark.zh-CN.md");
    expect(doc).toContain("172.17.43.193");
    expect(doc).toContain("warmHit");
    expect(doc).toContain("766ms");
    expect(doc).toContain("2866ms");
  });
});
