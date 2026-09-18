# VRAM-Aware Harness

面向团队共享本地大模型的多租户 Agent 任务服务。

核心目标只有三件事：

1. **任务生命周期与调度**：多租户提交任务，按租户轮转、并发上限和 vLLM/GPU 资源压力公平调度。
2. **副作用与恢复**：工具调用先记账后执行，崩溃/中断后只自动重放安全操作。
3. **隔离与身份边界**：API Key 派生 Tenant，工具与文件操作限制在 runsc Sandbox 内。

技术栈：Bun + TypeScript + SQLite；沙箱使用 Docker/runsc；模型后端为 OpenAI 兼容 vLLM。

## 核心能力

### 多租户任务
- API Key → Principal → Tenant
- Workspace / Session / Run / Attempt 生命周期
- Run 状态机 + 追加式 RunEvent 时间线
- 最终回答、Workspace Diff、Artifact 交付

### 调度与资源准入
- Tenant 内 FIFO、Tenant 间轮转
- 全局 / 单租户并发上限
- 会话串行与 Queue TTL
- vLLM/GPU 资源观测 → `START / QUEUE` 准入
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

### 最小 LLM Gateway
- 多后端路由：priority / round-robin / least-active
- 健康探测、熔断、失败回退
- 上下文预算压缩
- 不包含 prefix cache、stream usage 采集、工具参数修复

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

连接真实 vLLM：

```bash
HARNESS_PORT=13000 \
HARNESS_DATABASE_PATH=./data/harness.sqlite \
HARNESS_WORKSPACE_ROOT=./data/workspaces \
VLLM_BASE_URL=http://127.0.0.1:18000/v1 \
bun run src/main.ts
```

## 目录

```text
src/
├── app/         配置、组合根、应用门面
├── http/        HTTP API、用户工作台、请求工具
├── auth/        API Key / 用户账号
├── runs/        Run、Attempt、RunStore、RunService
├── scheduling/  RunScheduler 与租户公平队列
├── resources/   vLLM/GPU 观测、分类与准入
├── runtime/     PiAdapter、Worker 执行器、运行事件
├── worker/      Worker 进程与 IPC
├── sandbox/     runsc / managed-local Sandbox
├── tools/       工具执行账本与 ToolGateway
├── policies/    有效策略与工具守卫
├── checkpoints/ Checkpoint 与恢复
├── llm-gateway/ 最小模型路由网关
├── workspaces/  Workspace Diff 与 Artifact
├── sessions/    Session 存储
├── audit/       访问审计
└── storage/     SQLite 与 schema.sql
```

测试：

```bash
bun test ./tests
```

当前测试基线：`373 pass / 0 fail`。
