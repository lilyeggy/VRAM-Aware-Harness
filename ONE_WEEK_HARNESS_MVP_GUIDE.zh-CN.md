# Resource-Aware Agent Harness：一周 MVP 学习与实施手册

> 文档版本：v1.0  
> 实施周期：7 天，每天约 6 小时  
> 目标读者：理解 Agent 基础，但希望系统掌握 Harness、后端与资源感知的开发者  
> 实施原则：你主写、我指导；每个阶段先理解边界，再实现，再用测试证明

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

最终演示必须同时证明五件事：

1. Pi 已经替代仓库里自研的 Agent Loop，Harness 不再重复维护模型—工具循环。
2. 每次执行都有独立、可查询、可恢复的 `AgentRun`。
3. 模型调用、工具调用和状态变化都可以通过事件还原。
4. 进程重启后，至少能从一个安全 Checkpoint 继续任务。
5. GPU 资源压力能够改变新 Run 的启动顺序，并留下可解释的策略记录。

如果这五点成立，我们得到的就不是聊天 API 包装器，也不是显存监控脚本，而是一个真正的 Resource-Aware Agent Harness 原型。

## 2. 本周如何学习，而不只是赶代码

每天六小时建议按以下节奏分配：

| 时间 | 内容 | 目的 |
| --- | --- | --- |
| 45 分钟 | 阅读当天概念与相关接口 | 先理解对象和边界 |
| 3 小时 30 分钟 | 亲手实现主任务 | 建立真实工程感觉 |
| 1 小时 | 写测试、故障注入和验收 | 用证据代替“看起来能跑” |
| 45 分钟 | 复盘、记录问题、接受代码审查 | 把实现转化为自己的知识 |

我们的协作约定：

- 你先根据当天任务写第一版，我负责解释设计、审查代码、定位问题和给出下一步。
- 遇到问题时，先描述“期望状态、实际状态、事件序列”，不要只贴最后一条报错。
- 我不会默认替你把整个模块写完；如果某个概念卡住，我会先用最小例子讲清楚。
- 每天必须通过验收门槛后再进入下一天，避免在不稳定地基上堆功能。
- 每天结束写一段 5～10 行的工程日志：做了什么、为什么这样设计、还有什么不确定。

## 3. 当前仓库的真实起点

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
| 自研 Agent Loop | 停止扩展，由 PiAdapter 取代 |
| Session 存在内存 Map | 引入 SQLite 持久化 AgentRun 与事件 |
| LLMClient 直接调用 vLLM | Agent 主路径交给 Pi；保留代码作为旧原型 |
| ContextManager 自行压缩 | 本周交给 Pi，Harness 只记录 Context 元数据 |
| `src/kv/*` 主动设计驱逐 | 保留为实验，不进入 MVP 主路径 |
| 没有 ToolExecution | 新增 ToolGateway 和独立执行记录 |
| 没有 Checkpoint/Recovery | 新增安全边界与恢复规则 |
| 没有资源观测 | 新增真实和 Fake ResourceObserver |
| 没有多用户调度 | 新增单进程公平队列 |

现有代码暂时不删除。新实现与旧原型并行存在，等 MVP 跑通后再决定哪些代码迁移、归档或移除。

根目录测试命令也需要收窄到 Harness 自己的 `tests/`，避免误扫描 `explainer-site` 和 `agentic-rl-lab` 的测试。

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
- GPU 内存分配和推理执行。

最重要的边界是：Harness 可以根据资源状态决定“何时提交模型请求”，但本周不接管 vLLM 内部的物理缓存管理。

## 6. 第一版技术选择

| 领域 | 选择 | 原因 |
| --- | --- | --- |
| 语言与运行时 | TypeScript + Bun | 与当前仓库一致，开发速度快 |
| Agent Runtime | Pi Coding Agent SDK | 复用成熟 Agent Loop、Session 和工具机制 |
| 模型服务 | 现有 vLLM OpenAI-compatible API | 不新增推理部署工作 |
| 持久化 | SQLite | 无额外服务，支持事务和进程重启 |
| API | Bun HTTP 或轻量框架 | 第一周只需要少量接口 |
| 资源观测 | `nvidia-smi` + Fake 实现 | 真实环境与本地测试都可运行 |
| 调度 | 单进程内存队列 | 足以验证公平性和资源策略 |
| 测试 | Bun Test + Fake Runtime | 快速、可重复、避免依赖真实 GPU |

Pi 依赖必须固定精确版本，不能使用浮动的 `latest`。开始安装前需要再次确认当前官方包名、版本和 SDK 导出，记录到 ADR 中。

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
- 不修改当前自研 `AgentLoop` 来实现新功能；
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

## Day 3：把 Pi 事件转换成 Harness 事件

### 今天真正要理解的概念

- Anti-corruption Layer；
- 外部事件与领域事件；
- 流式事件、完成事件和持久事件的差别；
- At-least-once 事件下的去重。

### 编码任务

1. 实现 `PiEventBridge`。
2. 建立 Pi 事件到 RunEvent 的显式映射表。
3. 只持久化具有业务意义的边界事件。
4. Token delta 可以流式展示，但不要逐 token 写数据库。
5. 记录模型调用开始、完成、耗时和 usage。

### 验收门槛

- 一次 Run 的事件能够按时间线打印；
- 不会因为流式 token 产生数千条数据库事件；
- 相同 Pi 事件重复到达时不会制造重复业务事件；
- Pi 升级导致未知事件时，系统可以记录告警而不是崩溃。

### 当天必须回答

1. 为什么不能把 Pi 原始事件 JSON 直接当数据库模型？
2. 哪些事件需要持久化，哪些只适合前端流式展示？
3. 模型请求和 Agent Step 是不是同一个对象？

## Day 4：ToolGateway、Checkpoint 与恢复

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
3. 实现 `nvidia-smi` 采集器。
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

## Day 6：最小多租户公平队列

### 今天真正要理解的概念

- Tenant 是资源与公平性主体；
- 全局并发和单用户并发；
- FIFO 的饥饿问题；
- Backpressure。

### 编码任务

1. 所有 Run 必须携带 `tenantId`。
2. 实现全局并发上限。
3. 实现单 Tenant 并发上限。
4. 实现简单 round-robin tenant queue。
5. Run 完成、失败或中断时释放 slot。
6. 增加查询队列位置和排队原因的接口。

### 验收场景

```text
Tenant A 提交 A1、A2、A3
Tenant B 提交 B1
全局并发为 1
```

期望 B1 不会永远排在 A 的所有任务之后。具体顺序由策略定义，但必须可解释、可测试。

### 当天必须回答

1. Session 和 Tenant 谁是公平性主体？
2. 为什么仅使用全局 FIFO 可能不公平？
3. Run 什么时候占用 slot，什么时候释放？
4. 工具长时间执行时是否占用模型并发 slot？

## Day 7：集成、演示和复盘

### 固定演示脚本

1. Tenant A 提交“分析当前项目测试结构”。
2. Tenant B 提交“总结 Harness 的架构边界”。
3. Fake 或真实资源状态从 NORMAL 切换到 CRITICAL。
4. 新 Run 进入队列，活跃 Run 继续到安全边界。
5. 在一次已完成工具调用后重启 Harness。
6. 系统读取 Checkpoint 并继续。
7. 资源恢复 NORMAL，排队 Run 启动。
8. 最后打印每个 Run 的事件时间线和 PolicyDecision。

### 必须完成的测试

- Run 状态机测试；
- RunStore 事务测试；
- PiEventBridge 映射测试；
- ToolGateway 幂等性测试；
- Checkpoint 恢复测试；
- ExecutionPolicy 三档压力测试；
- 多 Tenant 公平队列测试；
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
8. 多 Tenant round-robin；
9. HTTP API。

宁可最终使用 CLI，也不能为了做网页牺牲 Run、Event、Tool 和 Recovery。

## 14. 风险与止损规则

### Pi SDK 接入超过半天

先写最小 Spike，只验证 Session、Provider、Tool 和 Event。不要同时接数据库。若官方包迁移或 API 变化，固定一个已验证版本并写 ADR。

### DeepSeek 工具调用不稳定

先用一个已知支持 tool calling 的模型证明 Harness 流程，再单独定位模型模板和 vLLM 参数。Harness 正确性与特定模型兼容性必须分开测试。

### Recovery 太复杂

把第一版保证收缩为“边界恢复”：模型完整响应后、工具结果持久化后恢复。不承诺任意指令级断点续跑。

### GPU 机器不方便反复测试

所有策略先由 Fake ResourceObserver 测试，真实 GPU 只做最后集成。不要让机房环境成为每天开发的前置条件。

### 当前旧代码产生干扰

新模块使用新目录和新接口，不在旧 AgentLoop 中打补丁。等纵向切片完成后再迁移入口。

## 15. 第一阶段后的方向

一周 MVP 完成后，下一阶段按证据选择，而不是按想象扩张：

- 如果主要问题是排队和公平性：完善持久队列、优先级、配额和 SLO。
- 如果主要问题是进程可靠性：完善 Worker lease、heartbeat 和恢复协议。
- 如果主要问题是长上下文成本：建设 Context Compiler 和 Context Epoch。
- 如果主要问题是重复 Prefill：测量 Prefix Cache 命中，再研究上下文稳定性。
- 如果 KV 容量确实成为瓶颈：再进入 vLLM KV Event、Residency 或 Offload 实验。
- 如果要服务真实团队：增加认证、Workspace 隔离、权限和审计。

## 16. 现在就开始：Day 1 第一个检查点

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
