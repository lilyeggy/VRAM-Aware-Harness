# Linux CPU Server 部署手册

> 目标：租到一台 Linux x86_64 CPU 服务器后，直接部署当前 Harness，运行真实 Docker/runsc Sandbox，并通过外部 OpenAI-compatible Model API 驱动 Agent。本文不要求服务器本地保存模型，也不要求 GPU。

## 1. 租赁验收条件

推荐最低配置：

```text
8 vCPU
32 GiB RAM
100～200 GiB 数据盘（本地 NVMe 优先）
Ubuntu Server 22.04/24.04 LTS
x86_64
root/sudo
Docker Engine
```

如果后续要验证 Kata/Firecracker，额外要求：

```text
/dev/kvm 可用
允许安装和运行自定义 runtime
```

租赁后先确认：

```bash
uname -m
uname -a
nproc
free -h
df -h
ls -l /dev/kvm 2>/dev/null || true
```

必须是 `x86_64`。没有 `/dev/kvm` 不阻止 runc/runsc，但 strict microVM 只能保留为未验证候选。

## 2. Ubuntu 基础环境

使用 Ubuntu Server，不安装图形桌面。不要为了“裁剪”而替换系统 kernel；保留发行版 kernel，以免破坏 cgroups v2、overlayfs、namespace、seccomp、Docker 或 KVM。

以管理员身份安装基础工具和 Docker Engine。Docker 应该按照 Docker 官方 Ubuntu 文档安装 rootful Docker Engine，而不是 Docker-in-Docker。安装后确认：

```bash
docker info
docker version
```

建议使用独立服务用户，不要让 Harness 进程以 root 运行：

```bash
sudo useradd --create-home --shell /bin/bash harness
sudo usermod --append --groups docker harness
sudo mkdir -p /data/harness /srv/VRAM-Aware-Harness
sudo chown -R harness:harness /data/harness /srv/VRAM-Aware-Harness
```

`docker` 组具有接近 root 的宿主权限，只适合本项目的单机面试实验；不要把该配置误写成企业生产安全模型。

## 3. 配置 gVisor/runsc

按照 gVisor 官方安装文档安装与当前 Docker Engine 匹配的 `runsc`，并注册为 Docker runtime。不要下载来源不明的二进制，也不要在没有验证版本的情况下把它标为 default。

安装后检查：

```bash
command -v runsc
runsc --version
docker info --format '{{json .Runtimes}}'
```

必须看到 `runsc` runtime。然后执行真实 runtime smoke：

```bash
docker run --rm --runtime runsc alpine:3.20 true
```

如果 runtime 不存在、Docker daemon 不可用或 smoke 失败，停止部署，不要把 `runc` 配成 default 的替代品。

## 4. 部署代码和 Bun

以 `harness` 用户执行：

```bash
sudo -iu harness
# 使用项目实际仓库地址
git clone git@github.com:lilyeggy/VRAM-Aware-Harness.git /srv/VRAM-Aware-Harness
cd /srv/VRAM-Aware-Harness

# 安装 Bun，再重新登录或加载 Bun PATH
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

bun --version
bun install
bun run typecheck
bun run test
```

如果服务器策略不允许安装 Bun，可使用预装 Bun 的基础镜像或发行版包，但必须保证 `bun run typecheck` 和 `bun run test` 能执行。不要把 `node_modules` 或 `.pi` 配置提交到仓库。

## 5. 准备服务目录和 UID

当前 Workspace 会由 Harness 自动创建，不需要人工按 Tenant 创建目录。

关键约定是：Harness 服务用户和容器执行 UID 使用同一个非 root UID。这样 `WorkspaceService` 创建的 `0700` 目录可以直接被容器读取/写入，不需要让 Harness 进程以 root 运行或把目录放宽到 `777`。

查询服务用户 UID：

```bash
id -u harness
```

以 `harness` 用户创建数据目录：

```bash
mkdir -p \
  /data/harness/database \
  /data/harness/workspaces \
  /data/harness/artifacts \
  /data/harness/logs \
  /data/harness/benchmarks
```

## 6. 外部 Model API 配置

Harness 不要求本机保存模型。可以连接任何 OpenAI-compatible endpoint，例如远程 vLLM 或其他 API 服务。

Pi 的模型配置文件当前位于被 Git 忽略的：

```text
.pi/spike/models.json
```

在服务器创建该文件，配置：

```text
provider
model id
base URL
API key（如需要）
```

API 服务不应直接暴露给 Sandbox。模型调用由 Harness/Pi 进程发起；Sandbox 只负责 Agent 工具、文件和命令执行。

如果暂时没有真实 Model API，可以先使用项目的 Fake/Demo Runtime 完成控制面和 Workspace 验收，但不能把它当成真实模型兼容性证据。

## 7. 服务环境文件

创建一个不提交到 Git 的环境文件，例如 `/etc/vram-aware-harness/harness.env`：

```bash
sudo mkdir -p /etc/vram-aware-harness
sudo chown root:harness /etc/vram-aware-harness
sudo chmod 0750 /etc/vram-aware-harness
sudo touch /etc/vram-aware-harness/harness.env
sudo chown root:harness /etc/vram-aware-harness/harness.env
sudo chmod 0640 /etc/vram-aware-harness/harness.env
```

内容示例：

```dotenv
VLLM_MODEL_ID=qwen3.5-4b
VLLM_BASE_URL=http://127.0.0.1:8000/v1
VLLM_METRICS_URL=http://127.0.0.1:8000/metrics
PI_PROVIDER=local-vllm
PI_MODELS_PATH=/srv/VRAM-Aware-Harness/.pi/spike/models.json

HARNESS_DATABASE_PATH=/data/harness/database/harness.sqlite
HARNESS_WORKSPACE_ROOT=/data/harness/workspaces
HARNESS_HOST=127.0.0.1
HARNESS_PORT=3000
HARNESS_PUMP_INTERVAL_MS=1000

HARNESS_SANDBOX_PROVIDER=container
HARNESS_SANDBOX_PROFILE=default
HARNESS_SANDBOX_RUNTIME=runsc
HARNESS_CONTAINER_IMAGE=alpine:3.20
HARNESS_CONTAINER_USER_ID=1001

HARNESS_MAX_ACTIVE_RUNS=2
HARNESS_MAX_ACTIVE_RUNS_PER_TENANT=1
HARNESS_GPU_IDS=0
HARNESS_RESOURCE_TIMEOUT_MS=3000
HARNESS_BOOTSTRAP_API_KEY=替换为至少16位的高熵随机Key
```

`HARNESS_CONTAINER_USER_ID` 必须替换为：

```bash
id -u harness
```

不要固定照抄 `1001`，也不要使用 `0`。

如果使用外部 Model API，修改 `VLLM_BASE_URL` 和 `VLLM_METRICS_URL`；如果外部服务没有 vLLM metrics，资源观察需要使用项目已有的 Fake/兼容 observer，不能伪造 GPU 指标。

## 8. 执行 preflight

在仓库目录执行：

```bash
export PATH="$HOME/.bun/bin:$PATH"
export HARNESS_SERVER_ROOT=/data/harness
export HARNESS_CONTAINER_USER_ID="$(id -u)"
bash scripts/server-preflight.sh
```

preflight 检查：

- Linux 和 CPU 架构；
- CPU、内存、数据盘；
- Docker CLI 和 daemon；
- cgroups v2；
- Docker 是否注册 runsc；
- Docker + runsc 真实启动；
- 非 root container UID；
- Bun；
- `/dev/kvm`（没有时只给 warning）。

`RESULT: PASS` 之前不要运行完整 Agent 任务。`WARN` 需要记录到实验报告；`FAIL` 必须先解决。

## 9. systemd 服务

复制并修改：

```bash
sudo cp deploy/harness.service.example /etc/systemd/system/vram-aware-harness.service
sudo systemctl daemon-reload
sudo systemctl enable --now vram-aware-harness
sudo systemctl status vram-aware-harness
```

初次部署也可以先前台运行：

```bash
sudo -iu harness
cd /srv/VRAM-Aware-Harness
export PATH="$HOME/.bun/bin:$PATH"
set -a
source /etc/vram-aware-harness/harness.env
set +a
bun run start
```

前台运行确认成功后，再交给 systemd。

## 10. 首轮应用验收

健康检查：

```bash
curl -sS http://127.0.0.1:3000/health
```

创建 Workspace：

```bash
export HARNESS_API_KEY='与环境文件一致的 bootstrap key'
curl -sS http://127.0.0.1:3000/workspaces \
  -H "Authorization: Bearer ${HARNESS_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"name":"server-smoke"}'
```

然后使用返回的 `workspaceId` 提交任务。Workspace 目录会自动出现在：

```text
/data/harness/workspaces/<tenant>/<workspace-id>
```

真实 Sandbox 验收：

```bash
bun run smoke:container
bun run smoke:container:attacks
bun run benchmark:sandbox
```

注意：`demo:console` 使用 Fake Runtime，只证明用户旅程和控制面；它不替代 Docker/runsc smoke。

## 11. 部署完成标准

服务器部署完成需要同时满足：

1. `bun run typecheck` 通过；
2. `bun run test` 通过；
3. `/health` 返回成功；
4. API Key 能创建 Workspace；
5. Workspace 目录由服务自动创建，名称和 Tenant 边界正确；
6. `server-preflight.sh` 返回 `RESULT: PASS`；
7. `smoke:container` 能取得实际 runsc evidence；
8. `smoke:container:attacks` 和 benchmark 的输出被保存；
9. 没有把 Fake Runtime、数据库配置或 Docker fake 当成真机隔离证据。
