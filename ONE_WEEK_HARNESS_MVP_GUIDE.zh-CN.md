# Resource-Aware Agent Harness：一周 MVP 学习与实施手册

> 文档版本：v1.3
> 实施周期：7 天，每天约 6 小时  
> 目标读者：理解 Agent 基础，但希望系统掌握 Harness、后端与资源感知的开发者  
> 实施原则：你主写、我指导；每个阶段先理解边界，再实现，再用测试证明
>
> **状态更新（2026-08-12）**：Day 1–7 本地工程闭环已经完成。本文冻结为 MVP
> 的学习、设计与验收记录，不再作为后续实现入口。当前统一按照
> [`docs/multi-tenant-agent-task-service-roadmap.zh-CN.md`](docs/multi-tenant-agent-task-service-roadmap.zh-CN.md)
> 推进，产品与技术边界见
> [`ADR 0009`](docs/adr/0009-build-a-multi-tenant-agent-task-service.md)。
>
> 推理基线更新（2026-07-30）：当前使用单卡 RTX A6000 48 GB；
> Qwen3.5-4B 用于日常开发，Qwen3.5-9B 用于主要集成验证。vLLM fork 可修改，
> 但 MVP 不依赖深度重写 Scheduler。见
> [`ADR 0005`](docs/adr/0005-use-replaceable-models-and-extensible-vllm.md)。

## 0. MVP 阶段的历史定位

本项目构建的是面向资源受限的自托管推理环境、兼具安全恢复与资源感知准入的
Agent Harness，不是另一套 Prompt、Memory、Agent Loop 或多租户管理后台。

Day 1–7 使用的阶段定义是：

> **VRAM-Aware Agent Harness 是一个面向资源受限的自托管推理环境、围绕
> 可替换 Agent Runtime 构建的可靠执行控制面：它持久化 Run 与工具副作用，
> 在安全边界恢复失败任务，并依据实时资源事实控制新执行的准入与背压。**

Pi 负责模型—工具循环、Session 历史和上下文压缩；Harness 负责模型能力不会
自动解决的确定性边界：

- Session、Run、ModelCall 与 ToolExecution 的身份和生命周期；
- 状态机、事件、事务、幂等、Checkpoint 与失败恢复；
- 工具副作用分类、结果复用和可自动重放边界；
- 共享 GPU 上的准入、并发 slot、排队、背压与资源恢复后的自动推进；
- usage、成本、资源快照、策略理由和执行结果的审计。

`tenantId` 已经从 Day 2 起进入 AgentRun，后续 Store、Service、Queue 和 Policy
继续保留 Tenant 上下文；但它是共享资源场景下的归属与公平性约束，不是本项目
需要扩张的产品主线。Day 6 用两个 Tenant 证明 slot 不会被单一提交方持续抢占，
不建设认证、计费或企业租户管理能力。

第一周只承诺逻辑隔离与公平性语义，不承诺完整认证、RBAC、网络隔离或容器级
Workspace 安全。多租户边界的完整决策见
[`ADR 0004`](docs/adr/0004-multi-tenancy-as-first-class-boundary.md)。

“不做 Agent 行为框架”不等于提示、上下文和长期行为可靠性已经解决，而是明确
工程所有权：这些能力优先交给模型和可替换 Runtime；Harness 只持有执行控制所
必需的上下文版本、权限、成本和恢复事实。

这份手册的范围必须按三个层级理解：

1. **MVP 的核心能力**：副作用感知的安全恢复、资源感知的准入/背压、可审计与可观测；这些能力在新方向中继续保留。
2. **第一周 MVP**：单进程 + SQLite 的纵向切片，验证恢复边界、确定性准入、
   slot 生命周期、自动续跑和最小公平性。
3. **当前正式方向**：面向团队共享本地模型的多租户 Agent 任务服务；优先补齐
   可信身份、Tenant Workspace、真实 Sandbox、编排恢复和用户结果闭环，A6000
   实验与隔离攻击测试提供可信证据，异构 Runtime 与深度调度暂停。

系统可以在本地只配置一个 Tenant；共享部署时保持 **tenant-aware by design**，
不能让隐式“当前用户”进入领域模型、存储访问和 slot 计算。

## 1. 一周后要交付什么

这一周不交付完整的企业级平台，而是交付一条能够证明项目核心价值的纵向切片：

```text
用户提交任务
    ↓
Harness 创建 AgentRun
    ↓
ExecutionPolicy 判断启动或排队
    ↓
PiAdapter 驱动 Pi Agent Runtime
    ↓
模型请求发往自托管 vLLM
    ↓
工具调用统一经过 ToolGateway
    ↓
RunEvent、ToolExecution 与 Checkpoint 持久化
    ↓
任务完成，或者在安全边界上恢复
```

最终演示必须同时证明六件事：

1. Pi 已经替代仓库里自研的 Agent Loop，Harness 不再重复维护模型—工具循环。
2. 每次执行都有独立、可查询、可恢复的 `AgentRun`。
3. 模型调用、工具调用和状态变化都可以通过事件还原。
4. 进程重启后，至少能从一个安全 Checkpoint 继续任务。
5. GPU 资源压力能够令新 Run 排队，压力解除后系统无需用户操作即可继续，并留下可解释的策略记录。
6. 两个 Tenant 共享受限 slot 时不会因全局 FIFO 或单一大户而永久饥饿。

如果这六点成立，我们得到的就不是聊天 API 包装器，也不是显存监控脚本，而是一个真正的 Resource-Aware Agent Harness 原型。

本周所有实现都应服务于同一个验证问题：

> 在不修改 Pi、且不依赖深度重写 vLLM Scheduler 的情况下，Harness 能否依据
> Run 状态、工具副作用和真实资源事实，安全地控制新任务启动，并在故障或资源
> 压力解除后自动、可解释地继续执行？

无法帮助回答这个问题的功能不进入本周关键路径。

## 2. 本周如何学习，而不只是赶代码

每天六小时建议按以下节奏分配：

| 时间 | 内容 | 目的 |
| --- | --- | --- |
| 45 分钟 | 阅读当天概念与相关接口 | 先理解对象和边界 |
| 3 小时 30 分钟 | 亲手实现主任务 | 建立真实工程感觉 |
| 1 小时 | 写测试、故障注入和验收 | 用证据代替“看起来能跑” |
| 45 分钟 | 复盘、记录问题、接受代码审查 | 把实现转化为自己的知识 |

我们的协作约定：

- 每个检查点先讲清核心逻辑，再由你判断这一小步是你实现还是我实现；未经确认不跨到下一步。
- 遇到问题时，先描述“期望状态、实际状态、事件序列”，不要只贴最后一条报错。
- 我不会默认替你把整个模块写完；如果某个概念卡住，我会先用最小例子讲清楚。
- 每天必须通过验收门槛后再进入下一天，避免在不稳定地基上堆功能。
- 每天结束写一段 5～10 行的工程日志：做了什么、为什么这样设计、还有什么不确定。

## 3. 当前仓库的真实起点

> 2026-07-22 更新：完成 Pi Spike 并确认新边界后，旧自研 Agent 原型及其测试已经删除。以下列表保留为项目迁移前的历史起点；当前源码以 `src/runtime/` 和 `src/spikes/` 为准。

当前根项目已经有以下原型能力：

- OpenAI-compatible `LLMClient`；
- 自研的模型—工具 `AgentLoop`；
- 内存中的 `ContextManager`；
- 工具注册、超时和简单结果缓存；
- 初步的 Turn importance 与 KV lifecycle 实验；
- Harness 核心模块的单元测试。

但它还不是目标中的 Harness：

| 当前情况 | 一周 MVP 的处理 |
| --- | --- |
| 自研 Agent Loop | 已删除，由 PiAdapter 取代 |
| Session 存在内存 Map | 已删除；已引入 SQLite 持久化 AgentRun 与事件 |
| LLMClient 直接调用 vLLM | 已删除；Agent 主路径交给 Pi |
| ContextManager 自行压缩 | 已删除；本周交给 Pi，Harness 只记录 Context 元数据 |
| `src/kv/*` 主动设计驱逐 | 已删除，不进入 MVP 主路径 |
| 没有 ToolExecution | 新增 ToolGateway 和独立执行记录 |
| 没有 Checkpoint/Recovery | 新增安全边界与恢复规则 |
| 没有资源观测 | 新增真实和 Fake ResourceObserver |
| 没有多用户调度 | 新增单进程公平队列 |

旧实现已从工作树删除，Git 历史继续保留其演进过程。后续不再维护两套 Agent Loop。

根目录测试命令限定在 Harness 自己的 `tests/`，让测试范围保持明确。

## 4. 一周范围

### 4.1 必须实现

- Pi SDK 嵌入与 vLLM 接入；
- AgentRun 生命周期；
- RunEvent 追加式事件记录；
- ToolGateway 与 ToolExecution；
- SQLite 持久化；
- Checkpoint 与安全恢复；
- GPU ResourceObserver；
- Fake ResourceObserver；
- NORMAL / BUSY / CRITICAL 三档策略；
- 全局与单用户并发限制；
- 最小 HTTP API 或 CLI；
- 集成演示和故障测试。

### 4.2 明确不做

- 修改 vLLM Scheduler；
- 直接驱逐或迁移物理 KV Block；
- KV Offload；
- 复杂热/温/冷 Turn 评分；
- 动态删除上下文；
- PostgreSQL、Redis、Kafka；
- 多进程和分布式 Worker；
- 完整登录、RBAC 和企业管理后台；
- 容器级 Workspace 隔离；
- Fork Pi；
- 完整服务 20 人的生产承诺。

这些不是永远不做，而是不能进入第一周的关键路径。

## 5. MVP 的系统边界

### 5.1 Pi 负责什么

- Agent Loop；
- 模型输出的流式处理；
- 工具调用协议；
- AgentSession；
- Pi 自己的 Session 历史和 Compaction；
- 模型与 Provider 适配。

### 5.2 Harness 负责什么

- Tenant、Session 与 AgentRun 的路由；
- Run 生命周期与状态机；
- 事件持久化；
- 工具执行治理；
- Checkpoint 与恢复；
- 并发、排队和公平性；
- 资源观测与 Execution Policy；
- 审计、指标与解释。

### 5.3 vLLM 负责什么

- 请求级推理调度；
- Prefill、Decode 和 batching；
- Prefix Cache 与 KV Cache；
- GPU 内存分配和推理执行；
- 提供 Metrics，并承载必要的请求归因和观测扩展点。

在资源控制这一层，Harness 可以根据资源状态决定“是否以及何时提交模型请求”，
但本周不接管 vLLM 内部的 token 调度和物理缓存管理。我们可以修改 vLLM fork
来增加 Tenant/Run/Trace 归因、Metrics 或实验性 hint；这些改动不能把 Run
生命周期、工具副作用、权限和恢复语义下沉到推理层。

## 6. 第一版技术选择

| 领域 | 选择 | 原因 |
| --- | --- | --- |
| 语言与运行时 | TypeScript + Bun | 与当前仓库一致，开发速度快 |
| Agent Runtime | Pi Coding Agent SDK | 复用成熟 Agent Loop、Session 和工具机制 |
| 模型服务 | 可修改的 vLLM fork + OpenAI-compatible API | 保持标准调用面，同时允许增加观测和请求归因 |
| 模型基线 | Qwen3.5-4B 开发，Qwen3.5-9B 主验证 | 缩短开发反馈，同时保留真实集成压力 |
| 硬件基线 | 单卡 RTX A6000 48 GB | 与实验室当前可用设备一致 |
| 持久化 | SQLite | 无额外服务，支持事务和进程重启 |
| API | Bun HTTP 或轻量框架 | 第一周只需要少量接口 |
| 资源观测 | vLLM Metrics/事件 + `nvidia-smi` 回退 + Fake | 优先使用请求级事实，同时保留设备级读数和确定性测试 |
| 调度 | 单进程内存队列 + 确定性策略基线 | 足以验证公平性、安全回退，并为后续 Agentic Policy 提供对照 |
| 测试 | Bun Test + Fake Runtime | 快速、可重复、避免依赖真实 GPU |

Pi 依赖必须固定精确版本，不能使用浮动的 `latest`。开始安装前需要再次确认当前官方包名、版本和 SDK 导出，记录到 ADR 中。

模型相关配置同样必须与 Harness 业务逻辑分离。当前 Qwen3.5 集成使用兼容的
vLLM 版本，并在部署配置中设置 `qwen3` reasoning parser、`qwen3_coder` tool
call parser 和自动工具选择。真实模型先使用 16K `max-model-len`，确有需要时再
提升到 32K。

## 7. 六个核心对象

### 7.1 AgentRun

`AgentRun` 表示一次从用户输入到终态的受控执行。它不是 Session，也不是单次模型请求。

最小字段：

```text
id
tenantId
sessionId
status
userInput
workspacePath
createdAt
updatedAt
startedAt
finishedAt
checkpointId
failureReason
```

最小状态机：

```text
QUEUED → RUNNING → COMPLETED
             ├──→ WAITING_TOOL → RUNNING
             ├──→ INTERRUPTED → QUEUED
             └──→ FAILED
```

本周不要为了覆盖所有未来情况扩展十几种状态。

### 7.2 RunEvent

`RunEvent` 是追加式事实记录。Run 表保存当前状态，Event 表保存它为什么变成这个状态。

首批事件类型：

```text
RUN_CREATED
RUN_QUEUED
RUN_STARTED
MODEL_STARTED
MODEL_COMPLETED
TOOL_REQUESTED
TOOL_STARTED
TOOL_COMPLETED
TOOL_FAILED
CHECKPOINT_SAVED
RUN_INTERRUPTED
RUN_COMPLETED
RUN_FAILED
```

最小字段：

```text
eventId
runId
sequence
type
timestamp
payload
```

同一 Run 的 `sequence` 必须单调递增。

### 7.3 ToolExecution

一次工具调用必须成为独立对象，不能只把结果塞回消息历史。

```text
id
runId
toolCallId
toolName
arguments
effectClass
status
result
error
startedAt
finishedAt
```

第一版副作用分类：

- `READ_ONLY`：可以安全重试；
- `IDEMPOTENT_WRITE`：在幂等键成立时可以重试；
- `NON_IDEMPOTENT`：默认不自动重试。

如果进程在不可逆工具执行期间崩溃，重启后状态必须是 `UNKNOWN_EFFECT`，不能假装工具没有执行。

### 7.4 Checkpoint

Checkpoint 不是完整进程内存快照，而是“下一次可以安全继续所需的持久信息”。

第一版保存：

```text
checkpointId
runId
piSessionId / Pi session reference
lastEventSequence
lastCompletedToolExecutionId
contextVersion
createdAt
```

安全保存点：

- 用户输入已持久化后；
- 模型响应完整结束后；
- 工具结果完整持久化后；
- Run 进入终态前。

### 7.5 ResourceSnapshot

```text
timestamp
totalVramMiB
usedVramMiB
freeVramMiB
gpuUtilization
activeRuns
queuedRuns
source
```

`source` 区分真实 NVIDIA 采集和 Fake 数据，防止测试结果与生产指标混淆。

### 7.6 PolicyDecision

策略不直接返回布尔值，而是记录一项可解释决策：

```text
decisionId
runId
action: START | QUEUE | REJECT
reasonCode
reasonText
resourceSnapshot
createdAt
```

未来即使策略变复杂，这个接口也不需要推翻。

## 8. 建议目录

```text
src/
├── runs/
│   ├── run-model.ts
│   ├── run-store.ts
│   └── run-service.ts
├── runtime/
│   ├── agent-runtime.ts
│   └── pi-adapter.ts
├── events/
│   └── pi-event-bridge.ts
├── tools/
│   ├── tool-gateway.ts
│   └── tool-model.ts
├── checkpoints/
│   └── checkpoint-service.ts
├── policy/
│   ├── execution-policy.ts
│   └── run-queue.ts
├── resources/
│   ├── resource-observer.ts
│   ├── nvidia-resource-observer.ts
│   └── fake-resource-observer.ts
├── storage/
│   ├── database.ts
│   └── schema.ts
├── api/
│   └── server.ts
└── demo/
    └── scenario.ts
```

接口和实现分开，是为了让测试可以注入 Fake Pi Runtime 和 Fake ResourceObserver。

## 9. 七天实施计划

## Day 1：让 Pi 成为可替换的 Agent Runtime

### 今天真正要理解的概念

- Agent Loop 与 Harness 的边界；
- Pi AgentSession 与我们 AgentRun 的区别；
- Adapter Pattern；
- 为什么业务层不能直接依赖 Pi 的所有类型。

### 编码任务

1. 建立一份 ADR，记录 Pi 包名、固定版本、选择 SDK 而不是 Fork 的理由。
2. 定义最小 `AgentRuntime` 接口。
3. 实现最薄的 `PiAdapter`。
4. 配置 Pi 连接现有 vLLM。
5. 注册一个只读工具，例如读取指定 Workspace 内的文件。
6. 跑通一次 `用户问题 → 模型 → 工具 → 模型 → 最终回答`。

### AgentRuntime 第一版只需要表达

```text
start(run, input)
resume(run, checkpoint)
interrupt(run)
subscribe(runId, handler)
```

具体参数类型由实现时确定，但不要让上层直接接收 Pi 内部事件类型。

### 验收门槛

- 能连接真实 vLLM；
- Pi 确实完成至少一次工具调用；
- 可以看到结构化事件，而不只是终端文本；
- 不重新引入自研 `AgentLoop`；
- 有一个不依赖真实模型的 Fake Runtime 测试。

### 当天必须回答

1. Pi Session 为什么不等于 AgentRun？
2. 如果未来更换 Agent Runtime，哪些代码应该保持不变？
3. 为什么第一天不先实现数据库？
4. Pi 事件中哪些是事实，哪些是展示层信息？

### 指导检查点

完成“Pi 能调用一个工具”后停止扩展，把接口和最小事件样例发给我审查。Day 1 不做队列、不做 GPU 监控。

## Day 2：建立 AgentRun 和持久化事实

### 今天真正要理解的概念

- 业务实体、状态与事件的区别；
- SQLite 事务；
- Append-only Event Log；
- 当前状态和历史事实为什么要同时保存。

### 编码任务

1. 建立 SQLite 数据库和 schema migration。
2. 创建 `agent_runs`、`run_events` 表。
3. 实现 `RunStore.create/get/update/appendEvent/listEvents`。
4. 确保更新 Run 状态与追加对应事件处于同一事务。
5. 用 Fake Runtime 跑一个完整 Run。

### 验收门槛

- 重启进程后 Run 仍然存在；
- RunEvent 顺序稳定；
- 同一个 Run 不会出现重复 sequence；
- 非法状态转换被拒绝；
- 可以从事件列表解释 Run 当前状态。

### 当天必须回答

1. 为什么不能只保存最终消息？
2. 为什么 Run 当前状态不能只靠每次扫描全部事件获得？
3. 哪些写入必须在同一事务中？
4. Event payload 如何做版本兼容？

## Day 3：把 Runtime 事件转换成可持久化 Harness 事件

当前代码已经由 `PiAdapter` 完成 `Pi AgentSessionEvent -> RuntimeEvent` 的适配。
因此 Day 3 不再新增一个直接依赖 Pi SDK 的持久化桥接层，而是实现
`RuntimeEventBridge`，负责 `RuntimeEvent -> RunEvent` 的业务筛选和转换。
这样未来替换 Agent Runtime 时，RunEvent、RunStore 和事件时间线仍然可以保留。

Day 3 只在模型调用事件缺失时对 `PiAdapter` 做小范围增量扩展，不重写
`PiAdapter`，也不让 `RunStore` 接触 Pi 原始事件。

### 今天真正要理解的概念

- Anti-corruption Layer；
- 外部事件与领域事件；
- 流式事件、完成事件和持久事件的差别；
- Runtime 生命周期事件与持久化业务事件的职责边界；
- At-least-once 事件下的去重。

### 编码任务

1. 实现 `RuntimeEventBridge`，输入可信的 `TenantRunContext + RuntimeEvent`，输出带 Tenant 归属的可持久化事件草稿或 `null`。
2. 建立 `Pi AgentSessionEvent -> RuntimeEvent -> RunEvent` 的显式映射表。
3. 将事件分成三类：RunService 已处理的生命周期事件、需要追加的业务事件、只用于流式展示的瞬时事件。
4. Token delta 可以流式展示，但 `RuntimeEventBridge` 必须返回 `null`，不要逐 token 写数据库。
5. 扩展模型调用开始/完成 RuntimeEvent，并记录模型、耗时、stop reason 和 usage。
6. 为持久事件建立稳定的去重键，并用 migration v2 和唯一约束阻止重复业务事件；追加前必须校验事件所属 Run 归当前 Tenant。
7. 将 Bridge 接入 RunService，但不得重复写入 `RUN_STARTED`、`RUN_COMPLETED`、`RUN_FAILED` 等生命周期事件。

### 验收门槛

- 一次 Run 的事件能够按时间线打印；
- 不会因为流式 token 产生数千条数据库事件；
- 模型完成事件包含耗时和 usage；
- 相同 Runtime/Pi 事件重复到达时不会制造重复业务事件；
- RunService 与 Bridge 不会重复写入同一个生命周期事实；
- Pi 或 Runtime 升级导致未知事件时，系统可以记录告警而不是崩溃。

### 当天必须回答

1. 为什么不能把 Pi 原始事件 JSON 直接当数据库模型？
2. 哪些事件需要持久化，哪些只适合前端流式展示？
3. 模型请求和 Agent Step 是不是同一个对象？

## Day 4：ToolGateway、Checkpoint 与恢复

> **完成记录（2026-07-28）**：Day 4 编码与组件级故障测试已完成。
> 当前 Harness 测试共 48 个通过。已实现 ToolExecution 持久化、Pi 工具统一
> 接入 ToolGateway、结果与 Checkpoint 原子提交、启动恢复扫描、
> RecoveryDecision、RecoveryExecutor 和 RunService.resume。真实进程终止后
> 连接 Pi/vLLM 的端到端恢复演示留到 Day 7。

### 今天真正要理解的概念

- 工具调用意图和工具执行事实的区别；
- 幂等性；
- Exactly-once 为什么通常做不到；
- 安全恢复边界。

### 编码任务

1. 建立 `tool_executions` 与 `checkpoints` 表。
2. 所有工具统一经过 `ToolGateway`。
3. 在执行前保存 ToolExecution。
4. 在结果完成后原子地保存结果和 Checkpoint。
5. 实现启动时的中断 Run 扫描。
6. 对 `UNKNOWN_EFFECT` 工具禁止自动重放。

### 故障注入

- 模型请求前退出；
- 工具开始前退出；
- 工具完成后、结果回传 Pi 前退出；
- 工具执行过程中退出。

### 验收门槛

- 只读工具可以自动恢复；
- 已持久化结果的工具不会重复执行；
- 不确定副作用的工具需要人工处理或失败终止；
- 恢复后事件序列仍连续。

### 当天必须回答

1. Checkpoint 为什么不是内存 dump？
2. 工具结果已经写入数据库但 Pi 没收到时应该怎么办？
3. 什么情况下允许自动重放工具？
4. `UNKNOWN_EFFECT` 为什么是必要状态？

## Day 5：资源观测与 Execution Policy

### 今天真正要理解的概念

- Observation 与 Decision 分离；
- Admission Control；
- Harness 调度和 vLLM 调度的边界；
- 为什么资源压力不能破坏 Agent 正确性。

### 编码任务

1. 定义 `ResourceObserver` 接口。
2. 实现 Fake ResourceObserver。
3. 实现 vLLM Metrics 观测器，并以 `nvidia-smi` 作为设备级回退。
4. 将资源状态归一为 `NORMAL / BUSY / CRITICAL`。
5. 实现只作用于“新模型执行是否启动”的 ExecutionPolicy。
6. 保存 PolicyDecision。

### 第一版策略

```text
CRITICAL：不启动新 Run，活跃 Run 允许到安全边界
BUSY：执行单用户并发限制，其余排队
NORMAL：在全局并发上限内启动
```

阈值必须配置化。测试策略时使用 Fake Snapshot，不依赖机房 GPU 当前恰好处于某种状态。

这套规则是 **Deterministic Baseline**。第一周先用它证明观测、决策、持久化、
排队和恢复链路正确；完成真实基线后再由数据决定是否需要成本模型、SLO 或
Scheduling Agent。当前完成标准不包含 LLM 调度器。边界见
[`ADR 0006`](docs/adr/0006-narrow-mvp-to-recovery-and-resource-admission.md)。

### 验收门槛

- Fake CRITICAL 能稳定令 Run 排队；
- 切换回 NORMAL 后 Run 可以启动；
- 资源采集失败时不会被误判成资源充足；
- 每个决策都有 reasonCode 和 Snapshot；
- 不删除上下文、不驱逐 KV、不终止正在执行的工具。

### 当天必须回答

1. `nvidia-smi` 读数为什么只是策略输入，不是策略本身？
2. Harness 为什么不应该和 vLLM 同时调度 token？
3. 资源采集失败时应该 fail-open 还是 fail-closed？
4. 为什么不能在 CRITICAL 时直接杀掉所有 Run？

## Day 6：资源队列、slot 生命周期与最小公平性

Day 6 不需要连接服务器、真实 GPU 或真实 vLLM。队列、slot、资源状态切换和
RunService 编排全部先用 Fake Runtime、Fake ResourceObserver 与临时 SQLite
确定性验证；服务器只在 Day 7 的真实闭环与对照实验中使用。

### 完成状态（2026-08-05）

Day 6 已完成，并通过 55 项调度、准入和 RunService 相关确定性测试：

- `TenantRunScheduler` 实现 Tenant 内 FIFO、Tenant 间 round-robin，以及全局和
  单 Tenant 并发限制；
- `claimNext` 将选择 Run 与登记 slot 合并为同一个同步调度动作；
- `RunQueueCoordinator` 接通 Admission、RunService、slot 释放、single-flight
  drain、pending drain 和单 Run 故障隔离；
- `RunQueuePump` 定期重检等待队列，Fake 资源从 `CRITICAL` 切换到 `NORMAL`
  后，Run 无需重新提交或手动 drain 即可自动启动；
- `A1、A2、A3、B1` 在全局并发为 1 时的确定性顺序为
  `A1 -> B1 -> A2 -> A3`；Runtime 启动失败不会泄漏 slot，也不会阻塞后续 Run。

当前 MVP 将公平性主体定义为 Tenant，而不是 Session。slot 采用保守的 Run 级
语义：从 Run 启动到进入终态始终占用，包括工具执行期间。若未来只计算模型执行
阶段，则必须先增加运行阶段事件、slot 重新竞争和恢复预留机制，不能直接在工具
调用时释放。

### 今天真正要理解的概念

- slot 是准入时必须原子占用、终态时必须释放的执行资源；
- 全局并发和单 Tenant 并发；
- FIFO 的饥饿问题；
- Backpressure 与资源恢复后的自动推进。

### 编码任务

1. 保持所有 Run 携带 `tenantId`，但不新增租户管理功能。
2. 实现全局并发上限和单 Tenant 并发上限。
3. 实现简单 round-robin tenant queue。
4. `claimNext` 必须在选中 Run 的同时登记 slot，防止计划与占用分离后被其他 Run 抢占。
5. Run 完成、失败或中断时幂等释放 slot，并立即尝试推进下一项。
6. ResourceSnapshot 从 `CRITICAL/BUSY` 恢复后触发 drain，使排队 Run 无需用户再次操作即可启动。
7. 将队列和 `ExecutionPolicy` 接入 `RunService`，保存排队原因、准入决策和资源快照引用。
8. 增加查询队列位置、排队原因、活跃 slot 的接口。

### 验收场景

```text
Tenant A 提交 A1、A2、A3
Tenant B 提交 B1
全局并发为 1
```

期望 B1 不会永远排在 A 的所有任务之后。具体顺序由策略定义，但必须可解释、
可测试，并且 `claimNext` 返回 Run 时相应 slot 已经属于该 Run。

还必须验证资源闭环：`CRITICAL` 时新 Run 入队，状态切回 `NORMAL` 后自动 claim
并启动；若 Runtime 启动失败，slot 不得泄漏，队列仍可继续推进。

### 当天必须回答

1. Tenant 是公平性主体；Session 继续作为恢复和 Runtime 关联边界。
2. 全局 FIFO 会让单个 Tenant 的连续提交长期排在其他 Tenant 之前；Tenant
   round-robin 在保留 Tenant 内 FIFO 的同时避免这种饥饿。
3. 选中 Run 和占用 slot 必须是同一个调度动作，否则多个调度尝试可能同时看到
   空闲容量并超额启动。
4. 当前工具长时间执行仍占用 Run 级并发 slot；模型阶段 slot 拆分留待真实测量
   证明有必要后再设计。

## Day 7：集成、演示和复盘

> **本地完成记录（2026-08-05）**：Day 7 的确定性与本地进程闭环已完成。
> 当前源码已包含应用 Composition Root、配置加载、进程入口、优雅关闭、8 个 HTTP
> 端点、启动时队列重建、可恢复 Run 扫描、资源恢复自动续跑、Fake 固定演示和真实
> loopback HTTP smoke。恢复任务不会绕过调度器：它与新任务一样重新经过
> ExecutionPolicy 和 slot 占用，最终才调用 `Runtime.resume`。
> Harness 自身 153 项测试与严格 TypeScript 检查已经通过。
>
> 执行 `bun run demo:day7` 可直接查看 `CRITICAL -> NORMAL`、`start/resume`
> 分流、RunEvent 和 PolicyDecision 时间线；启动真实服务后执行
> `bun run smoke:http` 可验证 HTTP 纵向切片。A6000 + Pi/vLLM 的固定任务对照仍是
> 外部环境验收项，执行方法见
> `docs/day7-a6000-baseline-runbook.zh-CN.md`；在获得真实数据前不声明性能收益。

### 固定演示脚本

1. Tenant A 提交“分析当前项目测试结构”。
2. Tenant B 提交“总结 Harness 的架构边界”。
3. Fake 或真实资源状态从 NORMAL 切换到 CRITICAL。
4. 新 Run 进入队列，活跃 Run 继续到安全边界。
5. 在一次已完成工具调用后重启 Harness。
6. 系统读取 Checkpoint 并继续。
7. 资源恢复 NORMAL，排队 Run 启动。
8. 最后打印每个 Run 的事件时间线和 PolicyDecision。
9. 用同一组固定任务对比直接调用 Pi 与经过 Harness，记录完成率、排队时间、
   P50/P95 延迟、资源峰值以及重复工具执行次数。

其中 1–8 已由本地 Fake Demo 和 HTTP 集成测试覆盖；第 9 项必须在同一台 A6000、
同一个 vLLM 实例、同一模型和同一组任务上执行，不能用 Fake Runtime 数据替代。

### 必须完成的测试

- Run 状态机测试；
- RunStore 事务测试；
- RuntimeEventBridge 映射与去重测试；
- ToolGateway 幂等性测试；
- Checkpoint 恢复测试；
- ExecutionPolicy 三档压力测试；
- 多 Tenant 公平队列测试；
- slot 泄漏与重复释放测试；
- `CRITICAL -> NORMAL` 自动推进测试；
- 一条端到端集成测试。

### 最终复盘问题

1. 哪些部分属于 Agent Harness，哪些属于 Infra？
2. Pi 被替换后，Harness 哪些模块仍能保留？
3. 当前恢复语义具体保证到什么程度？
4. 资源感知真实改变了哪个决策？
5. 下一阶段最值得测量的瓶颈是什么？
6. 哪些指标能够证明系统比直接调用 Pi 更有价值？

## 10. 最小 API

本周 API 只服务演示和测试：

```text
POST /runs
GET  /runs/:runId
GET  /runs/:runId/events
POST /runs/:runId/interrupt
POST /runs/:runId/resume
GET  /queue
GET  /resources
GET  /health
```

`POST /runs` 的最小输入：

```text
tenantId
sessionId（可选，新任务时创建）
userInput
workspacePath
```

第一周不需要 Web UI。CLI、curl 和结构化日志足够展示 Harness 的核心能力。

## 11. 测试策略

测试分为三层：

### 11.1 纯单元测试

- Run 状态机；
- Policy；
- 队列；
- Pi 事件映射；
- 工具副作用分类。

这些测试完全不依赖网络、GPU 和真实 Pi。

### 11.2 组件测试

- SQLite Store；
- ToolGateway；
- CheckpointService；
- Fake Runtime 驱动的 RunService。

每个测试使用独立临时数据库。

### 11.3 集成测试

- Pi + 测试模型或真实 vLLM；
- `nvidia-smi` 真实采集；
- 固定演示任务。

真实模型测试不能成为每次本地测试的前置条件。

## 12. 一周验收矩阵

| 能力 | 最低验收标准 | 不接受的替代品 |
| --- | --- | --- |
| Pi 集成 | Pi 完成真实模型—工具循环 | 继续使用自研 AgentLoop |
| Run | 独立 ID、状态机、持久化 | 只保留 Session 消息 |
| Event | 可还原执行时间线 | 只有 console.log |
| Tool | 有独立执行记录和副作用状态 | 只把结果塞回 Prompt |
| Recovery | 至少一个安全边界可恢复 | 失败后重新从头运行 |
| Resource | Snapshot 改变 START/QUEUE | 只展示显存数字 |
| Auto progress | 资源恢复后队列自动推进 | 需要用户再次点击或重新提交 |
| Fairness | 两个 Tenant 的确定性测试 | 全局无界并发 |
| Explainability | 决策有 reason 和输入快照 | 只有“资源不足”字符串 |

## 13. 时间不足时的砍功能顺序

如果某天进度落后，保留顺序如下：

1. PiAdapter 跑通；
2. AgentRun + RunEvent；
3. ToolExecution；
4. SQLite 持久化；
5. Fake ResourceObserver + Policy；
6. 一个安全恢复点；
7. 真实 `nvidia-smi`；
8. 多 Tenant round-robin（不能砍掉基本 slot 队列与自动推进）；
9. HTTP API。

宁可最终使用 CLI，也不能为了做网页牺牲 Run、Event、Tool 和 Recovery。

## 14. 风险与止损规则

### Pi SDK 接入超过半天

先写最小 Spike，只验证 Session、Provider、Tool 和 Event。不要同时接数据库。若官方包迁移或 API 变化，固定一个已验证版本并写 ADR。

### 特定模型的工具调用不稳定

先用 Fake Runtime 证明 Harness 流程，再用 Qwen3.5-4B 快速定位模型模板、
reasoning parser、tool call parser 和 vLLM 版本问题，最后用 Qwen3.5-9B 做主要
集成验证。Harness 正确性与特定模型兼容性必须分开测试。

### Recovery 太复杂

把第一版保证收缩为“边界恢复”：模型完整响应后、工具结果持久化后恢复。不承诺任意指令级断点续跑。

### GPU 机器不方便反复测试

所有策略先由 Fake ResourceObserver 测试，真实 GPU 只做最后集成。不要让机房环境成为每天开发的前置条件。

### 旧实现重新产生干扰

新模块使用新目录和新接口，不重新引入 Agent Loop、直接 LLM Client 或主动 KV 驱逐逻辑；需要回顾旧实现时使用 Git 历史，不把它们恢复到主路径。

## 15. 第一阶段后的正式方向

Stage 1–2 已完成 Template、Instance、Capability、Attempt、Effective Policy 和
最小 Sandbox 的 Pi 主路径迁移。根据 ADR 0009，后续以真实用户任务闭环为目标，
依次推进：

1. 建立 API Key/Principal 认证，所有外部访问由服务端派生 Tenant；
2. 建立受管 Workspace 与 ExecutionProfile，禁止客户端传任意宿主机路径；
3. 实现每 Attempt 的容器 Sandbox，让文件、命令、网络、Secret 和资源策略在
   真实执行点生效；
4. 保留并强化公平队列、准入、kill/restart、Checkpoint 与危险副作用恢复；
5. 交付任务列表/详情、实时输出、最终回答、Diff、Artifact 和人工处理入口；
6. 用 A6000 对照、跨租户攻击测试、故障注入和固定 Benchmark 形成可复现证据。

完整任务、退出条件和停止规则只以
[`docs/multi-tenant-agent-task-service-roadmap.zh-CN.md`](docs/multi-tenant-agent-task-service-roadmap.zh-CN.md)
为准。Claude、异构 ResourcePool、多 Worker 和深度 vLLM 修改不进入当前主线；若
实测暴露特定瓶颈，再按证据选择后续方向。

### 15.1 可选的 Guarded Agentic Scheduling 路线

只有基线数据证明值得研究时，资源策略才按四阶段推进，不能跳过基线直接让 LLM 接管：

```text
Deterministic Baseline
  → Agent Shadow Mode
  → Offline Evaluation
  → Guarded Agentic Control
```

Scheduling Agent 的输入是结构化 `AdmissionContext`，至少包含 GPU 当前状态与趋势、活跃/排队 Run、预计工作量、Tenant 配额/SLO 和历史结果。它输出 `START / QUEUE / DEFER`、理由、置信度和有效期。

不可由 Agent 修改的 Hard Guardrails 至少包括：

- 观测过期或失败时不得假设资源充足；
- 绝对显存安全线、并发上限和 Tenant 硬配额不可突破；
- Agent 超时、不可用、低置信度或输出不合法时回退到确定性策略；
- Scheduling Agent 与工作负载共享 GPU 时，过载状态不能依赖 Agent 完成安全决策。

Shadow Mode 必须保存规则决定、Agent 建议、最终真实结果和差异。只有在 OOM、吞吐、排队时间、公平性、SLO、决策延迟与成本等指标上获得证据后，才允许 Agent 建议影响真实调度。

## 16. 历史记录：Day 1 第一个检查点

第一项工作不是写完整 PiAdapter，而是完成一个不超过半天的 Pi Spike：

1. 建立 `docs/adr/0001-use-pi-as-agent-runtime.md`。
2. 核对并固定 Pi SDK 版本。
3. 写一个独立实验入口，不连接数据库、不连接队列。
4. 让 Pi 连接 vLLM，完成一次只读工具调用。
5. 保存一份实际事件序列样例。
6. 根据实际事件反推 `AgentRuntime` 的最小接口。

Spike 的成功标准不是代码漂亮，而是我们拿到了四项事实：

- Pi 如何创建和恢复 Session；
- Pi 如何注册或包装工具；
- Pi 发出哪些关键事件；
- Pi 如何连接当前 vLLM。

完成后先不要继续扩展。下一次指导将基于真实事件序列审查 PiAdapter 边界，并决定哪些字段进入 RunEvent。
