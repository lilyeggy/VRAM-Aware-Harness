# 升级与回滚 Runbook（单机）

适用：单机 systemd 部署，Master 非 root，Broker root。迁移是**向前**的：`src/storage/migrations.ts` 只记录已应用版本，没有 down migration。因此回滚代码前必须先备份并恢复数据库。

## 0. 升级前检查

```bash
cd /srv/VRAM-Aware-Harness
git rev-parse HEAD            # 记录当前版本
bun run scripts/harness-ops.ts disk-check --path / --warn 80 --critical 90
```

磁盘 critical（退出码 2）时先清理，不要带病升级：

```bash
bun run scripts/harness-ops.ts cleanup \
  --vm-runtime /var/lib/harness/vm-runtime \
  --snapshot-pool /var/lib/harness/snapshots \
  --max-age-hours 24 --max-snapshots 8 --apply
```

## 1. 升级步骤

```bash
# 1) 停 Master（Broker 可继续运行；迁移只由 Master 启动时执行）
sudo systemctl stop harness.service

# 2) 备份数据库（VACUUM INTO 一致性备份）
bun run scripts/harness-ops.ts backup \
  --database /var/lib/harness/harness.sqlite \
  --backup-dir /var/lib/harness/backups --keep 7

# 3) 拉取目标版本
git fetch --tags
git checkout <目标 tag 或 commit>

# 4) 安装锁定依赖
bun install --frozen-lockfile

# 5) 启动 Master；迁移在启动时向前执行
sudo systemctl start harness.service
```

## 2. 升级后验收

```bash
curl -fsS http://127.0.0.1:3100/health
curl -fsS http://127.0.0.1:3100/ready

cd /srv/VRAM-Aware-Harness
bun run scripts/p0-e2e-smoke.ts
bun run scripts/audit-chain-smoke.ts --database /var/lib/harness/harness.sqlite
bun run scripts/user-billing-smoke.ts --database /var/lib/harness/harness.sqlite
```

期望：`P0_E2E_SMOKE_OK`、`AUDIT_CHAIN_VERIFY_OK`、`USER_BILLING_VERIFY_OK`。任一步失败就按第 3 节回滚。

## 3. 回滚步骤

```bash
# 1) 停 Master
sudo systemctl stop harness.service

# 2) 从备份恢复数据库（目标库存在时必须 --force；会清理旧 -wal/-shm）
bun run scripts/harness-ops.ts restore \
  --backup /var/lib/harness/backups/harness-<timestamp>.sqlite \
  --database /var/lib/harness/harness.sqlite --force

# 3) 回到升级前版本
git checkout <升级前 commit>

# 4) 重装依赖
bun install --frozen-lockfile

# 5) 启动并验收
sudo systemctl start harness.service
curl -fsS http://127.0.0.1:3100/health
bun run scripts/p0-e2e-smoke.ts
```

## 4. 迁移策略说明

- 迁移只前进，不提供 down migration；`schema_migrations` 记录已应用版本。
- 代码回滚但不恢复数据库时，旧代码可能读到新 schema（通常向后兼容，但不保证）；生产/实验室环境请按第 3 节恢复备份。
- 升级前必须保留至少一份 `harness-ops.ts backup` 产物，且确认文件可读、大小非 0。

## 5. 日志轮转

- journald：`journalctl --vacuum-time=14d`，或配置 `/etc/systemd/journald.conf` 的 `SystemMaxUse`。
- 文件重定向：使用 `deploy/harness-logrotate.example`。
- 反向代理日志：见 `docs/tls-reverse-proxy.zh-CN.md` 第 7 节。

## 6. 回滚演练建议

每季度在测试目录演练一次：备份 → 恢复 → 启动旧版本 → 跑 p0 smoke。演练不需要停生产，但要在独立端口/数据库上做。
