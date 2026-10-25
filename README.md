# VRAM-Aware Harness

> **单机多用户 Agent 宿主层：准入 / 调度 / 隔离 / 溯源**
>
> 命名保留历史原因：M4 起平台不再观测 VRAM/GPU（模型服务在平台外），当前形态是「外部模型 + 单机多用户宿主层」。定位与边界见 `docs/platform-boundary.md` §9.1 / §9.10（v1.6）/ §9.11（v1.7，隔离域统一为 user）。

宿主层只做四件事，其余都不属于它：

| 职责 | 只回答一个问题 | 可证伪的检验 |
|---|---|---|
| **准入** | 接不接、接多少？ | 超额时能否干净拒绝（429 + Retry-After） |
| **调度** | 现在轮到谁？ | 任意 Run 的等待时间是否有上界 |
| **隔离** | 跑在哪、能碰到什么？ | 越界能否被证明 |
| **溯源** | 事后能证明什么？ | 崩溃后能否安全重放 |

项目定位是个人 / 小私有部署的裁剪版，不是 Grok/Manus 式完整平台。

核心目标只有三件事：

1. **任务生命周期与调度**：多用户提交任务，按用户轮转、全局/单用户并发上限、会话串行与 Queue TTL 公平调度。
2. **副作用与恢复**：工具调用先记账后执行，崩溃/中断后只自动重放安全操作。
3. **隔离与身份边界**：API Key 派生 User，工具与文件操作限制在 jailer + Firecracker microVM（生产）或 runsc Sandbox（开发）内。





调度层量化基准：`scripts/scheduler-benchmark.ts`（容量利用率 / 公平性 / 批屏障提速）。

技术栈：Bun + TypeScript + SQLite；沙箱使用 jailer + Firecracker microVM（生产）或 Docker/runsc（开发）；模型后端为外部 OpenAI 兼容服务（本地 vLLM 或 opencode-go 等），平台不观测推理侧 GPU/KV cache。

## 核心能力

### 多用户任务
- API Key → Principal → User
- Workspace / Session / Run / Attempt 生命周期
- Run 状态机 + 追加式 RunEvent 时间线
- 最终回答、Workspace Diff、Artifact 交付

### 调度与并发准入
- User 内 FIFO、User 间轮转
- 全局 / 单用户并发上限
- 会话串行与 Queue TTL
- 平台不观测推理侧 GPU/KV cache；准入由全局/用户并发、会话串行与 Queue TTL 决定
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
- 审计事件按用户可查

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
├── scheduling/  RunScheduler 与用户公平队列
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

当前测试基线：`675 pass / 10 skip / 0 fail`。

生产级 VM 生命周期基准（Phase 1，§9.8 v1.4）见 `docs/vm-lifecycle-benchmark.zh-CN.md`，运行脚本为 `scripts/vm-lifecycle-benchmark.ts`；
启动加速的**持续台账**（每条优化的背景/机制/实测/代价/提交）见 `docs/vm-startup-optimizations.zh-CN.md`。
生产实例的真机全流程验证（36 项断言 + 平台侧隔离性探针 13 项）见 `docs/production-full-flow-report.zh-CN.md`；隔离性探针脚本为 `scripts/sandbox-security-probe.ts`（不经过 Agent，直接用 `provider.execute` 下探 guest）。
热恢复默认走"共享只读基础文件"（内核/快照文件硬链接，`HARNESS_VM_SHARE_BASE_FILES`，
设 `0` 关闭），实测 498ms → 176ms；再加 `HARNESS_VM_SHARE_ROOTFS=1` 可到 101ms，
但 guest 内除 `/workspace` 外只读（详见该文档的 A/B 与踩坑小节）。
VM 创建分阶段耗时埋点：设 `HARNESS_VM_PHASE_TRACE=1` 后每台 VM 会向 stderr 打 `[vm-phase] <sandboxId> <阶段> <ms>`（默认关闭零开销）；`HARNESS_VM_BOOT_VERBOSE=1` 可打开内核启动日志并把 `serial-first-line` 纳入排障。
首次冷启动（池空后的第一次 create，≈2.2s）已拆解为 guest 用户态就绪 ~1.28s + 写内存镜像 ~0.9s，**靠调参消不掉**；对用户可见的解法是服务启动预热：`scripts/vm-snapshot-prewarm.ts` + `deploy/harness-vm-prewarm.{service,timer}.example`，生产实测预热后首个 Run `warmHit:true` / 166ms。
主流 Agent Sandbox 技术方案调研（E2B / Daytona / Modal / CubeSandbox / CodeSandbox / Firecracker 官方快照与 UFFD 等）见 `docs/agent-sandbox-landscape.zh-CN.md`。
深度 backpressure / RunAttempt 租约心跳（Phase 2，§9.8 v1.4）见 `.env.example` 的 `HARNESS_MAX_QUEUED_RUNS*` 与 `HARNESS_RUN_LEASE_*`；**v1.6 已删除队列优先级**（所有用户等权，见 `docs/platform-boundary.md` §9.10）。
Durable Execution / 重试 / Run 幂等键（Phase 3，§9.8 v1.4）见 `.env.example` 的 `HARNESS_RUN_MAX_ATTEMPTS`、`HARNESS_RUN_RETRY_*`；提交 `POST /runs` 或会话消息时可带 `idempotencyKey`，终态后以 `RUN_ARTIFACTS_READY` 事件标记 artifacts 可读。
MCP 工具接入（Phase 4，§9.8 v1.4）见 `.env.example` 的 `HARNESS_MCP_SERVERS`：stdio MCP server 的工具以 `mcp__<server>__<tool>` 暴露，调用仍经过 ToolGateway 的策略守卫、PREPARED 记账与审计；烟测脚本 `scripts/mcp-smoke.ts`。

排队可见：`GET /queue` 返回每个排队 Run 的位置、阻塞原因与 `estimatedWaitMs`（按最近 5 分钟完成速率估算）。

Run 分步时间线：`GET /runs/:id/trace` 把事件流折叠成「每步耗时 + token/成本归因」（沙箱获取、每次模型调用、每次工具调用的耗时与 usage，含排队等待、墙钟合计，以及**未归因时间 `unaccountedMs`**、**请求组装 `requestAssemblyMs`** 与 **provider 首字 `upstreamTtftMs`**），只读聚合，不改变任何状态。真机实测一次 Run 有 95% 墙钟落在未归因区间（Pi 会话初始化 ~2.7s、工具到下一轮 ~1.2s）。

最小可观测性：`GET /metrics` 返回 Prometheus 文本，需要 `metrics:read` scope（bootstrap key 的 `*` 可读），包含 `harness_runs{status}`、`harness_runs_queued`、`harness_sandbox_acquisitions_total{warm}`、`harness_http_requests_total{status}` 等。

面试向的架构讲解：`docs/interview-architecture.zh-CN.html`（文字版）与 `docs/interview-architecture-visual.zh-CN.html`（动态图版：全链路数据流动画 + 13 个模块内部流转 + 模块实现速查 + 虚拟机技术专区（Firecracker / jailer / vsock / 快照 / 磁盘与快照池，面向只有 Docker 基础的人））。

实验室/他人接入前的最小运维：

```bash
# 注册收口：open（默认兼容）/ invite（需邀请码）/ closed
HARNESS_REGISTRATION_MODE=invite
HARNESS_REGISTRATION_INVITE_CODE=change-me

# HTTP 入口限流（默认开启；可按实验室人数调整）
HARNESS_RATE_LIMIT_MAX_PER_USER=600
HARNESS_RATE_LIMIT_MAX_PER_IP=1200

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
