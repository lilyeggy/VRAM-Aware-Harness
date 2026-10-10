import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("开发用 TLS 反向代理", () => {
  test("脚本只反代 loopback 并补 X-Forwarded-Proto", () => {
    const script = read("scripts/dev-tls-proxy.ts");
    expect(script).toContain("Bun.serve");
    expect(script).toContain("127.0.0.1:3100");
    expect(script).toContain('headers.set("x-forwarded-proto", "https")');
  });

  test("TLS 文档给出无 Caddy/Nginx 时的临时验证步骤", () => {
    const doc = read("docs/tls-reverse-proxy.zh-CN.md");
    expect(doc).toContain("scripts/dev-tls-proxy.ts");
    expect(doc).toContain("NODE_EXTRA_CA_CERTS");
    expect(doc).toContain("HARNESS_BASE_URL=https://127.0.0.1:8443");
  });
});
