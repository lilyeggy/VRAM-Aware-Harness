# ADR 0007：演进为异构 Agent Harness 的可靠执行与策略控制面

## 状态

已被 ADR 0009 取代为当前实施方向；保留为秋招后的历史演进方案

> 2026-08-12 更新：项目当前目标是支持团队共享本地模型的多租户 Agent 任务服务。
> Claude、异构 ResourcePool 和大型控制面不进入当前主线。已完成的 Template、
> Instance、Capability、Policy 和 Sandbox 抽象保留为产品内部底座，不因路线收敛
> 而删除。当前决策见
> [ADR 0009](0009-build-a-multi-tenant-agent-task-service.md)。ADR 0008 是两次决策
> 之间的历史中间方案。

## 日期

2026-08-05

## 背景

Day 1–7 已经完成单进程、SQLite 形态的可靠执行纵向切片：可替换
`AgentRuntime`、Pi Adapter、AgentRun 状态机、追加式事件、ToolGateway、工具
副作用、Checkpoint、安全恢复、真实资源观测、准入策略、Tenant 公平队列、slot
生命周期、应用组装与 HTTP API。

这条切片证明了 Harness 可以在 Agent Runtime 外层建立可靠执行边界，但如果后续
只继续增加 GPU 阈值、队列规则或普通租户管理功能，项目容易分别退化成资源监控
脚本或多租户后台。另一方面，Pi、Claude Agent SDK/Claude Code 等 Harness 在
Session、工具、权限、Sandbox、事件和恢复能力上存在真实差异，不能用一个最低
公共接口假装它们具有完全相同的语义。

因此需要固定 MVP 后的产品定位和实施边界，同时保证现有代码成为新方向的第一条
纵向切片，而不是被推翻重写。

## 决策

项目的规范定位调整为：

> **面向异构 Agent Harness 的资源感知、可恢复执行控制面：在多租户共享环境中，
> 以版本化模板管理 Harness 执行环境，把平台与租户策略落实到 Runtime、工具网关
> 和 Sandbox，并依据不同资源池控制执行，在故障后按可证明的安全边界恢复，最终
> 形成统一但不丢失 Runtime 原始证据的审计时间线。**

项目主叙事是“异构 Harness 的可靠执行与策略控制”，多租户是必须面对的运行
环境和隔离边界，但不是独立的 SaaS 卖点。副作用感知恢复、真实资源准入和可审计
仍是长期核心，不因增加多 Harness 管理而降级。

### 1. 固定控制面对象

后续统一使用以下对象层次：

```text
Tenant
  ├── HarnessTemplate
  │     ├── Runtime 类型与版本
  │     ├── Model、Tool、Skill 配置
  │     ├── Sandbox 与资源配置
  │     └── RecoveryPolicy
  └── HarnessInstance
        ├── Session
        │     └── Run
        │           └── Attempt
        └── RuntimeCapabilityProfile
```

- `HarnessTemplate` 是版本化的期望配置，不是可变配置行；已经开始的 Run 必须能
  追溯到准确模板版本。
- `HarnessInstance` 是控制面管理的执行环境，绑定 Tenant、模板版本、Runtime、
  Sandbox、有效策略和资源池。它可以是临时容器、子进程、远程执行环境或可复用
  warm instance，不等于永久进程，也不等于 Session。
- `Session` 保存 Runtime 可表达的对话关系；`Run` 是一次受控制的用户任务；
  `Attempt` 是 Run 的一次实际启动或恢复执行。
- 一个 Tenant 可以拥有多个 Template、Instance 和 Session。控制面不假定
  “一个 Tenant 等于一个常驻 Harness 进程”。

### 2. 显式适配不同 Harness

采用逐个 Harness Adapter 的 Provider/Driver 模式。每个 Adapter 必须承担三类职责：

1. **Runtime Driver**：创建、恢复、中断和终止执行，接收生命周期、模型和工具事件；
2. **Capability Reporter**：声明 Session、恢复、工具拦截、权限、Sandbox、usage
   和事件完整度等真实能力；
3. **Policy Compiler**：把控制面策略翻译成该 Runtime 的原生配置和 hook。

控制面统一对象、策略意图、执行保证和审计格式，但不统一 Runtime 内部实现，也不
用最低公共能力掩盖差异。第一阶段只验证两个差异足够大的 Runtime：

- Pi + 自托管 vLLM；
- Claude Agent SDK/Claude Code。

在双 Runtime 形成完整纵向切片前，不扩张到更多 Adapter。

### 3. 使用能力模型表达真实保证

能力不能压缩成单个 `supportsResume`。至少分别描述：

- 生命周期与强制中断；
- Session 新建、恢复、fork 与跨主机恢复；
- 对话历史恢复；
- Workspace 保存与恢复；
- 工具调用拦截和结果复用；
- 外部副作用判断；
- 原生权限、Hook 和 Sandbox；
- 模型、token、费用和事件观测。

当能力缺失时遵守以下规则：

- 安全、权限或 Tenant 隔离无法落实：拒绝创建或执行；
- 用户请求的恢复保证无法满足：拒绝该保证，或进入明确的人工恢复状态；
- 非关键观测能力缺失：允许显式降级，并记录审计完整度；
- 调度优化信号缺失：使用保守的确定性策略；
- 原生 Sandbox 不足：由控制面外部 Sandbox 补足。

禁止静默降级。

### 4. 编译并强制执行有效策略

每次 Run 使用不可变的有效策略快照：

```text
平台硬策略
  ∩ Tenant 策略
  ∩ HarnessTemplate 策略
  ∩ Workspace 策略
  ∩ Run 临时策略
  = EffectivePolicySnapshot
```

策略需要分别落实到 Runtime 原生权限、ToolGateway 和外部 Sandbox。数据库中
存在配置但执行路径没有强制检查，不算策略能力完成。安全策略采用 fail closed；
策略版本、编译结果、降级和拒绝原因都必须进入审计时间线。

### 5. 将 Sandbox 作为外部一等边界

Sandbox 生命周期由控制面管理，不依赖每个 Runtime 都提供同等强度的原生隔离。
它至少承载 Workspace、文件范围、网络、进程、Secret 注入以及 CPU/内存/磁盘
限制。具体使用 Docker、Firecracker 或 Kubernetes 属于后续实现选择，本 ADR 不
提前绑定底层技术，但要求 Sandbox Provider 可替换并接受能力声明。

### 6. 分层定义恢复

恢复至少区分：

1. 对话恢复；
2. Workspace 恢复；
3. Run/Attempt 恢复；
4. 工具结果和外部副作用恢复。

Runtime 原生 resume 只能证明其支持的那一层，不能替代 ToolExecution、Checkpoint、
幂等键和 RecoveryDecision。控制面根据 Capability、Checkpoint、Workspace 状态和
副作用事实给出 `AUTO_RESUME`、`RETRY_FROM_BOUNDARY`、`REQUIRE_REVIEW` 或
`UNRECOVERABLE` 等可解释结果；具体枚举可以在实现阶段收敛，但不得重新退化为
“失败后一律重跑”。

### 7. 将资源扩展为异构 ResourcePool

VRAM 仍是重要且已实现的第一个资源事实，但不再是唯一资源模型。后续资源池包括：

- 本地 vLLM 的 GPU、KV、并发容量和模型服务状态；
- 远程模型的 token、速率、并发和费用预算；
- Sandbox 的 CPU、内存、磁盘和实例容量；
- Tool/API 的并发、速率和租户配额。

资源策略继续满足同一条要求：资源事实必须真实改变准入、排队或执行预算；资源
恢复后系统必须自动推进，而不是只展示监控数字。现有 ResourceObserver、Policy、
TenantFairQueue、slot 和 drain 成为第一个 ResourcePool 实现基础。

### 8. 建立统一且可追溯的审计

不同 Runtime 最终形成同一条控制面时间线：

```text
Template 版本 → Effective Policy → Instance 生命周期 → Run 准入
→ Runtime 事件 → Tool 与副作用 → ResourceSnapshot → 恢复决定 → 结果
```

统一事件不能覆盖掉 Runtime 特有信息。Adapter 必须保留必要的原始事件或原始证据
引用，并标注映射版本与审计完整度。

## 非目标

- 自研 Agent Loop、Memory、Prompt 或 Context 框架；
- 让所有 Harness 获得完全相同的 Session、恢复或 Sandbox 语义；
- 在双 Runtime 纵向切片完成前适配大量 Harness；
- 优先建设计费、组织管理、复杂 UI 或通用企业后台；
- 替代容器编排系统、vLLM Scheduler 或远程模型 Provider 的限流器；
- 对用户声明的输出 token 数作无法校准的任务完成保证；
- 在没有真实基线时把 Scheduling Agent、KV Residency 或深度 vLLM 修改设为主线。

## 与既有决策的关系

- ADR 0001 仍成立：Pi 是第一个 Runtime，但不再是唯一目标 Runtime；
- ADR 0004 仍成立：Tenant 是归属、权限、资源和审计边界；
- ADR 0006 仍定义 Day 1–7 MVP 的完成标准；本 ADR 定义 MVP 后的长期产品方向；
- ADR 0003、0005 中的 Agentic Scheduling 和 vLLM 深度扩展降为数据驱动的候选
  研究支线，不再主导下一阶段实施顺序。

## 后果

好处：

- 现有 MVP 可直接成为 Pi Runtime、可靠执行和 GPU ResourcePool 的第一条切片；
- 项目深度来自异构能力、策略落实、生命周期、恢复语义和故障实验，而不是 CRUD；
- 两个差异明显的 Runtime 足以验证抽象是否真实；
- 资源感知与副作用恢复继续形成区别于普通 Harness 配置平台的核心能力。

代价：

- Adapter 必须维护 Runtime 版本兼容性和能力差异；
- 统一控制面事件与 Runtime 原始证据需要双层保存；
- 安全策略 fail closed 会拒绝部分无法提供足够 hook 的 Runtime 配置；
- Instance、Sandbox 和跨主机恢复会把项目从单进程 MVP 推向分布式系统问题。

## 实施入口

本文对应的历史产品深化方案见
[`heterogeneous-harness-control-plane-roadmap.zh-CN.md`](../heterogeneous-harness-control-plane-roadmap.zh-CN.md)。
当前唯一实施入口已改为
[`multi-tenant-agent-task-service-roadmap.zh-CN.md`](../multi-tenant-agent-task-service-roadmap.zh-CN.md)。
