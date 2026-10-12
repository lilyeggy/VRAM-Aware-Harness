# 单机 systemd 部署（Broker / Master / Worker）

> 适用边界：个人 / 小私有部署、单台 Linux + KVM。生产形态下 Broker 以 root 运行，Master 与 Worker 都是非特权进程；Agent 的工具执行只发生在 jailer + Firecracker microVM 内。
> 范围与验收标准见 `docs/platform-boundary.md §9`。

## 1. 部署拓扑

```
systemd
├── harness-broker.service      root，唯一持有 Firecracker/jailer 与 /dev/kvm 的组件
│   └── /run/harness/sandbox-broker.sock（Unix socket，只暴露 create/execute/terminate）
└── harness-master.service      harness 用户，非 root
    ├── HTTP API / 调度 / SQLite / 策略 / 审计
    └── sudo -n /usr/local/sbin/harness-worker-run …  每次 Run 拉起一个瞬时 systemd 单元
        └── harness-worker-<runId>.service           harness-worker UID + cgroup + 只读宿主
            └── 通过 broker socket 请求 microVM execute/terminate
```

关键点：
- Master 不持有 Firecracker 驱动，只通过 socket 调 Broker；Broker 的 control token 不对 Worker 暴露，并用 SO_PEERCRED 校验调用方 UID（create/terminate 只认 Master UID，execute 只认 Worker UID）。
- Worker 不使用 Master 的环境变量与凭据；Pi 的模型认证文件由 Worker 专用 UID 读取。
- microVM 无网卡；Agent 的网络请求在平台侧 fail-closed。

## 2. 前置条件

- 单台 Linux（Ubuntu 22.04+ / 内核 6.8+），cgroup v2，systemd 可用。
- `/dev/kvm` 可访问；`/dev/vhost-vsock` 可用。
- 已安装 Bun（如 `/usr/local/bin/bun`）。
- Firecracker + jailer 二进制、guest kernel、rootfs 模板、workspace 模板：例如
  - `/opt/firecracker/firecracker`
  - `/opt/firecracker/jailer`
  - `/opt/firecracker/vmlinux`
  - `/opt/firecracker/images/rootfs.ext4`
  - `/opt/firecracker/images/workspace-template.ext4`
- 代码目录（示例）：`/srv/VRAM-Aware-Harness`。

## 3. 账号、组与目录

```bash
# Master 运行账号
sudo useradd --create-home --shell /bin/bash harness

# Worker 专用账号：无 shell、无 sudo、不能读 Master 的 home
sudo useradd --system --no-create-home --shell /usr/sbin/nologin harness-worker

# master 必须属于 harness-worker 组，才能访问 broker socket 的 0660 权限
sudo usermod -aG harness-worker harness

sudo install -d -o harness -g harness -m 0755 /var/lib/harness
sudo install -d -o harness -g harness -m 0755 /var/lib/harness/workspaces
sudo install -d -o harness -g harness -m 0755 /var/lib/harness/vm-runtime
sudo install -d -o harness-worker -g harness-worker -m 0700 /var/lib/harness-worker

# Worker 的 Pi 模型凭据/缓存（只给 harness-worker 读写）
sudo install -o harness-worker -g harness-worker -m 0600 /path/to/auth.json /var/lib/harness-worker/auth.json
sudo install -o harness-worker -g harness-worker -m 0644 /path/to/models.json /var/lib/harness-worker/models.json
```

Broker 与 Master 的配置都放在 `/etc/harness/`，权限 `root:root 0640`；其中 control token 文件只给 root 可读。

## 4. 安装 Worker launcher

Master 用 `sudo -n` 调用一个很窄的 root helper；helper 再用 `systemd-run` 拉起 Worker 单元。

```bash
sudo install -o root -g root -m 0755 scripts/harness-worker-run.sh /usr/local/sbin/harness-worker-run
sudo install -o root -g root -m 0644 scripts/harness-worker-launcher.conf.example /etc/harness/worker-launcher.conf
```

按实际路径修改 `/etc/harness/worker-launcher.conf` 中的 `WORKER_USER`、`WORKER_GROUP`、`WORKER_CWD`、`WORKER_BUN`、`WORKER_SCRIPT`、`WORKER_HOME`、`WORKER_RW_PATHS`。例如：

```sh
WORKER_USER=harness-worker
WORKER_GROUP=harness-worker
WORKER_CWD=/srv/VRAM-Aware-Harness
WORKER_BUN=/usr/local/bin/bun
WORKER_SCRIPT=/srv/VRAM-Aware-Harness/src/worker/worker-main.ts
WORKER_PATH=/usr/local/bin:/usr/bin:/bin
WORKER_HOME=/var/lib/harness-worker
WORKER_MEMORY_MAX=2G
WORKER_CPU_QUOTA=200%
WORKER_TASKS_MAX=256
WORKER_RW_PATHS=/var/lib/harness-worker
UNIT_PREFIX=harness-worker
# 控制面 egress ACL（§9.7 v1.3 第 3 项）：Worker 默认只允许 loopback。
# 访问外部模型服务时必须显式放行；opencode.ai 在 Cloudflare，
# IPv4 段 172.64.0.0/13、IPv6 段 2606:4700:78::/48（Worker 双栈均启用）。
# 只放行 IPv4 时，若宿主 IPv4 出站到 Cloudflare 不可用，模型调用会一直挂起。
WORKER_EGRESS_ALLOW=127.0.0.0/8,172.64.0.0/13,2606:4700:78::/48
```

只允许 Master 账号免密调用该 helper：

```bash
sudo install -o root -g root -m 0440 /dev/stdin /etc/sudoers.d/harness-worker-launcher <<'SUDOERS'
harness ALL=(root) NOPASSWD: /usr/local/sbin/harness-worker-run
Defaults:harness !requiretty
SUDOERS
sudo visudo -cf /etc/sudoers.d/harness-worker-launcher
```

## 5. 启动 Broker（root，唯一特权组件）

创建 `/etc/harness/broker.env`：

```sh
HARNESS_SANDBOX_BROKER_SOCKET=/run/harness/sandbox-broker.sock
HARNESS_SANDBOX_BROKER_CONTROL_TOKEN=replace-with-random-token
HARNESS_SANDBOX_BROKER_SOCKET_UID=1000          # id -u harness
HARNESS_SANDBOX_BROKER_SOCKET_GID=998           # getent group harness-worker | cut -d: -f3
# SO_PEERCRED：Broker 用对端 UID 区分 Master 与 Worker；生产必须至少配置一项。
HARNESS_SANDBOX_BROKER_PEER_UIDS=1000,998       # 允许连接的 UID 白名单
HARNESS_SANDBOX_BROKER_MASTER_UID=1000          # id -u harness
HARNESS_SANDBOX_BROKER_WORKER_UID=998           # id -u harness-worker
HARNESS_MICROVM_DRIVER=firecracker
HARNESS_USE_JAILER=true
HARNESS_VM_SNAPSHOTS_ENABLED=true
HARNESS_VM_SNAPSHOT_POOL_DIR=/var/lib/harness/snapshots
HARNESS_VM_RUNTIME_ROOT=/var/lib/harness/vm-runtime
FIRECRACKER_BINARY_PATH=/opt/firecracker/firecracker
FIRECRACKER_JAILER_PATH=/opt/firecracker/jailer
FIRECRACKER_KERNEL_PATH=/opt/firecracker/vmlinux
FIRECRACKER_ROOTFS_PATH=/opt/firecracker/images/rootfs.ext4
FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=/opt/firecracker/images/workspace-template.ext4
HARNESS_VM_SHARE_BASE_FILES=1     # 默认开：内核 + 快照文件硬链接共享（热恢复 498ms → 176ms）
#HARNESS_VM_SHARE_ROOTFS=1        # 可选：rootfs 也共享（→101ms），但 guest 内除 /workspace 外全部只读
#HARNESS_VM_PHASE_TRACE=1         # 排查用：打印 [vm-phase] 分阶段耗时
#HARNESS_VM_WORKSPACE_SEED=0      # 关闭工作区播种（guest 将看不到工作区既有文件；仅排障用）
# 默认开启：宿主工作区目录非空时用 mke2fs 播种本 Run 的盘（工作区跨 Run 持久）
```

> 硬链接共享要求 `FIRECRACKER_*` 资产与 `HARNESS_VM_RUNTIME_ROOT`、
> `HARNESS_VM_SNAPSHOT_POOL_DIR` 在**同一文件系统**，否则退化为复制。建议把内核与磁盘模板
> 放在数据盘上（172.17.43.193 为 `/data/harness/images/`）。

> 工作区播种（默认开）要求宿主工作区目录所在磁盘**有** `mke2fs`（e2fsprogs）；缺工具时退化为
> 空盘模板复制并打印一行 `[workspace-seed] mke2fs 不可用…`（Run 不会失败，但 guest 看不到
> 工作区既有文件）。播种 Run 走**冷启动**（不恢复快照、也不制作快照）：播种盘的 ext4 布局与
> 黄金快照的工作区盘不同，恢复快照会让 guest 命中旧盘缓存并报 `Bad message`；空工作区仍走
> 热恢复。实测播种 Run ~210ms vs 热恢复 ~98ms。细节见 `docs/full-coverage-report.zh-CN.md` §6.1。
```sh
# 开机预热黄金快照（可选但推荐）：让用户遇到的第一个 Run 也是热恢复。见 §12。
sudo systemctl enable --now harness-vm-prewarm.timer
```

> 开启 `HARNESS_VM_SHARE_ROOTFS=1` 前，guest 镜像必须带可写 tmpfs（`/tmp`/`/run`/`/var/tmp`）：
> 构建脚本 `scripts/microvm/build-guest-rootfs.sh` 已包含（`inittab` 里 `mount -t tmpfs ...`）。
> 老镜像直接用会让 guest 写 `/tmp` 报 `Read-only file system`（`TOOL_FAILED isError=true`）。

> `HARNESS_VM_SHARE_ROOTFS` 的只读语义固化在黄金快照的 drive 配置里，切换开关后必须清空快照池，
> 否则旧快照恢复出来的盘仍按旧语义运行。细节与实测数字见 `docs/vm-lifecycle-benchmark.zh-CN.md`。

创建 `/etc/systemd/system/harness-broker.service`：

```ini
[Unit]
Description=Harness Sandbox Broker (root, jailer Firecracker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/srv/VRAM-Aware-Harness
EnvironmentFile=/etc/harness/broker.env
ExecStart=/usr/local/bin/bun run src/sandbox/broker/broker-main.ts
Restart=on-failure
RestartSec=3
RuntimeDirectory=harness
RuntimeDirectoryMode=0755
Delegate=yes
NoNewPrivileges=true
PrivateTmp=true
# 控制面 egress ACL（§9.7 v1.3 第 3 项）：Broker 只走 Unix socket / vsock，禁止 IP 出站。
IPAddressDeny=any

[Install]
WantedBy=multi-user.target
```

说明：
- `Delegate=yes`：jailer 要在自己的 cgroup 子树内创建 `cpu.max` / `memory.max` 等限制。
- Broker 是唯一需要 root、`/dev/kvm`、Firecracker 资产与控制 token 的进程。
- 快照加速只在 jailer 下安全；非 jailer 开启快照会被驱动 fail-closed。

## 6. 启动 Master（非 root）

> 数据盘建议：如果机器有独立数据盘（例如 `/data`），把上面的 `/var/lib/harness` 全部换成 `/data/harness`，并确保 Broker(root) 与 Master(非 root) 对相应子目录有写权限。172.17.43.193 当前使用 `/data/harness/live-full-flow`（DB/workspaces/vm-runtime）与 `/data/harness/snapshots-mt`（快照池），备份放 `/data/harness/backups`。

创建 `/etc/harness/master.env`：

```sh
HARNESS_ENV=production
HARNESS_HOST=127.0.0.1
HARNESS_PORT=3100
HARNESS_DATABASE_PATH=/var/lib/harness/harness.sqlite
HARNESS_WORKSPACE_ROOT=/var/lib/harness/workspaces
HARNESS_VM_RUNTIME_ROOT=/var/lib/harness/vm-runtime
HARNESS_BOOTSTRAP_API_KEY=replace-with-bootstrap-key
# 实验室/他人使用前建议收口注册：invite 需邀请码，closed 完全关闭。
HARNESS_REGISTRATION_MODE=invite
HARNESS_REGISTRATION_INVITE_CODE=replace-with-lab-invite-code
# HTTP 入口限流（默认开启；实验室可按人数/习惯调整）
HARNESS_RATE_LIMIT_MAX_PER_TENANT=600
HARNESS_RATE_LIMIT_MAX_PER_IP=1200
# 仅当 Master 只监听 loopback、前面是可信 Caddy/Nginx 时才开启。
#HARNESS_TRUST_PROXY=true

HARNESS_SANDBOX_PROVIDER=microvm
HARNESS_USE_JAILER=true
HARNESS_WORKER_ISOLATION=systemd
HARNESS_SANDBOX_BROKER_SOCKET=/run/harness/sandbox-broker.sock
HARNESS_SANDBOX_BROKER_CONTROL_TOKEN=replace-with-same-token-as-broker
HARNESS_WORKER_SYSTEMD_LAUNCHER_PATH=/usr/local/sbin/harness-worker-run
HARNESS_WORKER_SYSTEMD_SUDO_PATH=/usr/bin/sudo
HARNESS_WORKER_PI_AUTH_PATH=/var/lib/harness-worker/auth.json
HARNESS_WORKER_PI_MODELS_PATH=/var/lib/harness-worker/models.json

PI_PROVIDER=opencode-go
PI_MODEL_ID=deepseek-v4.1-flash
PI_MODELS_PATH=/etc/harness/models.json
PI_AUTH_PATH=/var/lib/harness-worker/auth.json
```

生产环境启动时会校验：`HARNESS_ENV=production` 时必须 `HARNESS_USE_JAILER=true`、`HARNESS_SANDBOX_PROVIDER=microvm`，并设置 Broker socket 与 control token。

### MCP 工具（可选，§9.8 v1.4 Phase 4）

Master 按 `HARNESS_MCP_SERVERS`（JSON 数组）连接 stdio MCP server，把工具以
`mcp__<server>__<tool>` 暴露给 Agent；调用仍经过 ToolGateway 的策略守卫、PREPARED
记账与审计，`annotations.readOnlyHint=true` 的工具按 `READ_ONLY` 分类。

生产 `HARNESS_WORKER_ISOLATION=systemd` 时，Master 只把该配置随 Run 下发给 Worker，
由 Worker 进程拉起 MCP server；因此 MCP server 继承 Worker 的 `SystemCallFilter`、
Landlock、`IPAddressDeny=any` + `IPAddressAllow` egress ACL，不能联网，也不能写
`WORKER_RW_PATHS` 之外。需要额外文件或网络权限时改 `/etc/harness/worker-launcher.conf`，
不要放宽 Master。

```sh
HARNESS_MCP_SERVERS='[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/var/lib/harness-worker/mcp-data"]}]'
```

烟测（无真实模型，只验证 MCP 全链路）：

```bash
cd /srv/VRAM-Aware-Harness
HARNESS_MCP_SERVERS="$HARNESS_MCP_SERVERS" bun run scripts/mcp-smoke.ts
# 期望输出：MCP_SMOKE_OK servers=... tools=... call=...
```

创建 `/etc/systemd/system/harness-master.service`：

```ini
[Unit]
Description=Harness Master (non-root)
Wants=harness-broker.service
After=harness-broker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=harness
Group=harness
SupplementaryGroups=harness-worker
WorkingDirectory=/srv/VRAM-Aware-Harness
EnvironmentFile=/etc/harness/master.env
ExecStart=/usr/local/bin/bun run src/main.ts
Restart=on-failure
RestartSec=3
# 注意：不要设置 NoNewPrivileges=true。Master 通过 sudo 调用
# /usr/local/sbin/harness-worker-run 启动 Worker；no_new_privs 会让 sudo
# 拒绝提权，Worker 启动失败（WORKER_CRASHED: sudo: The "no new privileges"
# flag is set, which prevents sudo from running as root.）。
PrivateTmp=true
# 控制面 egress ACL（§9.7 v1.3 第 3 项）：Master 默认只允许 loopback。
# 若在可信内网直接暴露 3100，把实验室网段加入 IPAddressAllow。
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8

[Install]
WantedBy=multi-user.target
```

说明：
- Master 只依赖 Broker socket，不需要 Firecracker 资产路径，也不应加入 `kvm` 组。
- Master 若使用 `HARNESS_WORKER_ISOLATION=systemd`，必须保留 sudo 调用 `/usr/local/sbin/harness-worker-run` 的路径，因此 unit 不能设置 `NoNewPrivileges=true`；Broker unit 仍保留该项。
- `HARNESS_WORKER_ISOLATION=systemd` 时，每次 Run 由 launcher 创建 `harness-worker-<runId>` 瞬时单元，Worker 使用 `harness-worker` UID、`MemoryMax`、`CPUQuota`、`TasksMax`、`NoNewPrivileges`、`PrivateDevices`、`ProtectSystem=strict`、`ProtectHome=read-only`、`ProtectKernelTunables/Modules/ControlGroups/Clock/Hostname`、`ProtectProc=invisible`、`ProcSubset=pid`、`RestrictRealtime`、`RestrictSUIDSGID`、`RemoveIPC`、`LockPersonality`。
- Worker 还启用 seccomp 白名单与 Landlock：`SystemCallFilter=@system-service` 并显式放行 `landlock_create_ruleset` / `landlock_add_rule` / `landlock_restrict_self`，`SystemCallErrorNumber=EPERM`；Worker 进程内以 `HARNESS_WORKER_LANDLOCK=required` 应用 Landlock，失败即退出 78（fail-closed）。
- Worker 只读宿主、只写 `/var/lib/harness-worker`、`/tmp`、`/run/harness`（Broker socket）与 `/dev/null` 等设备文件；模型凭据只存在于 `/var/lib/harness-worker`。
- 控制面 egress ACL（§9.7 v1.3 第 3 项）：Broker 单元 `IPAddressDeny=any`；Master 单元 `IPAddressDeny=any` + `IPAddressAllow=127.0.0.0/8`；Worker 默认只允许 loopback，访问外部模型服务时通过 `WORKER_EGRESS_ALLOW` 放行模型服务 CIDR（如 opencode.ai 的 Cloudflare 段 `172.64.0.0/13`）。Worker 的 `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`（双栈；早期版本仅 IPv4，遇到「IPv4 出站不可用但 IPv6 正常」时会挂起模型调用，故恢复 IPv6 并要求同时放行模型服务的 IPv6 前缀）；未配置 `WORKER_EGRESS_ALLOW` 时 Worker 无法访问外部模型服务，属 fail-closed。
- Broker 故障隔离（§9.9 v1.5 F2）：Master 单元用 `Wants=harness-broker.service` 而不是 `Requires=`——Broker 停止/重启不会连带杀死 Master。Broker 不可达时新 Run 走 fail-closed（`INTERRUPTED`，`START_FAILED`），Broker 恢复后新 Run 正常；真机验证见 §9.9。
- 不可变审计存储（§9.7 v1.3 第 4 项）：`access_audit_events` 采用只追加 + SHA-256 hash 链；migration v2 增加 `prev_hash`/`hash` 列与 `BEFORE UPDATE`/`BEFORE DELETE` 触发器，正常路径无法改写或删除审计事实；`AccessAuditStore.verifyChain()` 能检测绕过触发器的内容篡改或中间行删除。验证命令：
  ```bash
  cd /srv/VRAM-Aware-Harness
  bun run scripts/audit-chain-smoke.ts
  bun run scripts/audit-chain-smoke.ts --database /srv/VRAM-Aware-Harness/data/live-full-flow/harness.sqlite
  ```
  期望 `AUDIT_CHAIN_SMOKE_OK` 与 `AUDIT_CHAIN_VERIFY_OK`。
- 租户成本账单（§9.7 v1.3 第 5 项）：`GET /billing` 需要 `billing:read` scope，按 Principal Tenant 收口；默认只汇总 Provider 上报的模型成本（`MODEL_COMPLETED.usage.cost.total`），可用 `HARNESS_BILLING_CURRENCY` / `HARNESS_BILLING_MODEL_INPUT_PER_MTOK` / `HARNESS_BILLING_MODEL_OUTPUT_PER_MTOK` / `HARNESS_BILLING_SANDBOX_SECOND` / `HARNESS_BILLING_TOOL_CALL` 叠加 token、沙箱秒与工具调用费用。验证命令：
  ```bash
  cd /srv/VRAM-Aware-Harness
  bun run scripts/tenant-billing-smoke.ts
  bun run scripts/tenant-billing-smoke.ts --database /srv/VRAM-Aware-Harness/data/live-full-flow/harness.sqlite
  ```
  期望 `TENANT_BILLING_SMOKE_OK` 与 `TENANT_BILLING_VERIFY_OK`。
- 注册收口（实验室接入）：`HARNESS_REGISTRATION_MODE=open|invite|closed` 默认 `open` 保持旧部署兼容；`invite` 必须同时设置 `HARNESS_REGISTRATION_INVITE_CODE`，服务端用 timing-safe 比较；策略拒绝返回 403（不是账号冲突的 409）。交给实验室或他人使用前建议显式设为 `invite` 或 `closed`。
- HTTP 入口限流：默认开启；固定窗口 `HARNESS_RATE_LIMIT_WINDOW_MS`（默认 60000）内每租户 `HARNESS_RATE_LIMIT_MAX_PER_TENANT`（默认 600）、每 IP `HARNESS_RATE_LIMIT_MAX_PER_IP`（默认 1200；实验室常共用一个 NAT 出口 IP，调低会让所有人的正常 UI 轮询一起 429）；超限返回 429 + `Retry-After`；`/health`、`/ready` 不参与限流。`HARNESS_TRUST_PROXY=true` 只在 Master 只监听 loopback、前面是可信 Caddy/Nginx 时开启；直接暴露时开启会让客户端伪造 `X-Forwarded-For` 绕过限流。
- 验证：Run 执行期间 `systemctl show 'harness-worker-<runId>.service' -p SystemCallFilter -p ProtectSystem -p ReadWritePaths -p IPAddressDeny -p IPAddressAllow` 应看到上述属性；Worker stderr 会打印 `[worker] landlock=on abi=<n>`。
- 最小可观测性（§9.8 v1.4）：`GET /metrics` 返回 Prometheus 文本，需要 `metrics:read` scope（bootstrap key 的 `*` 可读）。包含 `harness_up`、`harness_uptime_seconds`、`harness_runs_queued`、`harness_runs{status}`、`harness_sandbox_acquisitions_total{warm}`、`harness_sandbox_acquire_duration_ms_sum`、`harness_http_requests_total{status}`。验证：
  ```bash
  curl -fsS -H "Authorization: Bearer $HARNESS_BOOTSTRAP_API_KEY" http://127.0.0.1:3100/metrics | head
  ```

## 7. 启动与验收

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now harness-broker.service
sudo systemctl enable --now harness-master.service

systemctl status harness-broker harness-master --no-pager
curl -fsS http://127.0.0.1:3100/health

# 端到端 smoke：串行 + 并发 + 跨租户拒绝
# 脚本会注册两个临时租户，不需要额外 API key；默认连 127.0.0.1:3100。
cd /srv/VRAM-Aware-Harness
HARNESS_BASE_URL=http://127.0.0.1:3100 bun run scripts/p0-e2e-smoke.ts
# 期望最后一行：P0_E2E_SMOKE_OK
```

单机运维（磁盘水位 / SQLite 备份 / VM 与快照清理）：

```bash
cd /srv/VRAM-Aware-Harness
# 磁盘水位：warn 80%、critical 90%；critical 时退出码 2
bun run scripts/harness-ops.ts disk-check --path / --warn 80 --critical 90

# SQLite 一致性备份（VACUUM INTO），默认保留最近 7 份
bun run scripts/harness-ops.ts backup \
  --database /var/lib/harness/harness.sqlite \
  --backup-dir /var/lib/harness/backups --keep 7

# 恢复：目标库存在时必须显式 --force；会清理旧 -wal/-shm
bun run scripts/harness-ops.ts restore \
  --backup /var/lib/harness/backups/harness-<timestamp>.sqlite \
  --database /var/lib/harness/harness.sqlite --force

# 清理：默认 dry-run；确认后加 --apply
bun run scripts/harness-ops.ts cleanup \
  --vm-runtime /var/lib/harness/vm-runtime \
  --snapshot-pool /var/lib/harness/snapshots \
  --artifacts /var/lib/harness/artifacts \
  --database /var/lib/harness/harness.sqlite \
  --max-age-hours 24 --max-snapshots 8 --apply

# 快照池清理默认豁免"当前模板"快照（templateHash = sha256(kernel + rootfs + agentVersion)），
# 避免 mtime TTL 把唯一在用的黄金快照删掉，让后续 Run 吃完整冷启动。因此运行清理时需要
# FIRECRACKER_KERNEL_PATH / FIRECRACKER_ROOTFS_PATH / HARNESS_GUEST_AGENT_VERSION
# （见 deploy/harness-maintenance.sh.example 的 read_broker_env()）。
# 生效标志：输出里的 snapshotPoolProtected=N 与 HARNESS_OPS_CLEANUP_PROTECTED <hash>。
# 可用 --protect-template <hash> 追加豁免；--no-protect-current-template 显式关闭（不建议）。
```

Run 执行期间可观察 Worker 单元与 cgroup：

```bash
systemctl list-units 'harness-worker-*' --no-pager
systemctl show 'harness-worker-<runId>.service' -p UID -p GID -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax
systemctl show 'harness-worker-<runId>.service' -p IPAddressDeny -p IPAddressAllow
systemctl show harness-broker -p IPAddressDeny -p IPAddressAllow
systemctl show harness-master -p IPAddressDeny -p IPAddressAllow
```

重启与恢复：
- Master 重启后 SQLite 中的 `QUEUED`/`RUNNING` Run 由启动对账与队列 pump 恢复；Worker 是瞬时单元，不持有持久状态。
- Broker 重启会删除并重建 socket；需要与 Master 使用同一个 control token。
- 异常退出后建议检查 `systemctl list-units 'firecracker*'` 与 `journalctl -u harness-broker -u harness-master`；平台启动时也有孤儿 VM 对账逻辑。

## 8. 安全与运维边界

- Agent 无网络：microVM 无网卡；`allowNetwork=true` 在平台侧被拒绝；不要给 Broker/Worker 添加 NAT/代理。
- 控制面 egress：Broker 禁 IP 出站；Master 默认只允许 loopback，若在可信内网直接暴露 3100 需把实验室网段加入 `IPAddressAllow`；Worker 默认只允许 loopback，仅 `WORKER_EGRESS_ALLOW` 放行的模型服务 CIDR（IPv4/IPv6）可达。
- Broker 只暴露 `create/execute/terminate`；control token 只存在于 root 可读文件与 Master 进程，Worker 只拿自己 sandbox 的 capability token；`HARNESS_SANDBOX_BROKER_MASTER_UID` / `HARNESS_SANDBOX_BROKER_WORKER_UID` 再把操作绑定到进程 UID。
- Master 应只监听内网/本机，前置反向代理时自行加 TLS 与访问控制；平台只做 API Key/租户级授权。
- 快照池、VM runtime、workspaces 都属于 Broker/Master 的本地数据目录；不要手工修改正在使用的磁盘。生产建议用 systemd timer 定时执行 `harness-ops.ts backup` 与 `cleanup`（cleanup 先 dry-run 观察）。
- 注册收口：`HARNESS_REGISTRATION_MODE` 默认 `open`；交给实验室/他人使用前应设为 `invite`（配 `HARNESS_REGISTRATION_INVITE_CODE`）或 `closed`，避免服务可达即可自助注册。
- 已实现：Broker SO_PEERCRED（v1.3 第 1 项）、Worker seccomp/Landlock/只读 rootfs（v1.3 第 2 项）、控制面 egress ACL（v1.3 第 3 项）、不可变审计存储（v1.3 第 4 项）与租户成本账单（v1.3 第 5 项，见 `docs/platform-boundary.md §9.7`）。

## 9. TLS / 反向代理

Master 默认只监听 loopback（`HARNESS_HOST` 默认 `127.0.0.1`，unit 里 `IPAddressAllow=127.0.0.0/8`）。需要从实验室机器访问时，优先用 Caddy/Nginx 终止 TLS 并反代到 `127.0.0.1:3100`。

可信内网也可以直接暴露：设置 `HARNESS_HOST=0.0.0.0`，并把实验室网段加入 Master unit 的 `IPAddressAllow`（例如 `10.0.0.0/8 172.16.0.0/12`）。代价是明文 HTTP，密码与 token 不加密；只建议在受控实验室内网使用。

- Caddy 示例：`deploy/harness-caddy.example`
- Nginx 示例：`deploy/harness-nginx.example`
- 完整说明（证书选择、防火墙、验收、日志轮转）：`docs/tls-reverse-proxy.zh-CN.md`

## 10. 升级与回滚

迁移是向前执行的；回滚代码前必须备份并恢复数据库。完整步骤：

- `docs/upgrade-rollback-runbook.zh-CN.md`
- 日志文件轮转示例：`deploy/harness-logrotate.example`


## 11. 定时备份 / 清理（systemd timer）

示例文件：`deploy/harness-maintenance.sh.example`、`deploy/harness-maintenance.service.example`、`deploy/harness-maintenance.timer.example`。

在 `/data/harness` 数据盘上建议每天执行一次 SQLite 备份、VM runtime 与快照池清理，并顺带打印磁盘水位。

创建 `/usr/local/sbin/harness-maintenance`（root:root 0755）：

```sh
#!/bin/sh
set -eu
cd /srv/VRAM-Aware-Harness
BUN=/usr/local/bin/bun
DB=/data/harness/live-full-flow/harness.sqlite
BACKUP_DIR=/data/harness/backups
VM_RUNTIME=/data/harness/live-full-flow/vm-runtime
SNAPSHOT_POOL=/data/harness/snapshots-mt
ARTIFACT_ROOT=/data/harness/live-full-flow/artifacts

$BUN run scripts/harness-ops.ts disk-check --path /data --warn 80 --critical 90 || true
$BUN run scripts/harness-ops.ts disk-check --path / --warn 80 --critical 90 || true
$BUN run scripts/harness-ops.ts backup --database "$DB" --backup-dir "$BACKUP_DIR" --keep 7
$BUN run scripts/harness-ops.ts cleanup --vm-runtime "$VM_RUNTIME" --snapshot-pool "$SNAPSHOT_POOL" \
  --artifacts "$ARTIFACT_ROOT" --database "$DB" --max-age-hours 72 --max-snapshots 8 --apply
```

创建 `/etc/systemd/system/harness-maintenance.service`：

```ini
[Unit]
Description=Harness daily maintenance (backup + cleanup + disk check)
After=harness.service

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=/srv/VRAM-Aware-Harness
ExecStart=/usr/local/sbin/harness-maintenance
```

创建 `/etc/systemd/system/harness-maintenance.timer`：

```ini
[Unit]
Description=Run Harness maintenance daily

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
```

启用并手动验证一次：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now harness-maintenance.timer
sudo systemctl start harness-maintenance.service
systemctl list-timers | grep harness-maintenance
ls -la /data/harness/backups/
```

### 12.1 guest agent 实现：静态 C（推荐，O9/O10）

guest 镜像里的 agent 有两条实现：旧的 `socat + 96MB bun --compile 产物`，和 `guest/agent/agent.c`
（静态 C、单文件、自己监听 AF_VSOCK、协议一致）。真机 A/B（jailer + fc117、256MiB guest）：

| 配置 | 冷启动 total 中位 | 握手 | 说明 |
| --- | --- | --- | --- |
| socat + Bun 产物 | 338ms | connect-ok 140ms → pong 207ms | connect 之后还要约 70ms 加载 Bun |
| 静态 C agent | **261ms** | connect-ok 138ms → pong 138ms | connect 成功即可应答 |
| 静态 C agent（热恢复） | **117.5ms** | 5.5ms | 热路径无回归 |

```bash
# 1) 存量镜像原地换 agent（幂等：已是直接 respawn /agent/main 时输出 PATCH_C_AGENT_SKIP；
#    先备份 <image>.bak-cagent，回写后用 cmp 校验二进制一致）
sudo bash scripts/microvm/patch-guest-rootfs-c-agent.sh /data/harness/images/rootfs.ext4

# 2) 必须提升 agent 版本：它参与 computeTemplateHash(kernel, rootfs, agentVersion)，
#    不提就会继续复用旧黄金快照里带 socat/Bun agent 的内存镜像
sudo sed -i 's/^HARNESS_GUEST_AGENT_VERSION=.*/HARNESS_GUEST_AGENT_VERSION=2.0.0/' /etc/harness/broker.env
grep -q '^HARNESS_GUEST_AGENT_VERSION=' /etc/harness/broker.env   || echo 'HARNESS_GUEST_AGENT_VERSION=2.0.0' | sudo tee -a /etc/harness/broker.env

# 3) 清空旧快照池并重启 Broker（驱动器默认 guestAgentVersion 已是 2.0.0）
sudo rm -rf /data/harness/snapshots-mt/*
sudo systemctl restart harness-broker.service

# 4) 复验：清池后的第一个 Run 应该是冷启动（几百 ms），预热后是热恢复（~120ms）
sudo systemctl start harness-vm-prewarm.service
journalctl -u harness-vm-prewarm.service -n 5 --no-pager | grep -E "VM_PREWARM_(OK|SKIP)"
```

重建镜像时默认就是 C 实现（`HARNESS_GUEST_AGENT_IMPL=auto`，有 `cc` 即用 C；`bun` 可回退）：

```bash
bash scripts/microvm/build-guest-rootfs.sh - /tmp/rootfs.ext4 /tmp/workspace.ext4
```

注意：`patch-guest-rootfs-c-agent.sh` 只把 inittab 的 respawn 行切到 `/agent/main`，**不会删除**
镜像里已有的 socat 与那几个动态库（对正确性无影响，只是镜像没变小）。

## 12. microVM 黄金快照预热（可选，推荐）

**为什么**：快照是"第一次启动顺手做"的 best-effort 产物（`snapshot` 模式首台 = 冷启动
~1.3s + 写内存镜像 ~0.9s）。服务重启、清空快照池或改过 `FIRECRACKER_*` 之后，第一个用户
Run 必然付这一笔（实测 `SANDBOX_ACQUIRED {durationMs: 2440, warmHit: false}`）。开机后主动
预热一次，用户侧就只剩热恢复（实测 `{durationMs: 166, warmHit: true}`）。

**单位与定时器**：`deploy/harness-vm-prewarm.service.example`（`Type=oneshot`、`User=root`、
`EnvironmentFile=/etc/harness/broker.env`、`IPAddressDeny=any`）+
`deploy/harness-vm-prewarm.timer.example`（`OnBootSec=20s` + `OnCalendar=hourly`：开机 20s 后
跑一次，之后每小时自检一次；自检只需算 `templateHash` + `stat` 快照目录，命中即
`VM_PREWARM_SKIP`，所以清空池子或换模板后无需重启也会自动补上）。

```bash
sudo install -m 0644 deploy/harness-vm-prewarm.service.example /etc/systemd/system/harness-vm-prewarm.service
sudo install -m 0644 deploy/harness-vm-prewarm.timer.example   /etc/systemd/system/harness-vm-prewarm.timer
sudo systemctl daemon-reload
sudo systemctl enable --now harness-vm-prewarm.timer

# 立刻验证一次（幂等：已存在快照则输出 VM_PREWARM_SKIP）
sudo systemctl start harness-vm-prewarm.service
journalctl -u harness-vm-prewarm.service -n 20 --no-pager | grep -E "VM_PREWARM_(OK|SKIP|FAIL)"
```

**必须与 Broker 同环境**：预热要算出与 Broker 完全一致的 `templateHash`
（`FIRECRACKER_KERNEL_PATH` / `FIRECRACKER_ROOTFS_PATH` / `HARNESS_GUEST_AGENT_VERSION`），
所以用同一份 `/etc/harness/broker.env`，且同样以 root 运行（jailer 需要 root）。

**只读 rootfs 的前置条件**：开 `HARNESS_VM_SHARE_ROOTFS=1` 要求 guest 镜像带 tmpfs 可写层
（`/tmp`/`/run`/`/var/tmp`）。新镜像用 `scripts/microvm/build-guest-rootfs.sh` 构建；
存量镜像可用 `scripts/microvm/patch-guest-rootfs-tmpfs.sh <rootfs.ext4>` 原地补丁（会留
`<rootfs.ext4>.bak-tmpfs` 备份，幂等，已打过则输出 `PATCH_TMPFS_SKIP`）。
