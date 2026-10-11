import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("控制面 egress ACL（§9.7 v1.3 第 3 项）", () => {
  test("Broker 单元默认禁止所有 IP 出站", () => {
    const unit = read("deploy/harness-broker.service.example");
    expect(unit).toContain("IPAddressDeny=any");
    expect(unit).not.toContain("IPAddressAllow=");
  });

  test("Master 单元默认只允许 loopback", () => {
    const unit = read("deploy/harness.service.example");
    expect(unit).toContain("IPAddressDeny=any");
    expect(unit).toContain("IPAddressAllow=127.0.0.0/8");
  });

  test("Worker launcher 默认只允许 loopback，并支持 WORKER_EGRESS_ALLOW", () => {
    const launcher = read("scripts/harness-worker-run.sh");
    expect(launcher).toContain("WORKER_EGRESS_ALLOW");
    expect(launcher).toContain('IPAddressDeny=any');
    expect(launcher).toContain('IPAddressAllow=$EGRESS_ALLOW');
    expect(launcher).toContain('${WORKER_EGRESS_ALLOW:-127.0.0.0/8}');
    expect(launcher).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6');
    expect(launcher).toContain('AF_INET6');
  });

  test("launcher 配置示例给出模型服务放行位", () => {
    const conf = read("scripts/harness-worker-launcher.conf.example");
    expect(conf).toContain("WORKER_EGRESS_ALLOW=127.0.0.0/8,172.64.0.0/13,2606:4700:78::/48");
    expect(conf).toContain("172.64.0.0/13");
  });
});
