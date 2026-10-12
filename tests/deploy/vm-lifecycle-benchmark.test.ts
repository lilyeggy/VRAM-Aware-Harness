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

  test("共享只读基础文件的 A/B 数字与踩坑已归档", () => {
    const doc = read("docs/vm-lifecycle-benchmark.zh-CN.md");
    expect(doc).toContain("HARNESS_VM_SHARE_BASE_FILES=1");
    expect(doc).toContain("HARNESS_VM_SHARE_ROOTFS=1");
    expect(doc).toContain("498.3ms");
    expect(doc).toContain("175.9ms");
    expect(doc).toContain("101.3ms");
    expect(doc).toContain("EXDEV");
    expect(doc).toContain("O_RDWR");
    expect(doc).toContain("Read-only file");
    const env = read(".env.example");
    expect(env).toContain("HARNESS_VM_SHARE_BASE_FILES");
    expect(env).toContain("HARNESS_VM_SHARE_ROOTFS");
    expect(env).toContain("HARNESS_VM_PHASE_TRACE");
    const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
    expect(driver).toContain("HARNESS_VM_PHASE_TRACE");
  });

  test("§9.8 记录共享只读基础文件并已更正旧结论", () => {
    const boundary = read("docs/platform-boundary.md");
    expect(boundary).toContain("HARNESS_VM_SHARE_BASE_FILES");
    expect(boundary).toContain("175.9ms");
    expect(boundary).toContain("101.3ms");
    // 旧文档曾断言“硬链接内存镜像不安全”，与 Firecracker 官方结论相反，必须保留更正说明
    expect(boundary).toContain("sharing of memory pages and read only disks");
    expect(boundary).toContain("该文件在 VM 存活期间不可变");
    const deploy = read("docs/deployment-single-node-systemd.zh-CN.md");
    expect(deploy).toContain("HARNESS_VM_SHARE_BASE_FILES");
    expect(deploy).toContain("同一文件系统");
  });
});
