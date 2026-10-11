# VRAM-Aware Harness

面向多租户的 Agent 任务服务：隔离执行、公平调度、可审计。项目定位是个人 / 小私有部署的裁剪版，不是 Grok/Manus 式完整平台；权威边界见 docs/platform-boundary.md §9（2026-10-10 已冻结）。

核心目标只有三件事：

1. **任务生命周期与调度**：多租户提交任务，按租户轮转、全局/单租户并发上限、会话串行与 Queue TTL 公平调度。
2. **副作用与恢复**：工具调用先记账后执行，崩溃/中断后只自动重放安全操作。
3. **隔离与身份边界**：API Key 派生 Tenant，工具与文件操作限制在 jailer + Firecracker microVM（生产）或 runsc Sandbox（开发）内。

技术栈：Bun + TypeScript + SQLite；沙箱使用 jailer + Firecracker microVM（生产）或 Docker/runsc（开发）；模型后端为外部 OpenAI 兼容服务（本地 vLLM 或 opencode-go 等），平台不观测推理侧 GPU/KV cache。

## 核心能力

### 多租户任务
- API Key → Principal → Tenant
- Workspace / Session / Run / Attempt 生命周期
- Run 状态机 + 追加式 RunEvent 时间线
- 最终回答、Workspace Diff、Artifact 交付

### 调度与并发准入
- Tenant 内 FIFO、Tenant 间轮转
- 全局 / 单租户并发上限
- 会话串行与 Queue TTL
- 平台不观测推理侧 GPU/KV cache；准入由全局/租户并发、会话串行与 Queue TTL 决定
- 资源恢复后自动推进队列

### 工具治理与恢复
- ToolEffect：只读、幂等写、未知副作用
- `PREPARED → SUCCEEDED / FAILED` 工具执行账本
- READ_ONLY 自动重放；UNKNOWN_EFFECT 转人工复核
- Checkpoint 恢复与启动对账

### 隔离执行
- Worker 子进程运行时
- runsc 容器：只读根、无网络、能力丢弃、CPU/内存/PID 限制
- ToolGateway 策略白名单与工作区路径围栏
- 审计事件按租户可查

### 外部模型调用
- 外部 OpenAI 兼容服务（opencode-go / 自建 vLLM 等）经 Pi runtime 调用
- 平台不承载模型、不做 GPU/VRAM 观测、不做显存感知调度
- 可选的多后端网关与上下文预算兜底保留在代码中，不属于个人项目裁剪边界的核心验收

## 快速开始

```bash
bun install
bun run verify:stage0
```

演示：

```bash
bun run demo:day7
bun run demo:console
bun run scripts/user-console-demo-server.ts
# http://127.0.0.1:3977/app
```

单机 systemd 部署（Broker 以 root 运行，Master/Worker 非特权）见 `docs/deployment-single-node-systemd.zh-CN.md`。

连接外部模型服务（OpenAI 兼容 / opencode-go / 自建 vLLM）：

```bash
HARNESS_PORT=13000 \
HARNESS_DATABASE_PATH=./data/harness.sqlite \
HARNESS_WORKSPACE_ROOT=./data/workspaces \
PI_PROVIDER=opencode-go \
PI_MODEL_ID=deepseek-v4.1-flash \
PI_AUTH_PATH=~/.pi/agent/auth.json \
bun run src/main.ts
```

模型接入沿用 Pi runtime（`PI_PROVIDER` / `PI_MODEL_ID` / `PI_MODELS_PATH` / `PI_AUTH_PATH`）；平台不承载模型，也不做显存感知调度。

## 目录

```text
src/
├── app/         配置、组合根、应用门面
├── http/        HTTP API、用户工作台、请求工具
├── auth/        API Key / 用户账号
├── runs/        Run、Attempt、RunStore、RunService
├── scheduling/  RunScheduler 与租户公平队列
├── resources/   资源快照与准入决策（外部模型服务固定 NORMAL）
├── runtime/     PiAdapter、Worker 执行器、运行事件
├── worker/      Worker 进程与 IPC
├── sandbox/     jailer + Firecracker microVM（生产）/ runsc（开发）Sandbox
├── tools/       工具执行账本与 ToolGateway
├── policies/    有效策略与工具守卫
├── checkpoints/ Checkpoint 与恢复
├── llm-gateway/ 外部模型调用网关（可选多后端）
├── workspaces/  Workspace Diff 与 Artifact
├── sessions/    Session 存储
├── audit/       访问审计
└── storage/     SQLite 与 schema.sql
```

测试：

```bash
bun test ./tests
```

当前测试基线：`530 pass / 7 skip / 0 fail`。

实验室/他人接入前的最小运维：

```bash
# 注册收口：open（默认兼容）/ invite（需邀请码）/ closed
HARNESS_REGISTRATION_MODE=invite
HARNESS_REGISTRATION_INVITE_CODE=change-me

# HTTP 入口限流（默认开启；可按实验室人数调整）
HARNESS_RATE_LIMIT_MAX_PER_TENANT=600
HARNESS_RATE_LIMIT_MAX_PER_IP=120

# 磁盘水位、SQLite 备份/恢复、VM 与快照清理
bun run scripts/harness-ops.ts disk-check --path / --warn 80 --critical 90
bun run scripts/harness-ops.ts backup --database data/harness.sqlite --backup-dir data/backups --keep 7
bun run scripts/harness-ops.ts cleanup --vm-runtime /var/lib/harness/vm --snapshot-pool /var/lib/harness/snapshots --max-age-hours 24 --max-snapshots 8 --apply
```

从实验室外访问时用 Caddy/Nginx 终止 TLS，Master 只监听 loopback：

```bash
# deploy/harness-caddy.example / deploy/harness-nginx.example
# 只放行 443（可选 80），不要放行 3100
```

升级/回滚必须先备份数据库（迁移向前执行，无 down migration）：

```bash
bun run scripts/harness-ops.ts backup --database data/harness.sqlite --backup-dir data/backups --keep 7
```

详见 `docs/deployment-single-node-systemd.zh-CN.md`、`docs/tls-reverse-proxy.zh-CN.md`、`docs/upgrade-rollback-runbook.zh-CN.md` 与 `docs/platform-boundary.md` §9.5。
