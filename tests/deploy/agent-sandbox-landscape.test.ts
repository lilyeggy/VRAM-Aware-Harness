import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const doc = readFileSync("docs/agent-sandbox-landscape.zh-CN.md", "utf8");

describe("主流 Agent Sandbox 调研文档", () => {
  test("覆盖主要平台与来源", () => {
    for (const name of [
      "E2B", "Fly.io Machines", "Vercel Sandbox", "AWS Lambda SnapStart", "Daytona",
      "Modal", "Blaxel", "Northflank", "Cloudflare", "CubeSandbox", "Morph Cloud",
      "CodeSandbox", "Cua / Lume", "microsandbox", "Arrakis",
    ]) {
      expect(doc).toContain(name);
    }
    expect(doc).toContain("github.com/firecracker-microvm/firecracker");
    expect(doc).toContain("github.com/TencentCloud/CubeSandbox");
  });

  test("记录 Firecracker 官方快照机制的关键原文与约束", () => {
    expect(doc).toContain("MAP_PRIVATE");
    expect(doc).toContain("sharing of memory pages and read only disks");
    expect(doc).toContain("must** be considered immutable");
    expect(doc).toContain("UFFDIO_COPY");
    expect(doc).toContain("VMGenID");
    expect(doc).toContain("resuming execution from the same state more than once insecure");
  });

  test("记录可借鉴项与我们自己的真机数据", () => {
    expect(doc).toContain("FICLONE");
    expect(doc).toContain("userfaultfd");
    expect(doc).toContain("zstd");
    expect(doc).toContain("HARNESS_VM_PHASE_TRACE");
    expect(doc).toContain("共享只读基础文件");
  });
});
