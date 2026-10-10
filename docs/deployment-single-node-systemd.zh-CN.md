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
```

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

[Install]
WantedBy=multi-user.target
```

说明：
- `Delegate=yes`：jailer 要在自己的 cgroup 子树内创建 `cpu.max` / `memory.max` 等限制。
- Broker 是唯一需要 root、`/dev/kvm`、Firecracker 资产与控制 token 的进程。
- 快照加速只在 jailer 下安全；非 jailer 开启快照会被驱动 fail-closed。

## 6. 启动 Master（非 root）

创建 `/etc/harness/master.env`：

```sh
HARNESS_ENV=production
HARNESS_HOST=127.0.0.1
HARNESS_PORT=3100
HARNESS_DATABASE_PATH=/var/lib/harness/harness.sqlite
HARNESS_WORKSPACE_ROOT=/var/lib/harness/workspaces
HARNESS_VM_RUNTIME_ROOT=/var/lib/harness/vm-runtime
HARNESS_BOOTSTRAP_API_KEY=replace-with-bootstrap-key

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

创建 `/etc/systemd/system/harness-master.service`：

```ini
[Unit]
Description=Harness Master (non-root)
Requires=harness-broker.service
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
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

说明：
- Master 只依赖 Broker socket，不需要 Firecracker 资产路径，也不应加入 `kvm` 组。
- `HARNESS_WORKER_ISOLATION=systemd` 时，每次 Run 由 launcher 创建 `harness-worker-<runId>` 瞬时单元，Worker 使用 `harness-worker` UID、`MemoryMax`、`CPUQuota`、`TasksMax`、`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome=read-only`。
- Worker 只读宿主、只写 `/var/lib/harness-worker` 与自己的 `TMPDIR`；模型凭据只存在于 `/var/lib/harness-worker`。

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

Run 执行期间可观察 Worker 单元与 cgroup：

```bash
systemctl list-units 'harness-worker-*' --no-pager
systemctl show 'harness-worker-<runId>.service' -p UID -p GID -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax
```

重启与恢复：
- Master 重启后 SQLite 中的 `QUEUED`/`RUNNING` Run 由启动对账与队列 pump 恢复；Worker 是瞬时单元，不持有持久状态。
- Broker 重启会删除并重建 socket；需要与 Master 使用同一个 control token。
- 异常退出后建议检查 `systemctl list-units 'firecracker*'` 与 `journalctl -u harness-broker -u harness-master`；平台启动时也有孤儿 VM 对账逻辑。

## 8. 安全与运维边界

- Agent 无网络：microVM 无网卡；`allowNetwork=true` 在平台侧被拒绝；不要给 Broker/Worker 添加 NAT/代理。
- Broker 只暴露 `create/execute/terminate`；control token 只存在于 root 可读文件与 Master 进程，Worker 只拿自己 sandbox 的 capability token；`HARNESS_SANDBOX_BROKER_MASTER_UID` / `HARNESS_SANDBOX_BROKER_WORKER_UID` 再把操作绑定到进程 UID。
- Master 应只监听内网/本机，前置反向代理时自行加 TLS 与访问控制；平台只做 API Key/租户级授权。
- 快照池、VM runtime、workspaces 都属于 Broker/Master 的本地数据目录；不要手工修改正在使用的磁盘。
- 当前明确暂缓：Worker seccomp/Landlock、控制面 egress ACL；Broker SO_PEERCRED 已在 v1.3 解冻并实现（见 `docs/platform-boundary.md §9.7`）。
