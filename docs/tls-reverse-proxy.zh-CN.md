# TLS / 反向代理（单机部署）

目标：Master 只监听 loopback（`HARNESS_HOST` 默认 `127.0.0.1`，systemd unit 用 `IPAddressAllow=127.0.0.0/8`），外部入口由 Caddy 或 Nginx 终止 TLS。这样 HTTP 层不直接暴露到局域网，证书、HSTS、访问日志都收敛在反向代理。

## 1. 前置条件

- Master 已按 `docs/deployment-single-node-systemd.zh-CN.md` 启动，`curl http://127.0.0.1:3100/health` 返回 200。
- 反向代理与 Master 在同一台机器；只放行 `443/tcp`（需要 HTTP 跳转时再放行 `80/tcp`），不要放行 `3100`。
- 有内网域名（推荐）或准备自签证书。

## 2. 证书方案

| 场景 | 方案 |
| --- | --- |
| 有 DNS 域名 | Caddy 自动申请/续期 Let's Encrypt；或 Nginx + certbot |
| 纯内网、无域名 | Caddy `tls internal`；或自签证书并让实验室机器信任该 CA |

自签证书至少要覆盖访问用的主机名，例如 `harness.lab.internal`。浏览器不信任自签证书时，先给实验室分发 CA，而不是让用户点击“继续访问”。

## 3. Caddy 示例

参考 `deploy/harness-caddy.example`：

```caddyfile
harness.lab.internal {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3100
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        -Server
    }
}
```

无域名时把站点改为：

```caddyfile
harness.lab.internal {
    tls internal
    reverse_proxy 127.0.0.1:3100
}
```

安装与启动：

```bash
sudo cp deploy/harness-caddy.example /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 4. Nginx 示例

参考 `deploy/harness-nginx.example`，关键点是只反代 loopback 并传递原始协议：

```nginx
location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}
```

注意：平台当前不消费 `X-Forwarded-*` 做鉴权或审计归属，它们只用于反向代理访问日志与后续扩展；不要把 `X-Forwarded-For` 当作可信身份。

## 5. 防火墙与监听地址

```bash
# 只允许 443（和可选的 80）从局域网进入
sudo ufw allow 443/tcp
sudo ufw deny 3100/tcp
sudo ufw enable
```

Master 的 systemd unit 已有：

```ini
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8
```

这表示 Master 只能被 loopback 访问；反向代理进程单独放行其入站端口即可。

## 6. 验收

```bash
curl -fsS https://harness.lab.internal/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://harness.lab.internal/app
# 确认明文端口没有暴露到局域网
ss -ltnp | grep 3100
```

预期：`/health` 200；`/app` 200；`ss` 显示 Master 只绑定 `127.0.0.1:3100`。

## 7. 日志与轮转

- 反向代理访问日志：Caddy/Nginx 自己的日志；建议保留 14 天。
- Master 交给 journald 时：`journalctl --vacuum-time=14d`。
- Master 重定向到文件时：参考 `deploy/harness-logrotate.example`。
- 磁盘水位仍用 `bun run scripts/harness-ops.ts disk-check --path / --warn 80 --critical 90`。
