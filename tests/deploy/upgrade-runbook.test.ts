import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("升级/回滚 runbook", () => {
  test("升级步骤要求先备份、锁定依赖并停 Master", () => {
    const doc = read("docs/upgrade-rollback-runbook.zh-CN.md");
    expect(doc).toContain("harness-ops.ts backup");
    expect(doc).toContain("systemctl stop harness.service");
    expect(doc).toContain("bun install --frozen-lockfile");
    expect(doc).toContain("向前");
  });

  test("回滚步骤要求恢复数据库并回到旧版本", () => {
    const doc = read("docs/upgrade-rollback-runbook.zh-CN.md");
    expect(doc).toContain("harness-ops.ts restore");
    expect(doc).toContain("git checkout <升级前 commit>");
    expect(doc).toContain("P0_E2E_SMOKE_OK");
  });

  test("文件日志轮转示例覆盖 Master 日志", () => {
    const logrotate = read("deploy/harness-logrotate.example");
    expect(logrotate).toContain("/var/log/harness/master.log");
    expect(logrotate).toContain("rotate 14");
  });
});
