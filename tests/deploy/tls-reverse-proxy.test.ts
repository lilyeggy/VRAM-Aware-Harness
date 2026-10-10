import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("TLS / 反向代理部署样例", () => {
  test("Caddy 示例只反代 loopback 并终止 TLS", () => {
    const caddy = read("deploy/harness-caddy.example");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:3100");
    expect(caddy).toContain("tls internal");
    expect(caddy).toContain("Strict-Transport-Security");
  });

  test("Nginx 示例只反代 loopback 并传递 X-Forwarded-Proto", () => {
    const nginx = read("deploy/harness-nginx.example");
    expect(nginx).toContain("listen 443 ssl");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3100");
    expect(nginx).toContain("X-Forwarded-Proto $scheme");
  });

  test("部署文档明确 Master 只监听 loopback 且不放行 3100", () => {
    const doc = read("docs/tls-reverse-proxy.zh-CN.md");
    expect(doc).toContain("IPAddressAllow=127.0.0.0/8");
    expect(doc).toContain("ufw deny 3100/tcp");
    expect(doc).toContain("curl -fsS https://");
  });
});
