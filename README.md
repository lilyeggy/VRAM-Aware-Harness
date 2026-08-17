# VRAM-Aware Agent Harness

一个支持团队共享本地大模型的**多租户 Agent 任务服务**。用户可以为项目创建独立
Workspace、提交 Agent 任务、查看执行过程和文件修改，并中断或恢复任务；系统在
后台为每次执行分配受 Tenant 策略约束的隔离环境，根据 GPU 与 vLLM 状态公平调度，
并通过工具副作用记录和 Checkpoint 保证故障后的安全恢复。

项目不重新实现模型—工具循环，当前使用 Pi + 自托管 vLLM。内部工程重点集中在
③ Environment/Sandbox 和④ Execution/Orchestration：前者落实租户隔离，后者管理
身份、策略、调度、生命周期和恢复。它们服务于用户任务闭环，不作为产品名称或独立
基础设施对外呈现。

## 规范定义

后续设计、实现和项目介绍统一使用下面这一定义：

> **VRAM-Aware Agent Harness 是一个支持团队共享本地大模型的多租户 Agent 任务
> 服务。用户可以在独立 Workspace 中提交任务、观察 Agent 执行并获得最终回答、
> 文件 Diff 和 Artifact；系统负责可信租户身份、隔离运行环境、公平调度共享 GPU、
> 工具权限与副作用治理，以及故障后的安全恢复。**

项目要解决的不是“如何再实现一个 Agent”，也不只是“显存高就排队”。真正问题是
如何让多个用户安全地把真实项目交给 Agent：他们之间不能互相读取代码和 Secret，
共享 GPU 时不能永久饥饿，任务失败后不能重复危险副作用，并且最终必须得到可使用的
修改结果，而不只是一个数据库终态。

项目范围分为三个层级，不能混为同一个交付承诺：

| 层级 | 明确内容 | 当前状态 |
| --- | --- | --- |
| 当前产品定位 | 团队共享本地模型的多租户 Agent 任务服务 | 已由 ADR 0009 固定 |
| Day 1–7 MVP | 单进程 + SQLite，证明 Pi Run、副作用恢复、GPU 准入、公平队列和自动续跑 | 本地闭环已完成 |
| 已完成深化 | Template、Instance、Capability、Effective Policy 与最小 Sandbox 已进入 Pi 主路径 | 保留，不继续平台化扩张 |
| 当前产品深化 | 可信身份、Tenant Workspace、真实 Sandbox、任务结果与最小用户界面 | 当前唯一主线 |
| 真实验收 | A6000、多租户隔离攻击、故障恢复、公平调度和用户端到端流程 | 必须提供可复现证据 |
| 秋招后候选 | 第二 Runtime、多 Worker/K8s、异构资源池、vLLM 深化 | 只按目标岗位和真实数据选择 |

多租户是用户、项目、数据、权限、资源和审计归属的一等边界。第一版不会建设复杂
组织管理、企业 SSO 或计费，但必须提供可信身份、Tenant-scoped 数据访问以及文件、
进程、网络和 Secret 的真实执行隔离。

## 用户可以做什么

- 登录团队空间并创建或选择项目 Workspace；
- 提交 Agent 任务，查看排队原因、执行状态和实时输出；
- 让 Agent 在隔离环境中读取代码、修改文件并运行命令或测试；
- 查看工具过程、最终回答、文件 Diff 和必要 Artifact；
- 中断或恢复任务，对不确定副作用进行人工确认；
- Tenant 管理员配置并发、模型、Tool、Execution Profile 和 Secret Reference。

## 内部技术重点

本项目不以 Prompt 模板、私有记忆算法或另一套 Agent Loop 作为核心差异化。
模型与 Agent Runtime 会持续吸收通用的提示、上下文压缩、工具循环和会话能力；
项目重点解决模型或单一 Harness 升级不会自动解决的系统问题：

- **副作用感知的可靠执行**：用状态机、事务、追加式事件、幂等和 Checkpoint 判断自动恢复、复用结果或停止等待处理；
- **资源感知的准入与背压**：让 vLLM Metrics、GPU 状态和并发 slot 真正改变 `START / QUEUE`，资源恢复后自动推进队列；
- **工具治理**：让外部资源调用经过权限、超时、副作用分类和可重放性判断；
- **可解释决策**：保存模型调用、工具执行、资源快照、策略版本、理由、usage 和结果；
- **多租户公平调度**：Tenant 内 FIFO、Tenant 间 round-robin，并结合全局与单
  Tenant 并发上限，避免单一 Tenant 持续提交任务造成永久饥饿；
- **真实执行隔离**：按 Run/Attempt 创建独立 Sandbox，落实 Workspace、文件、
  进程、网络、Secret 与计算资源边界；
- **可信身份与授权**：从认证 Principal 派生 Tenant，所有外部数据与操作按 Tenant
  收口，不再信任客户端自报 `tenantId` 或任意宿主机路径；
- **版本化期望状态**：用 HarnessTemplate 和 HarnessInstance 管理配置版本、执行
  环境和生命周期，而不是只保存可变配置；
- **策略与 Sandbox 强制执行**：将平台、Tenant、Template、Workspace 与 Run 策略
  交集落实到 Runtime、ToolGateway 和外部 Sandbox；
- **用户结果闭环**：任务完成后交付最终回答、文件 Diff、命令/测试结果与 Artifact，
  内部事件和策略作为解释证据，而不是产品本身。

Tenant 是数据、策略、资源和审计归属边界。HarnessInstance 是受控制面管理的执行
环境，不等于永久进程或 Session；Session 是对话关系，Run 是一次受控任务，
Attempt 是 Run 的一次实际执行。当前已完成 API Key 派生 Tenant、受管 Workspace 和
容器 Sandbox 的创建/命令边界；Pi 内置文件与 Shell 工具切换到该命令边界仍是下一项。
因此，在工具接入和真机攻击测试完成前，不把“容器已创建”表述成“所有工具已容器化”，
也不宣称生产级隔离。

不把 Prompt、Memory 和 Context Engineering 作为核心差异化，不表示这些问题
已经彻底解决；它只表示这些 Agent 行为能力由模型与可替换 Runtime 持续演进，
本项目只保存可靠执行所需的上下文版本、成本、权限和恢复事实。

Day 1–7 的可靠执行合同见
[ADR 0006](docs/adr/0006-narrow-mvp-to-recovery-and-resource-admission.md)；当前定位见
[ADR 0009](docs/adr/0009-build-a-multi-tenant-agent-task-service.md)；当前唯一实施入口是
[多租户 Agent 任务服务路线图](docs/multi-tenant-agent-task-service-roadmap.zh-CN.md)。
ADR 0007、ADR 0008 及其路线图保留为历史方案，不代表当前产品承诺。

## 模型与推理环境基线

Harness 将模型视为可替换的推理工作负载，而不是领域模型的一部分。当前以单卡
RTX A6000 48 GB 为硬件基线：Qwen3.5-4B 用于高频开发和快速回归，
Qwen3.5-9B 用于主要集成验证。真实模型测试先限制在 16K 上下文，需要时再提高
到 32K；状态机、恢复、工具幂等和策略分支仍主要由 Fake Runtime 确定性验证。

我们能够修改自己的 vLLM fork，但源码权限不等于立即重写 Scheduler。第一阶段
优先使用标准 API、usage 和 Metrics，并按需增加 Tenant/Run/Trace 请求归因与
观测扩展点；只有基线数据证明存在收益时，才进入 priority、KV Events、offload
或 Agent-aware scheduling。模型 ID、Parser、Chat Template 和量化参数必须留在
部署配置中，不能进入 Harness 业务服务。

详细决策见
[ADR 0005](docs/adr/0005-use-replaceable-models-and-extensible-vllm.md)。

## 已完成的 Day 1–7 MVP

第一周已经交付一条可证明核心价值的 Pi 纵向切片：

```text
用户提交任务
  → Harness 创建 AgentRun
  → ExecutionPolicy 决定启动或排队
  → PiAdapter 驱动 Pi Agent Runtime
  → Pi 向自托管 vLLM 发出模型请求
  → 工具调用经过 ToolGateway
  → RunEvent、ToolExecution、Checkpoint 持久化
  → Run 完成，或在安全边界恢复
```

MVP 的验收重点：

- Pi 替代新主路径上的自研 Agent Loop；
- 每次执行有独立 `AgentRun` 和可查询事件时间线；
- 工具执行具有副作用分类和恢复边界；
- GPU 压力会改变新任务的启动/排队决策；
- 两个 Tenant 在受限并发下仍能获得可解释的公平性。

这条历史基线用下面的问题约束实现范围：

> 在不修改 Pi、且不依赖深度重写 vLLM Scheduler 的情况下，Harness 能否依据
> Run 状态、工具副作用和真实资源事实，安全地控制新任务启动，并在故障或资源
> 压力解除后自动、可解释地继续执行？

不能帮助回答这个问题的功能，没有进入第一周关键路径。它现在作为后续深化不可
破坏的可靠执行基线，而不是未来产品边界的全部。

## 产品对象与内部执行模型

```text
Tenant
  ├── Member / ApiCredential（可信身份）
  ├── ExecutionProfile（模型、工具、网络、资源与 Secret 策略）
  ├── Workspace（用户项目与受管代码根目录）
  │     └── Session（连续交互）
  │           └── Run（一次用户任务）
  │                 ├── Attempt（一次实际执行）
  │                 ├── SandboxInstance（隔离环境）
  │                 └── Result / Diff / Artifact（用户交付物）
  └── Quota / Policy / Audit（租户级治理）
```

当前代码已有 Template、Instance、Session、Run 和 Attempt 等内部对象，下一阶段
会补齐面向用户的身份、Workspace、ExecutionProfile 与 Result。Template/Instance
可以继续作为内部版本化和运行绑定机制，但不会直接暴露为产品主概念。当前只管理
Pi 这一条真实 Runtime 路径；`AgentRuntime`、Fake Runtime 和 CapabilityProfile
继续分别承担依赖倒置、确定性测试和启动前能力验证，不宣称已经完成异构 Runtime
治理。安全能力不足时拒绝执行，任何降级都必须进入审计。

## 系统边界

| 层/组件 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| 产品/API | 身份、Tenant、Workspace、任务、结果、人工操作与管理员配置 | Agent Loop 和底层容器实现 |
| ④ Execution / Orchestration | Run/Attempt 生命周期、公平队列、资源准入、策略、恢复与审计 | token 级推理调度和用户代码执行 |
| ③ Environment / Sandbox | 为每个 Attempt 提供文件、进程、网络、Secret 与计算资源隔离 | 调度决策和 Agent 推理 |
| ①② Pi Runtime / ToolGateway | Agent Loop、上下文、Session、Tool 调用与 Runtime 事件适配 | Tenant 公平、容器边界与跨 Run 恢复 |
| ⑦ vLLM / NVIDIA GPU | 模型推理、token 级调度、物理 KV 和底层资源指标 | Run 状态、工具权限和 Tenant 恢复规则 |

在七层 Agent Infra 划分中，本项目直接建设第③层和第④层；第⑤层只做证明隔离、
调度和恢复所需的事件与指标，第①②层复用 Pi 并在 ToolGateway 处接入，第⑥层用于
回归和验收，第⑦层使用外部 vLLM。这样既有明确工程深度，又不会把用户产品包装成
一个抽象基础设施平台。

在资源控制这一层，Harness 根据 vLLM Metrics、NVIDIA GPU 状态与逻辑 slot 决定
Run 是否以及何时启动。Harness 不接管 vLLM 的 token 调度和物理缓存管理。当前不
建立通用 ResourcePool；远程模型费用、Sandbox 容量和多资源联合 claim 都是秋招后
按需演进项。

### 资源策略的演进方向

第一周的 `ExecutionPolicy` 使用配置化的确定性规则，目的是建立可测试的安全
基线和故障回退，而不是把固定阈值当作最终形态。MVP 完成后先依据真实对照实验
判断瓶颈；只有规则无法表达的重要场景被数据证明后，才评估成本预测、SLO 或
Scheduling Agent 等扩展，而且任何建议都不能绕过硬安全约束。

```text
AdmissionContext
  → Scheduling Agent 提出 START / QUEUE / DEFER 建议
  → PolicyValidator + Hard Guardrails 校验
  → 合法则执行；超时、越界或不可用则走 Deterministic Fallback
```

详细边界见 [ADR 0006](docs/adr/0006-narrow-mvp-to-recovery-and-resource-admission.md)；
Agentic Policy 仅作为候选研究路线，见
[ADR 0003](docs/adr/0003-guarded-agentic-resource-scheduling.md)。

## 当前进度

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| ADR：选择 Pi SDK | 已完成 | 固定 `@earendil-works/pi-coding-agent@0.80.10` |
| Pi + vLLM + 只读工具 Spike | 已完成 | 已验证模型 → `read` 工具 → 模型，并收到结束事件 |
| AgentRuntime 抽象 | 已完成 | Harness 命令与具体 Agent SDK 之间的稳定边界 |
| FakeAgentRuntime 合同测试 | 已完成 | `start/resume/interrupt/unsubscribe/runId` 隔离共 5 个测试 |
| PiAdapter | 已完成初版 | 已接入 Pi SDK 的 `start/resume/interrupt/subscribe` 适配；真实集成测试后续补 |
| AgentRun、SQLite 与 RunService | 已完成 | 状态机、migration、事务、Runtime 编排与恢复流程已验证 |
| RuntimeEventBridge | 已完成 | 工具/模型边界映射、usage、去重与事件时间线已验证 |
| ToolGateway、Checkpoint、安全恢复 | 已完成 | 工具幂等、副作用分类、原子 Checkpoint、恢复扫描与执行器已完成 |
| ResourceObserver、ExecutionPolicy | 已完成 | 已建立资源快照、状态分类、准入决策与持久化基线 |
| 资源队列、slot 与最小 Tenant 公平性 | 已完成 | Day 6：原子占位、Tenant 轮转、故障隔离与资源恢复自动推进已通过确定性验收 |
| HTTP API、应用组装与本地端到端演示 | 已完成 | Day 7：8 个端点、Composition Root、队列重建、Fake 恢复演示和真实 HTTP 进程 smoke |
| A6000 + Pi/vLLM 对照实验 | 待服务器执行 | 本地执行入口与实验手册已就绪，不在没有真实数据时声明性能收益 |
| Stage 1：Template / Instance / Capability | 已完成 | 新 Run 固定版本并贯穿 Instance、Session、Attempt；Pi 能力门已进入主路径 |
| Stage 2：Effective Policy / Sandbox | 已完成（最小实现） | 五层交集进入 Pi、ToolGateway 与 ManagedLocal；不支持的硬隔离 fail closed |
| P0.5：Sandbox 运行时分级 | 已完成第一步（真机待验证） | `default` 显式选择 runsc、保存 profile/runtime/inspect 证据；strict 只路由到预留 Provider，不回退 runc |
| ADR 0009 与产品路线图 | 已完成 | 固定用户任务服务定位，并将③ Sandbox、④ Orchestration 作为内部重点 |
| 可信身份与 Tenant-scoped API | 已完成 P0 切片 | API Key/Principal、服务端派生 Tenant、跨 Tenant Run 访问返回 404 |
| 受管 Workspace | 已完成 P0 切片 | `workspaceId` 映射到服务端 Tenant Root；客户端不能提交宿主机路径 |
| Container Sandbox 命令边界 | 已完成 P0 切片 | 每 Attempt 可使用非 root、只读 RootFS、cap drop、网络/CPU/内存/PID 限制的容器；Pi 文件/Shell 工具经容器命令边界执行 |
| 用户任务结果与最小 Web 界面 | 进行中 | 同源 Task Console、任务历史、输出、Workspace Diff 和终态 Artifact 已具备 Tenant-scoped API；工具时间线与人工处理待补 |
| Claude / 异构 ResourcePool | 已暂停 | 不进入秋招前主线 |

本轮逐项设计、攻击测试与后续缺口见
[P0 实施记录](docs/implementation-log/2026-08-p0-tenant-sandbox.zh-CN.md)。

Day 1–7 的本地工程闭环已经完成：Pi Runtime 边界、AgentRun 持久化、事件桥接、
ToolGateway、Checkpoint、安全恢复、ResourceObserver 与 ExecutionPolicy 均已
建立，并已形成公平队列、Run 级 slot、single-flight drain 与资源恢复自动推进闭环。
应用启动时会重建等待队列并扫描可恢复 Run，恢复任务仍须重新经过资源准入和 slot
占用。HTTP API、进程生命周期、Fake 端到端演示和本地真实 HTTP smoke 已完成；
Harness 自身 184 项测试、690 个断言和严格 TypeScript 检查通过。尚未完成的外部验证包括
A6000 上的 Pi/vLLM 固定任务对照实验。

## Day 7 本地闭环

不依赖 GPU 的固定演示会制造一个带 Checkpoint 的中断 Run 和一个普通排队 Run，
先将资源保持在 `CRITICAL`，再恢复为 `NORMAL`。输出会明确展示哪个 Run 调用了
`resume`、哪个调用了 `start`，以及完整 RunEvent 与 PolicyDecision 时间线：

```bash
bun run demo:day7
```

出现 `RESULT: PASS` 表示恢复路径、资源准入、队列推进和事件审计已经在同一条真实
应用编排链中闭环。

## 同源 Task Console 演示

无需模型服务即可演示用户界面、API Key、受管 Workspace、任务历史、调度和结果 API：

```bash
bun run demo:console
```

终端会打印本地地址和仅用于演示的 API Key。浏览器打开地址后，先填入 Key，创建
Workspace，再提交任务即可看到 Run 终态和持久化输出。该命令明确使用 Fake Runtime：它
证明的是产品/API/控制面纵向链路，**不**证明 Docker 隔离、真实模型兼容性或性能；按
`Ctrl+C` 会关闭服务并删除临时数据。

## Docker/gVisor Sandbox 真机 Smoke

在已启动 Docker daemon 的非 root Linux/Mac 用户环境执行：

```bash
bun run smoke:container
bun run smoke:container:attacks
```

前者通过当前 `HARNESS_SANDBOX_RUNTIME`（容器默认是 `runsc`）拉起一个真实容器，并验证
非 root UID、仅挂载 Workspace 的写入、只读 RootFS 和默认无网络；Provider 还会通过
`docker inspect` 记录实际 runtime。无论成功或失败都会清理容器和临时目录。当前开发机若
没有 Docker daemon 或 gVisor/runsc，这些命令应失败而不是把 fake unit test 当作真机证据。
`smoke:container:attacks` 额外覆盖两个 Tenant 的 Workspace/Secret/路径、默认无网络、PID/
临时文件资源上限和意外 kill → LOST；它的 PASS 输出必须在 Linux Docker + runsc 上保存。

## 启动完整 Harness

先根据实际 vLLM 服务修改 `.env.example` 中的值，并将其导入当前 shell；Bun 不会
自动读取 `.env.example`：

```bash
set -a
source .env.example
set +a
bun run start
```

另一个终端可验证进程和 HTTP 纵向切片：

```bash
curl -sS http://127.0.0.1:3000/health
bun run smoke:http
```

`smoke:http` 会提交固定任务、轮询到终态，再打印策略决策和事件时间线。完整 API
包括 `POST /runs`、Run 查询/事件、中断/恢复、队列、资源和健康检查共 8 个端点。

## 快速开始：Pi Spike

### 1. 安装依赖

```bash
bun install
```

### 2. 配置本地 vLLM

Pi 的本地模型配置放在 `.pi/spike/models.json`，该目录已被 Git 忽略。需要填入正在运行的 vLLM OpenAI-compatible `/v1` 地址和实际模型 ID。

在运行前检查模型服务：

```bash
curl -sS http://<vllm-host>:<port>/v1/models
```

### 3. 运行只读工具实验

```bash
VLLM_MODEL_ID="<模型ID>" bun run src/spikes/pi-vllm-tool.ts
```

成功时必须同时看到 `tool_execution_start`、`tool_execution_end`、最终回答和 `agent_end`。这证明 Pi 真正完成了“模型 → read 工具 → 模型”的循环，而非只输出文本。

## 开发与测试

旧原型测试已经随旧实现删除。新的测试集已经从 Fake Runtime 合同测试开始建立；根项目测试限定在顶层 `tests/`：

```bash
bun run test
bun run typecheck
```

不要在仓库根目录使用裸 `bun test` 作为 Harness 验收命令：Bun 会递归发现同仓库中
独立演示项目的测试。`bun run test` 明确限定在顶层 `tests/`。

Stage 0 的本地统一验收入口会依次运行 Harness 测试、严格 TypeScript 检查和
Day 7 Fake 闭环：

```bash
bun run verify:stage0
```

真实 vLLM 和 GPU 只用于集成验证。单元测试和组件测试应使用 Fake Runtime、Fake ResourceObserver 与临时 SQLite 数据库，保持可重复执行。

## 目录说明

```text
src/
├── app/          # HarnessApplication、配置与 Composition Root
├── demo/         # 不依赖 GPU 的 Day 7 固定恢复演示
├── http/         # 最小 HTTP API 与 Bun Server
├── spikes/       # Pi + vLLM + read 工具真实模型实验
├── runtime/      # AgentRuntime 接口、PiAdapter 与 Pi ToolGateway 包装
├── runs/         # AgentRun 状态机、RunStore、RunService
├── events/       # RuntimeEventBridge 与 RunEvent 时间线
├── tools/        # ToolGateway、ToolExecution 与持久化 Store
├── checkpoints/  # Checkpoint、恢复决策、扫描与执行
├── control-plane/# 旧 API 到默认 Pi Template/Instance/Session 的兼容入口
├── instances/    # HarnessInstance 领域状态与持久化
├── sessions/     # HarnessSession 与 Runtime Session 引用
├── templates/    # HarnessTemplate 与不可变版本
├── policies/     # 五层有效策略、编译记录与 Tool 前置守卫
├── sandbox/      # 可替换 Sandbox Provider、生命周期与 Secret 边界
├── scheduling/   # 资源准入后的队列、slot 与最小 Tenant 公平性
├── resources/    # 真实/Fake GPU 观测、分类与 ExecutionPolicy
└── storage/      # SQLite 打开器、migration 与 schema

scripts/          # HTTP smoke 等可执行验收入口
tests/            # 单元、组件、应用、HTTP 与端到端集成测试
docs/adr/         # 架构决策记录
```

### 旧原型的状态

自研 `AgentLoop`、内存 `ContextManager`、直接调用 vLLM 的 `LLMClient`、Output Validator、旧 System Prompt 以及 `src/kv/*` 实验代码已于 2026-07-22 删除。新的源码入口只导出 Harness 自己的 Runtime 抽象；具体 Agent Loop 由 Pi 提供。

删除理由和影响见 [ADR 0002](docs/adr/0002-remove-legacy-agent-prototype.md)。Git 历史仍可用于回顾旧实现，但它们不再参与构建、测试或后续开发。

## 文档导航

- [多租户 Agent 任务服务路线图](docs/multi-tenant-agent-task-service-roadmap.zh-CN.md)：当前唯一产品实施入口，覆盖身份、Workspace、真实 Sandbox、编排恢复与用户结果闭环。
- [Agent Infra 面试演示 Runbook](docs/interview-demo-runbook.zh-CN.md)：三分钟演示、代码锚点、追问速答与诚实边界。
- [历史秋招面试项目路线图](docs/interview-project-roadmap.zh-CN.md)：保留 A6000、故障演示和 Benchmark 等证据设计，不再定义产品形态。
- [历史异构 Harness 控制面路线图](docs/heterogeneous-harness-control-plane-roadmap.zh-CN.md)：已暂停，仅保留为秋招后的演进参考。
- [Stage 0 MVP 基线与核心契约](docs/stage0-mvp-baseline.zh-CN.md)：记录进入 Stage 1 前不可破坏的 schema、状态、恢复、资源和调度语义。
- [Stage 1–2 控制面实现与学习笔记](docs/stage1-stage2-control-plane-learning-notes.zh-CN.md)：按真实调用链讲解 Instance、Attempt、Capability、有效策略、ToolGateway、Sandbox 与 Secret 边界。
- [Stage 1–2 控制面源码精读指南](docs/stage1-stage2-code-reading-guide.zh-CN.md)：严格按 Capability → Instance → Attempt → 兼容控制面 → Policy → 编排器 → Tool → Sandbox → PiAdapter → 端到端测试的顺序，逐段解释关键代码、连接关系和不变量。
- [完整项目细节课程](docs/complete-project-detail-course.zh-CN.md)：从系统语言、进程启动和 Stage 0 可靠执行底座开始，以一个 Run 贯穿 HTTP、SQLite、资源准入、公平队列、工具副作用、恢复、Stage 1–2 控制面、Pi 和 Sandbox；包含逐方法推演、事务/竞态分析、失败矩阵、测试地图、调试课和自测题。
- [一周 MVP 实施手册](ONE_WEEK_HARNESS_MVP_GUIDE.zh-CN.md)：已完成 MVP 的学习、设计和验收记录，不再承载后续路线。
- [当前完整 Harness 系统剖面与技术审视](docs/current-harness-system-review.zh-CN.html)：交互讲解现有模块、正常/阻塞/恢复/副作用流程，以及走向多租户 Agent 任务服务仍需补齐的产品能力。
- [Agent 系统三层全景](docs/agent-system-three-plane-atlas.zh-CN.html)：对比 DeepResearch 行为系统、多租户 Agent 任务服务与 Polar Learning Plane，说明三类项目各自的用户价值、内部技术重点和跨层契约。
- [多租户 Agent 任务服务技术架构图谱](docs/multi-tenant-agent-harness-atlas.zh-CN.html)：对比 Codex Cloud、GitHub Copilot Cloud Agent、OpenHands Agent Server、AWS AgentCore、Microsoft Foundry 与本项目，重点拆解用户任务、Tenant、Workspace、隔离环境、恢复、公平队列和模型资源层。
- [真实 Agent Harness 架构图谱](docs/real-agent-harness-architecture-atlas.zh-CN.html)：以 Claude Code、Hermes Agent、Codex CLI、Gemini CLI、OpenCode、OpenHands 与 Pi 为主角，交互拆解完整 Harness 的执行链路、责任边界和架构取舍，并与 SDK、模型、持久化底座明确分层。
- [Agent Harness 工程地图：从系统思维到底层机制](docs/agent-harness-engineering-foundations.zh-CN.html)：抛开具体项目，从软件工程承诺与 Agent 系统全景，逐层拆到生命周期、事件、队列和状态机，并对比 OpenAI Agents SDK、LangGraph、Google ADK、Microsoft Agent Framework、Temporal、OpenHands、Letta 与 Anthropic Managed Agents 的真实架构。
- [工程基础交互讲解](docs/harness-foundations-interactive.zh-CN.html)：从 Command、Fact、State、Policy、Runtime Adapter 等根概念理解 Harness 为什么需要这些层。
- [交互式架构讲解](docs/harness-architecture-explainer.zh-CN.html)：从一次用户任务理解 HarnessSession、AgentRun、PiAgentSession、PiAdapter 与资源策略的边界。
- [ADR 0001：使用 Pi 作为 Agent Runtime](docs/adr/0001-use-pi-as-agent-runtime.md)：为什么不继续扩展自研 Agent Loop。
- [ADR 0002：删除旧自研 Agent 原型](docs/adr/0002-remove-legacy-agent-prototype.md)：为什么旧实现不再与 Pi 主路径并存。
- [ADR 0003：受硬约束保护的 Agentic 资源调度](docs/adr/0003-guarded-agentic-resource-scheduling.md)：为什么先建立确定性基线，再让 Scheduling Agent 在 Guardrails 内参与调度。
- [ADR 0004：将多租户作为一等控制面边界](docs/adr/0004-multi-tenancy-as-first-class-boundary.md)：为什么 Tenant 必须贯穿身份、数据、工具、资源、公平性与审计，而不是后加字段。
- [ADR 0005：采用可替换模型与可扩展 vLLM 推理层](docs/adr/0005-use-replaceable-models-and-extensible-vllm.md)：为什么使用 A6000 + Qwen3.5-4B/9B 双层验证，并把 vLLM 源码改造分级推进。
- [ADR 0006：收紧 MVP 到安全恢复与资源准入](docs/adr/0006-narrow-mvp-to-recovery-and-resource-admission.md)：记录 Day 1–7 为什么先以两个 Tenant 验证公平性，并用真实闭环与基线指标定义完成标准。
- [ADR 0007：异构 Harness 控制面历史方案](docs/adr/0007-evolve-to-heterogeneous-harness-control-plane.md)：保留 Template、Instance、Capability 等设计来源，但不再是当前路线。
- [ADR 0008：收敛为单机多租户面试项目（已取代）](docs/adr/0008-focus-on-single-node-multi-tenant-interview-project.md)：保留其“多租户、暂停异构”的历史决策，不再定义当前产品。
- [ADR 0009：构建多租户 Agent 任务服务](docs/adr/0009-build-a-multi-tenant-agent-task-service.md)：当前产品定义、③④层技术边界与完成标准。
- [Day 7 A6000 对照实验手册](docs/day7-a6000-baseline-runbook.zh-CN.md)：在真实 Pi/vLLM 服务器上复现实验并填写结果，不把 Fake 结果误写成性能结论。
- [Agent–Inference 联合调度研究规划](docs/harness-implementation-plan.zh-CN.md)：早期架构背景与候选研究材料，不覆盖 ADR 0009 和当前产品路线图的优先级。
- [Agentic RL 规划](docs/agentic-rl-project-plan.zh-CN.md)：独立研究方向，不属于当前 Harness MVP。

## 学习协作约定

本项目按“先理解边界 → 自己实现 → 测试证明 → 复盘”的顺序推进。每个阶段通过验收前，不提前堆叠下一阶段功能；遇到问题时记录期望状态、实际状态和事件序列。
