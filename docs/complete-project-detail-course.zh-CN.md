# VRAM-Aware Harness 完整项目细节课程

> **定位说明（2026-08-12）**：本文用于学习和解释现有实现，不定义当前开发优先级。
> 文中 Claude Adapter、异构 ResourcePool 和大型控制面章节保留为历史设计材料；
> 当前唯一实施路线见
> [多租户 Agent 任务服务路线图](multi-tenant-agent-task-service-roadmap.zh-CN.md)。

> 目标：读完后，你不只是能复述架构图，而是能够从任意一个 HTTP 请求、数据库行、
> RuntimeEvent 或失败日志出发，沿真实代码定位它的创建者、消费者、状态变化、事务
> 边界和测试证据，并能独立修改核心流程而不破坏恢复与审计语义。

## 导言：这份文档与前一版有什么不同

前一版 `stage1-stage2-code-reading-guide.zh-CN.md` 适合快速建立 Stage 1–2 地图，但仍然
省略了很多“为什么代码必须这样写”的中间推导。这份课程采用老师带读的方式：

- 使用同一个贯穿案例，从 HTTP 一直追到 SQLite 和 Pi SDK；
- 区分命令、即时事件、持久事实、当前状态和策略决定；
- 展开每一层真正调用的方法，而不是只列类名；
- 给出关键对象在每个阶段的实际值；
- 解释事务、CAS、去重键、slot、single-flight 等机制解决的具体竞态；
- 对每个失败点说明数据库最终应留下什么；
- 把每项承诺映射到测试断言；
- 明确当前实现没有提供的生产保证。

这不是 API 手册。API 手册告诉你“函数怎么调用”，本课程要解释“删掉这一行会破坏
什么系统性质”。

---

# 第一部分：建立正确的系统语言

## 第 1 章：项目到底是什么

### 1.1 一句话定义

这个项目不是另一个 Agent Loop。Agent 的思考、模型调用、上下文和工具循环交给 Pi；
本项目在 Pi 外层提供：

```text
可持久化的任务状态
+ 副作用安全边界
+ 资源准入和公平排队
+ 版本化执行环境
+ Runtime 能力校验
+ 多层策略强制
+ Sandbox 生命周期
+ 故障恢复与审计证据
```

因此它更像“Agent 执行控制面”，而不是“Agent 本身”。

### 1.2 三个平面

为了避免边界混乱，先把系统分成三个平面：

| 平面 | 负责什么 | 本项目中的代表 |
| --- | --- | --- |
| Behavior Plane | 模型如何思考、何时调用工具、如何维护上下文 | Pi AgentSession |
| Control Plane | 哪个任务能运行、使用什么权限、失败后怎样恢复 | 本 Harness |
| Infrastructure Plane | 模型推理、GPU、文件系统、进程环境 | vLLM、GPU、Sandbox Provider |

一个具体例子：模型决定调用 `write` 是 Behavior Plane；Tenant 是否允许 `write` 是
Control Plane；真正把字节写进文件系统是 Infrastructure Plane。

控制面不替模型做工具选择，但必须在写入发生前有最终否决权。

### 1.3 项目当前的真实边界

当前完成的是单进程 + SQLite 的本地控制面语义：

- 一个 Bun 进程；
- 一个 SQLite 数据库；
- 内存 Tenant 公平队列；
- Pi Runtime；
- vLLM/NVIDIA 资源观测；
- ManagedLocal Sandbox；
- Stage 1–2 控制面对象和策略。

当前没有：

- 多 Worker 分布式锁；
- 生产认证和 RBAC；
- 容器级 CPU/内存/网络隔离；
- Claude Adapter；
- 跨主机 Session 恢复；
- A6000 性能结论。

理解“没做什么”与理解“做了什么”同样重要。

---

## 第 2 章：五类容易混淆的信息

这是理解整个项目最重要的一章。

### 2.1 Command：希望系统做什么

Command 是调用方提出的意图，例如：

```ts
runtime.start({ run, input });
runtime.interrupt(runId);
coordinator.submit(input);
sandbox.create(input);
```

Command 可能失败，所以不能把“调用过 start”当成“已经启动”的事实。

### 2.2 RuntimeEvent：底层刚刚报告了什么

RuntimeEvent 是当前进程中的即时通知：

```ts
type RuntimeEvent =
    | { type: "agent_started"; ... }
    | { type: "model_completed"; ... }
    | { type: "tool_started"; ... }
    | { type: "agent_failed"; ... };
```

它具有以下特点：

- 来自 Adapter；
- 只存在于运行时；
- 可能重复投递；
- 进程崩溃后不会自动保留；
- 需要转换为 Harness 自己的长期事实。

### 2.3 RunEvent：Harness 已经接受并保存的历史事实

RunEvent 是追加式审计日志：

```ts
interface RunEvent {
    eventId: string;
    runId: string;
    sequence: number;
    type: RunEventType;
    timestamp: string;
    payloadVersion: number;
    payload: unknown;
    dedupeKey?: string;
}
```

它与 RuntimeEvent 的根本差别不是命名，而是持久性：

```text
RuntimeEvent = 进程内观察到的候选事实
RunEvent     = Harness 已接受并持久化的业务事实
```

### 2.4 State：根据事实得出的当前快照

`AgentRun.status = RUNNING` 是当前快照。`RUN_STARTED` 是导致它变成 RUNNING 的历史事实。

两者为什么都要保存？

- 查询当前状态时，直接读取 `agent_runs`，不必重放全部事件；
- 审计发生过程时，读取 `run_events`；
- 更新时必须在同一事务里同时修改，避免快照与历史不一致。

### 2.5 Decision：在当时证据下为什么允许或拒绝

资源准入和工具策略都产生 Decision：

```text
ResourceSnapshot → PolicyDecision START/QUEUE
EffectivePolicySnapshot → ToolPolicyDecision ALLOW/DENY
```

Decision 不能只保存结果，还要保存：

- 对哪个 Run；
- 使用哪个 Snapshot；
- reasonCode；
- 决策时间。

这样以后策略改变，历史决定仍然可解释。

### 2.6 五类信息放在一起

以一次模型调用 `write` 为例：

```text
Command:
  Pi 请求执行 write

Decision:
  ToolPolicyDecision = DENY，因为 Tenant 只允许 read

RuntimeEvent:
  可能出现 Pi 的 tool_execution_start，因为 SDK 可能在调用包装器前报告“进入工具分发”

RunEvent:
  可能出现 TOOL_STARTED/TOOL_FAILED；它们表示 Runtime 观察到的工具边界，不等于副作用

State:
  ToolExecution 不应该创建 PREPARED 行
```

因此“零副作用”的可靠证明是 `真实 invoke 次数为 0 + ToolExecution 不存在 + DENY
Decision`，不能单靠有没有 TOOL_STARTED 判断。当前事件名保留了 Pi 的边界术语，阅读
时间线时必须把它与 ToolExecution 的副作用状态区分开。

如果这五类信息混在一起，就很容易写出“策略拒绝了，但数据库看起来像工具执行到一半”
的错误实现。

---

## 第 3 章：代码分层方法

### 3.1 Domain Function

纯领域函数只计算，不访问数据库或网络，例如：

```ts
classifyResource(snapshot, thresholds)
decideRecovery(checkpointId, preparedExecutions)
transitionHarnessInstance(instance, nextState, time)
computeEffectivePolicy(layers)
```

优点是可以用极小单元测试覆盖全部分支。

### 3.2 Store

Store 负责领域对象与 SQLite 之间的映射和事务：

```text
RunStore
ToolExecutionStore
HarnessTemplateStore
EffectivePolicyStore
```

Store 不应该决定业务策略。例如 `ToolExecutionStore` 可以保证
`PREPARED → SUCCEEDED` 的条件更新，但“READ_ONLY 是否可自动重放”属于领域逻辑。

### 3.3 Service / Coordinator

Service 串联多个领域对象和基础设施：

```text
RunService              Run 状态 + Runtime 事件
ResourceAdmissionService Observer + Classifier + Policy + Store
RunQueueCoordinator     Scheduler + Admission + RunService
RecoveryService         Run + ToolExecution + Checkpoint
```

### 3.4 Adapter

Adapter 把外部系统协议翻译成 Harness 合同：

```text
PiAdapter                Pi SDK ↔ AgentRuntime
VllmResourceObserver     Prometheus/NVIDIA ↔ ResourceSnapshot
HarnessHttpApi           HTTP ↔ HarnessApplication
```

### 3.5 Composition Root

`createHarnessApplication.ts` 是唯一知道所有具体实现如何连接的地方。领域类只依赖接口，
Composition Root 决定使用 SQLite Store、PiAdapter、ManagedLocalSandbox 和真实 Observer。

这就是依赖注入在本项目中的实际用途，不是为了使用框架，而是为了：

- 测试时替换 Fake Runtime；
- 测试时替换 Fake ResourceObserver；
- 将来替换 Sandbox Provider；
- 让领域层不依赖 Pi SDK。

---

# 第二部分：贯穿案例与进程启动

## 第 4 章：贯穿全文的具体任务

后续都使用这个例子：

```json
{
  "tenantId": "tenant-a",
  "sessionId": "session-42",
  "userInput": "读取 README 并总结架构",
  "workspacePath": "/workspaces/project-a"
}
```

配置假设为：

```text
PI_PROVIDER=local-vllm
VLLM_MODEL_ID=qwen3.5-9b
PI_TOOLS=read,write,bash
HARNESS_MAX_ACTIVE_RUNS=2
HARNESS_MAX_ACTIVE_RUNS_PER_TENANT=1
```

为了阅读方便，假设生成的 ID 为：

```text
runId              = run-100
templateVersionId  = tpl-a-v1
instanceId         = instance-a
attemptId          = attempt-100-1
policySnapshotId   = policy-100-1
sandboxId          = sandbox-100-1
runtimeSessionRef  = /workspaces/project-a/.pi/session-xyz.jsonl
toolCallId         = call-read-1
checkpointId       = checkpoint-1
```

真实代码使用 `crypto.randomUUID()` 或稳定默认 ID；这里使用短 ID 只是为了跟踪。

---

## 第 5 章：进程如何启动

入口：`src/main.ts`

### 5.1 第一步：加载配置

```ts
const config = options.config ?? loadHarnessConfig(
    options.environment ?? process.env,
    options.cwd ?? process.cwd(),
);
```

`loadHarnessConfig` 不只是读取字符串，它在进程开放端口前验证关键不变量：

- `VLLM_MODEL_ID` 必须存在；
- 端口必须合法；
- 并发必须是正整数；
- 单 Tenant 并发不能大于全局并发；
-阈值和超时必须可解析。

这叫 fail fast：配置错误应该让启动失败，而不是运行到第一个请求时才暴露。

### 5.2 第二步：组装应用

```ts
const composition = await createHarnessApplication(
    config,
    options.compositionDependencies,
);
```

这一调用创建：

```text
SQLite
→ 所有 Store
→ ToolPolicyGuard + ToolGateway
→ PiAdapter
→ ManagedAgentRuntime(PiAdapter)
→ DefaultPiControlPlane
→ RunService
→ Scheduler + Admission + Coordinator + Pump
→ Recovery 链
→ HarnessApplication
→ HarnessHttpApi
```

注意 `PiAdapter` 被包在 `ManagedAgentRuntime` 内部；RunService 得到的不是裸 PiAdapter。

### 5.3 第三步：恢复先于 HTTP

```ts
await composition.application.start();
server = startHarnessHttpServer(composition.httpApi, ...);
```

顺序必须是恢复完成后才监听 HTTP。否则可能发生：

```text
旧 RUNNING Run 尚未标记 INTERRUPTED
+ 新请求已经进入
+ QueuePump 已开始推进
= 内存队列和数据库状态互相矛盾
```

`HarnessApplication.start()` 还使用 single-flight：

```ts
if (this.startPromise !== null) {
    return this.startPromise;
}
this.startPromise = this.startOnce();
```

两个并发 start 调用共享同一个恢复 Promise，不会扫描两次旧 Run。

### 5.4 第四步：启动 QueuePump

`startOnce()`：

```ts
await this.startupRecovery.recover();
this.queuePump.start();
this.started = true;
```

Pump 的职责不是做决策，而是周期性请求 Coordinator 尝试推进队列。资源观测、分类和
执行决策仍在 Admission 层。

### 5.5 第五步：安全关闭

```ts
await server.stop(true);
await composition.close();
```

先停止接收 HTTP，再停止 Pump、关闭数据库。`closePromise` 保证 SIGINT、SIGTERM 和
测试清理同时触发时只关闭一次。

### 5.6 启动阶段对象状态

进程刚启动且数据库为空时：

```text
HarnessApplication.started = true
QueuePump = running
Scheduler queues = empty
Scheduler active slots = empty
数据库 schema version = 7
尚无 Template/Instance/Session，因为它们按 Tenant 懒创建
```

---

# 第三部分：从 HTTP 到持久化 QUEUED Run

## 第 6 章：HTTP 层只做协议转换

入口：`src/http/harness-http-api.ts`

### 6.1 路由职责

HTTP 层负责：

- 识别 method/path；
- 解析 JSON；
- 检查必填字符串；
- 将领域对象转成 JSON Response；
- 把已知错误映射为稳定状态码。

HTTP 层不负责：

- 创建 Template；
- 决定资源准入；
- 改 Run 状态；
- 调用 Pi；
- 写 SQL。

### 6.2 POST /runs

概念上执行：

```ts
const body = await request.json();
const run = this.application.submitRun({
    tenantId: requiredString(body, "tenantId"),
    harnessSessionId:
        optionalString(body, "sessionId") ?? crypto.randomUUID(),
    userInput: requiredString(body, "userInput"),
    workspacePath: requiredString(body, "workspacePath"),
});
return jsonResponse(run, 202);
```

为什么返回 202 而不是等待任务完成？因为 submit 只承诺 Run 已持久化并进入调度链，
Runtime 可能因为资源压力继续排队。

### 6.3 为什么 HTTP 使用 HarnessApplication

如果 HTTP 直接依赖 RunStore，它可以绕过 Scheduler 创建一个数据库 Run，却没有进入
内存队列；如果直接依赖 PiAdapter，它又会绕过 Run 状态、策略和恢复。Application
Facade 把协议层限制在合法用例上。

---

## 第 7 章：HarnessApplication 提交任务

```ts
submitRun(input: StartRunInput): AgentRun {
    this.assertStarted();
    const run = this.coordinator.submit(input);
    void this.queuePump.tick();
    return run;
}
```

逐句解释：

1. `assertStarted()`：禁止恢复尚未完成时接收任务；
2. `coordinator.submit()`：同步完成 Run 持久化和内存入队；
3. `void queuePump.tick()`：请求立即推进，但不阻塞 HTTP；
4. 返回的是 `QUEUED` 快照，不是假装已经运行。

为什么 `tick()` 不 await？提交接口的成功标准是“可靠入队”，不是“Agent 已完成”。
如果调用方需要结果，应通过 Run 查询或未来的事件流观察。

这里有一个细节：`void` 不是忽略任务逻辑，而是明确告诉 TypeScript 我们有意启动一个
后台 Promise。Pump 自己负责错误报告和下次继续推进。

---

## 第 8 章：Coordinator.submit 与 RunService.createQueuedRun

### 8.1 Coordinator 先持久化，再入内存队列

```ts
submit(input: StartRunInput): AgentRun {
    const run = this.runService.createQueuedRun(input);
    this.scheduler.enqueue({
        runId: run.id,
        tenantId: run.tenantId,
    });
    return run;
}
```

顺序为什么是数据库在前？

如果先入内存队列，进程在 SQL 写入前崩溃，Scheduler 中曾存在一个数据库完全不知道
的 Run。持久化先成功后再入队，至少可以在重启时通过 `listQueuedRuns()` 重建队列。

当前仍有一个单进程窗口：数据库写成功后、内存 enqueue 前崩溃。这个窗口由启动时
QueuedRunRestorer 收敛，因为数据库中的 QUEUED 是事实来源。

### 8.2 RunService 先解析控制面绑定

```ts
const runId = crypto.randomUUID();
const timestamp = new Date().toISOString();
const controlBinding = this.controlBindingResolver?.resolve(input);
```

正式应用注入 `DefaultPiControlPlane`，因此 `resolve()` 会确保：

```text
CapabilityProfile 已存在
Template 和不可变 v1 已存在
Instance 已存在且 READY
Session 已存在且 Tenant/Instance 匹配
```

然后才创建 Run：

```ts
const run: AgentRun = {
    id: runId,
    tenantId: input.tenantId,
    harnessSessionId: input.harnessSessionId,
    status: "QUEUED",
    userInput: input.userInput,
    workspacePath: input.workspacePath,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    checkpointId: null,
    failureReason: null,
    ...(input.runPolicy === undefined ? {} : { runPolicy: input.runPolicy }),
    ...(controlBinding ?? {}),
};
```

`...(controlBinding ?? {})` 是条件展开。正式路径会加入：

```ts
templateVersionId: "tpl-a-v1"
harnessInstanceId: "instance-a"
```

旧单元测试不注入 Resolver 时，不会生成值为 undefined 的显式属性，从而保持旧对象
深度相等断言。

### 8.3 初始事件

```ts
const createdEvent: RunEvent = {
    eventId: crypto.randomUUID(),
    runId,
    sequence: 1,
    type: "RUN_CREATED",
    timestamp,
    payloadVersion: 1,
    payload: {},
};
```

所有 Run 的第一条事件必须是 sequence 1。`payloadVersion` 允许未来改变 payload 结构
时仍能读取旧事件。

### 8.4 RunStore.create 的事务

```ts
const createRunAndInitialEvent = this.db.transaction(() => {
    INSERT INTO agent_runs (...);
    this.insertEvent(initialEvent);
});

createRunAndInitialEvent();
```

这两个写入必须原子：

| 可能情况 | 没有事务的后果 |
| --- | --- |
| Run 插入成功，Event 失败 | 有状态但没有创建历史 |
| Event 插入成功，Run 失败 | 外键打开时拒绝；没打开则产生孤儿事件 |

项目打开 SQLite 时执行：

```sql
PRAGMA foreign_keys = ON;
```

因为 SQLite 外键是连接级开关，不是建表后自动永久生效。

### 8.5 此时数据库和内存是什么样

数据库：

```text
agent_runs:
  id                    run-100
  tenant_id             tenant-a
  status                QUEUED
  template_version_id   tpl-a-v1
  harness_instance_id   instance-a
  checkpoint_id         NULL

run_events:
  run-100 / sequence 1 / RUN_CREATED
```

内存 Scheduler：

```text
queuesByTenant = {
  "tenant-a": [{ runId: "run-100", reasonCode: "AWAITING_SCHEDULING" }]
}
tenantOrder = ["tenant-a"]
activeTenantByRunId = {}
```

# 第四部分：调度、slot 与资源准入

## 第 9 章：TenantRunScheduler 的三个内存结构

源码：`src/scheduling/tenant-run-scheduler.ts`

```ts
private readonly queuesByTenant = new Map<string, QueuedRun[]>();
private readonly tenantOrder: string[] = [];
private readonly activeTenantByRunId = new Map<string, string>();
```

每个结构只负责一件事：

| 结构 | 内容 | 解决的问题 |
| --- | --- | --- |
| queuesByTenant | 每个 Tenant 内 FIFO | 同一 Tenant 保持提交顺序 |
| tenantOrder | Tenant 轮转队列 | Tenant 间 round-robin |
| activeTenantByRunId | 已占 slot 的 Run → Tenant | 全局与 Tenant 并发计数 |

为什么不使用一个全局数组？考虑：

```text
提交顺序：A1, A2, A3, B1
全局 FIFO：A1, A2, A3, B1
Tenant 公平：A1, B1, A2, A3
```

如果 Tenant A 连续提交很多任务，单一 FIFO 会让 B 长时间饥饿。

### 9.1 enqueue

```ts
enqueue(input: EnqueueRunInput): QueuedRun {
    if (this.activeTenantByRunId.has(input.runId)) {
        throw new Error(`Run 正在执行中：${input.runId}`);
    }
    if (this.findQueuedRun(input.runId) !== null) {
        throw new Error(`Run 已经在队列中：${input.runId}`);
    }
    // 创建 QueuedRun，放入 Tenant FIFO
}
```

两个拒绝分别防止：

- active Run 被重复排队，造成同一 Run 并发执行；
- waiting Run 重复出现，未来被 claim 两次。

新 Tenant 首次入队时加入 `tenantOrder`；已有 Tenant 只追加到自己的 FIFO。

### 9.2 claimNext 是“选择 + 原子占位”

调用 `claimNext()` 成功返回时，Run 已经：

```text
离开 waiting queue
+ 写入 activeTenantByRunId
= 占用了逻辑 slot
```

不是先返回 Run、等调用方以后再占 slot。否则两个并发调用可能都看到同一个空位：

```text
maxActiveRuns = 1

调用 A: 看到 active=0，选择 A1
调用 B: 也看到 active=0，选择 B1
调用 A: 占 slot
调用 B: 占 slot
结果 active=2，突破硬上限
```

当前 JavaScript 单线程同步执行 `claimNext()`，把选择和 Map 写入放在同一个不含 await
的临界段里，因此第二次调用会看到更新后的 size。

### 9.3 round-robin 的逐步推演

假设：

```text
queuesByTenant:
  A → [A1, A2]
  B → [B1, B2]
tenantOrder = [A, B]
```

第一次 claim：

```text
shift tenant A
shift A1
A 仍有 A2，所以 push A
tenantOrder = [B, A]
active = {A1 → A}
```

第二次 claim：

```text
shift tenant B
shift B1
B 仍有 B2，所以 push B
tenantOrder = [A, B]
active = {A1 → A, B1 → B}
```

得到 `A1 → B1`。A1 释放后下一次是 A2。

### 9.4 Tenant 并发上限

如果 Tenant A 已达到 `maxActiveRunsPerTenant`，它不会被删除，而是放回轮转队尾：

```ts
if (activeTenantRunCount >= maxActiveRunsPerTenant) {
    this.tenantOrder.push(tenantId);
    continue;
}
```

循环最多检查本轮开始时的 Tenant 数量，防止所有 Tenant 都达上限时无限旋转。

### 9.5 release 必须在 finally

```ts
release(runId: string): boolean {
    return this.activeTenantByRunId.delete(runId);
}
```

release 是幂等的。Coordinator 把它放进 finally，覆盖：

- Run 成功；
- Run 失败；
- Runtime start 抛错；
- 事件处理抛错。

如果漏掉一个异常分支，slot 会永久泄漏，后续队列看起来“资源正常但永远不启动”。

### 9.6 listQueue 为什么操作副本

查询队列位置要模拟 round-robin，但不能改变真实顺序。因此它复制 Map 中的数组和
tenantOrder，在副本上 shift。查询接口改变调度结果是典型的隐蔽 bug。

---

## 第 10 章：Coordinator.attemptNext 的精确语义

源码：`src/scheduling/run-queue-coordinator.ts`

### 10.1 第一步：claim

```ts
const queuedRun = this.scheduler.claimNext();
if (queuedRun === null) return { kind: "EMPTY" };
```

从这一行以后，Coordinator 对 slot 负有释放责任。

### 10.2 为什么 capacity 要减 1

```ts
const capacity = this.scheduler.getCapacity(queuedRun.tenantId);
const admissionRequest = {
    activeRunCount: capacity.activeRunCount - 1,
    activeTenantRunCount: capacity.activeTenantRunCount - 1,
};
```

claimNext 已经预占当前候选 Run 的 slot，但 ExecutionPolicy 的输入语义是“在启动这个
Run 之前已有多少活跃 Run”。所以减 1 排除候选自身。

如果不减，假设 maxActiveRuns=1：

```text
claim 后 activeRunCount=1
Policy 看到 1 >= 1
永远 QUEUE
```

系统会自我阻塞。

### 10.3 Admission 自身抛错

```ts
try {
    admissionResult = await this.admission.evaluate(request);
} catch (error) {
    this.scheduler.release(runId);
    this.scheduler.enqueue({
        runId,
        tenantId,
        reasonCode: "RESOURCE_OBSERVATION_FAILED",
        enqueuedAt: queuedRun.enqueuedAt,
    });
    throw error;
}
```

必须先 release 再 enqueue，因为 Scheduler 禁止 active Run 入队。保留原 enqueuedAt
避免观测器偶发错误让这个 Run 变成“最新任务”而破坏公平性。

### 10.4 QUEUE 决策

```ts
if (decision.action === "QUEUE") {
    const reasonCode = toQueueReasonCode(decision);
    release();
    enqueue({ reasonCode, enqueuedAt: original });
    return { kind: "DEFERRED", runId, decision };
}
```

数据库中的 Run 状态仍为 QUEUED；内存 QueuedRun 的 reasonCode 更新为更具体的资源原因。
PolicyDecision 单独持久化，所以即使队列 reason 后来变化，历史决策不会丢失。

### 10.5 START 决策

```ts
const resumeInput = this.pendingResumeByRunId.get(runId);
try {
    const run = resumeInput === undefined
        ? await this.runService.executeQueuedRun(runId)
        : await this.runService.executeQueuedResume(resumeInput);
    return { kind: "EXECUTED", run, decision };
} finally {
    if (resumeInput !== undefined) pendingResume.delete(runId);
    this.scheduler.release(runId);
}
```

新启动和恢复共用调度、资源准入和 slot；唯一差异是最终调用 RunService 的 start 还是
resume。这防止恢复任务绕过当前资源压力。

---

## 第 11 章：drain 的并发控制

### 11.1 attemptNext 与 drain 的区别

```text
attemptNext = 选择并处理一个候选 Run
drain       = 尽可能处理当前队列的一轮或多轮
```

### 11.2 为什么使用 Promise.allSettled

`drainOnce()` 根据当前队列长度创建若干 attempt：

```ts
const roundPromises = Array.from(
    { length: remainingAttempts },
    () => this.attemptNext(),
);
const settledResults = await Promise.allSettled(roundPromises);
```

Scheduler 的同步 claim 保证 slot 不超限；Promise 并发允许不同 Tenant 的 Runtime 真正
并行。使用 allSettled 是为了一个 Run 失败时，其他已获 slot 的 Run 仍然完成清理。

### 11.3 为什么限制 remainingAttempts

CRITICAL 资源下，每个 Run 会 QUEUE 后重新入队。如果 drain 一直处理“直到队列为空”，
它会反复检查同一批永远被拒绝的 Run。`remainingAttempts` 固定本轮最多检查当前队列中
的每个 Run 一次。

### 11.4 single-flight drain

```ts
drain(): Promise<CoordinatorResult[]> {
    this.drainRequested = true;
    if (this.drainPromise !== null) return this.drainPromise;
    this.drainPromise = this.runDrainLoop();
    return this.drainPromise;
}
```

两个并发 tick 不创建两个独立 drain 循环；它们共享一个 Promise。但第二次调用设置
`drainRequested=true`，现有循环完成当前 pass 后会再检查一轮，避免在执行期间新入队
的 Run 被漏到下一个定时周期。

这个模式解决两个相反问题：

- 不能同时运行多个 drain，避免复杂竞态；
- 也不能简单忽略 drain 期间的新请求。

---

## 第 12 章：资源观测从哪里来

源码：`src/resources/resource-observer.ts`、`vllm-resource-observer.ts`

### 12.1 Snapshot 是事实，不是决定

```ts
interface ResourceSnapshot {
    snapshotId: string;
    observedAt: string;
    sources: readonly ResourceObservationSource[];
    gpuTotalMemoryMiB: number | null;
    gpuUsedMemoryMiB: number | null;
    gpuFreeMemoryMiB: number | null;
    gpuUtilizationPercent: number | null;
    runningRequests: number | null;
    waitingRequests: number | null;
    kvCacheUsagePercent: number | null;
    inputTokensPerSecond: number | null;
    outputTokensPerSecond: number | null;
}
```

字段允许 null，因为 vLLM 和 nvidia-smi 提供不同事实。Observer 不应该因为一个来源
缺失就伪造 0；0 表示“确认没有使用”，null 表示“不知道”。

### 12.2 两个探针并行

```ts
const [vllmResult, nvidiaResult] = await Promise.all([
    captureProbe(readVllmMetrics),
    captureProbe(readNvidiaGpu),
]);
```

并行避免最坏情况下串行等待两个 timeout。只要一个来源成功，Observation 仍可 ok，
Snapshot 中缺失字段保持 null；两个都失败才返回 `{ok:false}`。

### 12.3 Prometheus 聚合规则

同一指标可能因 model label 出现多行：

- running/waiting 和 token counter 求和，代表总负载；
- KV cache 取最大值，避免平均值掩盖某个高压实例。

`kv_cache_usage_perc` 从 0–1 转换为 0–100。

### 12.4 Counter 如何变成 rate

Prometheus token 指标是累计 Counter。第一次只能保存基线：

```text
t1 counter=1000 → rate=null
t2 counter=1300, Δt=10s → rate=30 tokens/s
```

如果 current < previous，说明 vLLM 可能重启并归零，该区间返回 null，不能产生负速率。

### 12.5 多 GPU 聚合

显存 total/used/free 求和；utilization 取最大值。取最大值的意图是保守地发现最忙 GPU，
但也要知道它不是拓扑感知调度，目前只形成全局快照。

---

## 第 13 章：分类与策略为什么分两层

### 13.1 Classifier：事实 → 压力等级

`classifyResource` 是纯函数：

```text
ResourceSnapshot + thresholds
→ NORMAL / BUSY / CRITICAL / UNKNOWN
+ reasons
```

任一 CRITICAL 信号使整体 CRITICAL；没有 CRITICAL 但存在 BUSY 则 BUSY；所有信号
缺失则 UNKNOWN；其余 NORMAL。

原因数组可能包含多个值，例如：

```text
[GPU_MEMORY_BUSY, KV_CACHE_CRITICAL, WAITING_REQUESTS_BUSY]
```

整体是 CRITICAL，但不会丢失其他压力信号。

### 13.2 Policy：压力 + 并发上下文 → 动作

`DeterministicExecutionPolicy` 的规则表：

| Pressure | 额外条件 | Action | Reason |
| --- | --- | --- | --- |
| CRITICAL | 无 | QUEUE | RESOURCE_CRITICAL |
| UNKNOWN | 无 | QUEUE | RESOURCE_UNKNOWN |
| BUSY | 全局满 | QUEUE | GLOBAL_CONCURRENCY_LIMIT |
| BUSY | 当前 Tenant 已有 active | QUEUE | RESOURCE_BUSY_TENANT_LIMIT |
| BUSY | Tenant 尚无 active | START | RESOURCE_BUSY_TENANT_AVAILABLE |
| NORMAL | 全局满 | QUEUE | GLOBAL_CONCURRENCY_LIMIT |
| NORMAL | 有 slot | START | RESOURCE_NORMAL |

BUSY 时允许没有活跃 Run 的 Tenant 启动，体现最低限度公平；CRITICAL 时所有新 Run
都排队，安全优先。

### 13.3 为什么 UNKNOWN 要 fail closed

UNKNOWN 不是 NORMAL。观测数据不足时继续启动会把“看不到压力”误当成“没有压力”。
当前策略选择 QUEUE，并记录 RESOURCE_UNKNOWN。

### 13.4 Admission Service 串联并持久化

```text
Observer.observe
→ 如果失败：直接生成 QUEUE/OBSERVATION_FAILED
→ 如果成功：Classifier
→ ExecutionPolicy
→ PolicyDecisionStore.save(snapshot, decision)
```

Snapshot 和 Decision 在同一事务保存，防止出现“决定引用了不存在的资源证据”。

---

# 第五部分：Run 执行、RuntimeEvent 与持久历史

## 第 14 章：Run 状态机

源码：`src/runs/agent-run.ts`、`run-state-machine.ts`

```text
QUEUED → RUNNING → COMPLETED
                 → FAILED
                 → INTERRUPTED → QUEUED（恢复）
                 → WAITING_TOOL → RUNNING/FAILED/INTERRUPTED
```

`COMPLETED` 和 `FAILED` 是终态；当前不能重开。`INTERRUPTED` 不是失败终态，它表示执行
没有完成，但可能存在安全恢复路径。

为什么 Runtime start 直接抛错会退回 INTERRUPTED 而不是 FAILED？因为它可能尚未真正
执行，已有 Checkpoint 也仍可能有效。更具体原因保存在 RUN_INTERRUPTED payload。

---

## 第 15 章：executeQueuedRun 逐步执行

### 15.1 重新从 Store 读取

```ts
const run = this.getRequiredRun(runId);
if (run.status !== "QUEUED") throw ...;
```

不相信 Scheduler 手里的旧对象，数据库才是当前状态事实。

### 15.2 原子进入 RUNNING

```ts
const runningRun = {
    ...run,
    status: "RUNNING",
    updatedAt: startedAt,
    startedAt,
};

this.store.update(runningRun, {
    type: "RUN_STARTED",
    sequence: lastSequence + 1,
    ...
});
```

RunStore.update 在一个事务中：

1. 读取当前 Run；
2. 检查状态机；
3. 用 `WHERE id=? AND status=previousStatus` 更新；
4. 插入 RunEvent。

第三步相当于简化的 compare-and-swap。若另一个写入已经改变状态，`changes !== 1`，
本次过期更新失败，不会覆盖新状态。

### 15.3 必须先订阅再 start

```ts
const unsubscribe = this.subscribeToRuntime(runId);
try {
    await this.runtime.start(request);
} finally {
    unsubscribe();
}
```

Fake Runtime 或某些 SDK 可能在 start Promise 返回前同步发出 `agent_started`。如果先
调用 start 再 subscribe，最早事件会永久丢失。

### 15.4 Runtime 请求只携带稳定引用

```ts
run: {
    runId,
    tenantId,
    harnessSessionId,
    workspacePath,
    templateVersionId,
    harnessInstanceId,
}
```

RunService 不直接传 Template 对象或 Policy；ManagedAgentRuntime 根据不可变 ID 从 Store
加载，以数据库事实为准。

### 15.5 start 抛错

如果 Adapter 在发出终态事件前抛错：

```ts
catch (error) {
    this.markRuntimeInvocationFailureInterrupted(
        runId,
        error,
        "START_FAILED",
    );
    throw error;
}
```

该方法先重新读取 Run。如果 Runtime 已经发出 agent_failed，Run 可能已经 FAILED，此时
不覆盖；只有仍在 RUNNING/WAITING_TOOL 时才写 INTERRUPTED。

---

## 第 16 章：RuntimeEventBridge 与去重

### 16.1 生命周期事件为何不由 Bridge 保存

`agent_completed` 不只是生成事件，还要改变 Run 快照，所以由 RunService 在一个事务中
完成 `Run → COMPLETED + RUN_COMPLETED`。Bridge 对生命周期返回 null。

### 16.2 text_delta 为什么不持久化

逐 token/文本增量量大且主要服务实时 UI；当前项目保存模型调用边界和最终 usage，不把
每个 delta 变成数据库事件。

### 16.3 模型和工具边界生成稳定 dedupeKey

```ts
model started   → model:${modelCallId}:started
model completed → model:${modelCallId}:finished
tool started    → tool:${toolCallId}:started
tool success/fail → tool:${toolCallId}:finished
```

工具成功和失败共享 finished key，因为同一个工具调用只能有一个被接受的终态。如果
Runtime 错误地先发成功、后发失败，第二个被去重。

### 16.4 appendEventIfNew 只吞目标冲突

实现不是捕获任意 SQLite 错误后返回 false。它在失败后查询相同 runId+dedupeKey 是否
存在；存在才判断为重复，否则重新抛出。这样 sequence 冲突、eventId 冲突或外键错误
不会被误装成正常重复投递。

### 16.5 sequence 的意义

同一毫秒可能产生多个事件，timestamp 不能定义稳定顺序；每个 Run 内 sequence 才是
时间线排序依据。`nextEventSequence` 只在插入成功后递增，重复事件不会制造序号空洞。

# 第六部分：SQLite、事务和证据模型

## 第 17 章：为什么选择“当前快照 + 追加事件”

数据库同时保存：

```text
agent_runs  = 当前状态快照
run_events = 追加式历史
```

只保存快照的问题：知道现在 FAILED，但不知道经过了哪些工具、为什么失败。

只保存事件的问题：每次查询状态都需要完整重放，并且早期实现复杂度显著增加。

当前方案是一种务实的双模型：写入时原子保持一致，读取当前状态高效，历史仍可审计。

### 17.1 RunStore.update 的完整保护链

```ts
const transaction = db.transaction(() => {
    const currentRun = this.get(run.id);
    assertValidTransition(currentRun.status, run.status);

    const result = UPDATE agent_runs
        ...
        WHERE id = $id
          AND status = $previousStatus;

    if (result.changes !== 1) {
        throw new Error("状态已被其他写入修改");
    }

    this.insertEvent(event);
});
```

四层保护分别是：

1. 找不到 Run：身份错误；
2. `assertValidTransition`：领域状态机错误；
3. WHERE previousStatus：并发过期写；
4. transaction：快照与事件原子性。

### 17.2 一个具体并发例子

初始 Run=RUNNING。两个异步事件几乎同时到达：

```text
处理 A 想写 COMPLETED
处理 B 想写 FAILED
```

二者都可能先读取到 RUNNING，但 SQLite UPDATE 是串行执行的：

```text
A: WHERE status=RUNNING → changes=1，状态变 COMPLETED
B: WHERE status=RUNNING → changes=0，拒绝覆盖
```

没有 previousStatus 条件时，晚到的 B 可能把已完成 Run 改成 FAILED。

### 17.3 JSON 字段和 payloadVersion

SQLite 保存结构化但不需要独立查询的内容为 JSON：

```text
RunEvent.payload_json
TemplateVersion.spec_json
Policy layers/effective_json
Tool arguments/result_json
```

`CHECK(json_valid(...))` 防止无效 JSON 入库。RunEvent 额外有 payloadVersion，使未来代码
可以按版本解析旧数据，而不是假设所有历史事件都使用最新版结构。

### 17.4 migration 为什么整体事务化

`runMigrations` 先读取最高版本，再把所有 pending migration 和 schema_migrations 账本
写入同一个事务。中途 DDL 失败时不留下“表建了一半但版本已经升级”的数据库。

当前关键版本：

| Version | 建立的主要能力 |
| --- | --- |
| v1 | AgentRun、RunEvent |
| v2 | RunEvent dedupe_key 和部分唯一索引 |
| v3 | ToolExecution、Checkpoint |
| v4 | 资源快照、策略决定 |
| v5 | HarnessTemplate 与不可变版本 |
| v6 | Capability、Instance、Session、Attempt |
| v7 | EffectivePolicy、Compilation、ToolDecision、Sandbox |

---

# 第七部分：ToolGateway、Checkpoint 与副作用安全

## 第 18 章：为什么工具执行是最危险的边界

模型调用失败通常可以重试；工具可能已经产生不可逆副作用：

```text
发邮件
创建订单
覆盖文件
执行部署
```

最危险的崩溃窗口是：

```text
真实工具已经成功
→ 进程在保存结果前崩溃
→ 重启后不知道副作用是否发生
→ 盲目重试可能执行两次
```

所以 ToolGateway 不是普通日志包装器，而是恢复安全边界。

## 第 19 章：ToolEffect 分类

```ts
type ToolEffect =
    | "READ_ONLY"
    | "IDEMPOTENT_WRITE"
    | "UNKNOWN_EFFECT";
```

含义：

- READ_ONLY：重复执行不产生外部状态变化；
- IDEMPOTENT_WRITE：为未来“带可验证幂等证据的写入”预留的分类；
- UNKNOWN_EFFECT：不能证明安全，必须保守处理。

Pi 默认映射：

```text
read/grep/find/ls → READ_ONLY
bash/edit/write   → UNKNOWN_EFFECT
```

不能因为某个 write “通常覆盖成相同内容”就自动标记幂等；幂等需要工具合同证明。
而且当前 `canAutomaticallyReplay()` 即使遇到 `IDEMPOTENT_WRITE` 也返回 false，因为
ToolExecution 尚未保存和校验 idempotency key。当前唯一自动重放类别是 READ_ONLY。

## 第 20 章：Pi 工具如何被 Gateway 包裹

`createGatewayPiTools` 创建 Pi 原生 ToolDefinition，然后只替换 execute：

```ts
return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
        return gateway.execute(
            {
                runId,
                toolCallId,
                toolName: definition.name,
                arguments: params,
                effect,
                runtimeSessionRef,
                lastEventSequence,
                policySnapshotId,
                workspacePath,
            },
            () => definition.execute(
                toolCallId,
                params,
                signal,
                onUpdate,
                context,
            ),
        );
    },
};
```

保留 schema、描述、渲染和原始实现，只在真实 execute 外增加控制面。这减少对 Pi SDK
行为的复制。

## 第 21 章：ToolGateway.execute 的四种入口状态

正式 Stage 2 路径先执行 PolicyGuard；这里先聚焦 Stage 0 幂等逻辑。

### 21.1 没有历史记录

创建：

```ts
{
    status: "PREPARED",
    result: null,
    errorMessage: null,
    finishedAt: null,
}
```

必须在真实工具之前保存。PREPARED 的语义是：

> 控制面已经决定尝试该工具，但当前无法证明真实执行是否完成。

### 21.2 历史 SUCCEEDED

直接返回 `history.result`，不再次调用真实工具。这是 toolCallId 级结果复用。

### 21.3 历史 FAILED

返回确定失败，不自动执行第二次。重试是否允许应是更高层显式策略，而不是 Store 的
隐含行为。

### 21.4 历史 PREPARED

```ts
if (!canAutomaticallyReplay(status, effect)) {
    throw new Error(`不允许自动重放：${effect}`);
}
```

当前只有 READ_ONLY 可以重放；IDEMPOTENT_WRITE 和 UNKNOWN_EFFECT 都停止。前者要等
ToolExecution 增加真实幂等键证据后才能开放，不能仅凭枚举名称放行。

## 第 22 章：工具成功为什么需要三写事务

`completeWithCheckpoint` 在一个事务里：

```text
1. ToolExecution PREPARED → SUCCEEDED + result
2. INSERT Checkpoint
3. UPDATE AgentRun.checkpoint_id
```

三个写入的语义是一个整体：

> 工具结果已确定，并且 Harness 有一个对应到该结果之后的恢复点，Run 已指向它。

如果只成功一部分：

| 不一致 | 恢复风险 |
| --- | --- |
| Tool SUCCEEDED，没有 Checkpoint | 知道副作用成功但无法定位安全会话位置 |
| Checkpoint 有，Run 仍指向旧值 | 恢复丢失最新安全边界 |
| Run 指向 Checkpoint，但 Tool 仍 PREPARED | 恢复判断认为副作用不确定 |

事务失败会回滚全部写入。

### 22.1 条件更新保护晚到结果

```sql
UPDATE tool_executions
SET status = 'SUCCEEDED', ...
WHERE id = $id
  AND run_id = $runId
  AND status = 'PREPARED';
```

如果另一个路径已把它完成，changes=0，晚到结果不能覆盖确定终态。

## 第 23 章：崩溃窗口表

| 崩溃位置 | 数据库状态 | 恢复判断 |
| --- | --- | --- |
| PREPARED 之前 | 无 ToolExecution | 工具未获执行许可，可重新由 Runtime 请求 |
| PREPARED 之后、真实调用之前 | PREPARED | READ_ONLY 可重放，UNKNOWN_EFFECT 人工检查 |
| 真实调用期间 | PREPARED | 无法确定是否有副作用，按 effect 处理 |
| 真实成功后、事务提交前 | PREPARED | 同上，这是无法完全消除的经典窗口 |
| 成功事务提交后 | SUCCEEDED + Checkpoint + Run 引用 | 复用结果并从最新安全点恢复 |

这个 MVP 没有提供分布式 exactly-once。它提供的是：明确记录不确定性，并在不能证明
安全时停止自动执行。

---

# 第八部分：进程重启与恢复

## 第 24 章：为什么旧 RUNNING 不能继续当 RUNNING

进程重启后，数据库可能仍有 RUNNING/WAITING_TOOL，但内存中的：

- Pi AgentSession；
- Runtime subscription；
- Scheduler slot；
- Sandbox Handle；

都已经消失。因此数据库 RUNNING 是过期快照。启动扫描首先把它改成 INTERRUPTED，再
决定能否恢复。

## 第 25 章：RecoveryService 只建立计划

```ts
scanInterruptedRuns(): RunRecoveryPlan[] {
    return this.runStore
        .listActiveRuns()
        .map((activeRun) => this.buildPlan(activeRun));
}
```

对每个旧 active Run：

1. 查找该 Run 的 PREPARED tools；
2. 校验 Run.checkpointId 对应的 Checkpoint 存在且属于该 Run；
3. 调用纯函数 decideRecovery；
4. 原子写 Run → INTERRUPTED + RUN_INTERRUPTED(PROCESS_RESTART)；
5. 返回计划，不直接调用 Runtime。

扫描和外部执行分开，确保数据库修正是同步确定性的；一个 Runtime 恢复失败不会阻止
其他 Run 被正确标记。

## 第 26 章：decideRecovery 的真值表

| Checkpoint | PREPARED 工具 | 决定 |
| --- | --- | --- |
| 无 | 任意 | MANUAL_REVIEW / NO_CHECKPOINT |
| 有 | 无 | AUTO_RESUME / SAFE_CHECKPOINT |
| 有 | 全部可重放（当前即全部 PREPARED 都是 READ_ONLY） | AUTO_RESUME / SAFE_CHECKPOINT |
| 有 | 任一 UNKNOWN_EFFECT | MANUAL_REVIEW / UNSAFE_TOOL_EFFECT |

Checkpoint 是必要条件但不是充分条件。即使有 Checkpoint，如果之后存在不确定副作用，
恢复也可能重复执行该工具。

## 第 27 章：RecoveryExecutor 为什么逐个隔离错误

Executor 遍历计划：

- MANUAL_REVIEW：记录结果，不调用 Coordinator；
- AUTO_RESUME 但 Checkpoint 意外为空：记录 FAILED；
- 合法：`coordinator.submitResume()`；
- 某个提交抛错：捕获到该 Run 的结果，不阻止后续 Run。

恢复任务进入 QUEUED，不直接 resume。随后 QueuePump 让它重新经过资源准入和 slot。

## 第 28 章：启动恢复顺序

```text
1. QueuedRunRestorer 恢复数据库中原有 QUEUED Run 到内存 Scheduler
2. RecoveryService 扫描旧 RUNNING/WAITING_TOOL
3. RecoveryExecutor 把可恢复 Run 变成 QUEUED 并入 Scheduler
4. HarnessApplication 启动 QueuePump
5. 普通任务和恢复任务共同接受资源准入
6. 之后才开放 HTTP
```

这条顺序确保重启不会丢队列，也不会让恢复绕过背压。

---

# 第九部分：Stage 1 领域控制面

## 第 29 章：为什么 Stage 0 的 Run 不足以描述执行环境

Stage 0 Run 知道 tenant、session、workspace 和任务，但不能回答：

- 使用哪一版模型/工具/Skill 配置？
- 在哪个受管执行环境运行？
- Runtime 部署真实支持哪些保证？
- 第一次 start 和第二次 resume 是否使用相同环境？
- 某次失败对应哪个策略与 Sandbox？

Stage 1 增加 TemplateVersion、Instance、CapabilityProfile、Session 和 Attempt 来回答。

## 第 30 章：Template 与 TemplateVersion

```text
HarnessTemplate = 稳定身份和 Tenant 归属
TemplateVersion = 已发布、不可变的具体执行期望
```

Pi spec 包含：

```ts
{
    runtimeKind: "PI",
    provider: "local-vllm",
    modelId: "qwen3.5-9b",
    tools: ["read", "write", "bash"],
    skills: [],
    requiredCapabilities: [...],
    optionalCapabilities: [...],
}
```

为什么分身份与版本？如果直接修改 Template 行，排队 Run 在提交时看到旧配置、执行时
可能读到新配置，历史也无法证明用过什么。

版本 Store 强制：

- 首版必须为 1；
- 后续严格连续；
- 版本属于目标 Template；
- `(template_id, version)` 唯一；
- 不提供 update version。

`Object.freeze` 和数组防御性复制保护进程内不变性，SQLite 唯一约束保护持久化不变性。

## 第 31 章：CapabilityProfile

Profile 描述 `Runtime + deployment` 的真实能力，不是用户期望。Template 的 required/
optional 描述本次配置需要什么。执行前做集合差：

```text
missingRequired = required - supported
missingOptional = optional - supported
```

结果：

```text
missingRequired 非空 → REJECTED
missingRequired 空、missingOptional 非空 → DEGRADED
全部满足 → APPLIED
```

当前 Pi 明确不声明 SESSION_FORK、CROSS_HOST_RESUME、NATIVE_SANDBOX 和完整 RAW events。

## 第 32 章：HarnessInstance

Instance 绑定：

```text
Tenant
+ TemplateVersion
+ CapabilityProfile
+ RuntimeKind
+ desired/actual lifecycle
```

desired 与 actual 分开是控制面的基本模式：期望 RUNNING 时，实际可能仍 PROVISIONING
或已经 FAILED。

状态机：

```text
PROVISIONING → READY → ACTIVE → READY
       ↓          ↓        ↓
     FAILED     FAILED   FAILED
```

FAILED 必须有 failureReason，其他状态必须没有，避免矛盾快照。

## 第 33 章：HarnessSession

HarnessSession 是控制面关系，不等于 Pi AgentSession 内存对象：

```ts
{
    id: "session-42",
    tenantId: "tenant-a",
    instanceId: "instance-a",
    runtimeSessionRef: null | "/path/to/pi/session",
}
```

首次 `agent_started/agent_resumed` 后绑定 runtimeSessionRef。数据库保存可重开引用，而
不是不可序列化的 SDK 对象。

## 第 34 章：RunAttempt

Run 是逻辑任务，Attempt 是一次真实 start/resume：

```text
Run run-100
  Attempt 1 START  → INTERRUPTED
  Attempt 2 RESUME → SUCCEEDED
```

每个 Attempt 固定：Instance、TemplateVersion、CapabilityProfile、PolicySnapshot、
Sandbox。旧 Attempt 不覆盖，才能比较每次真实执行。

状态：

```text
PENDING → REJECTED
PENDING → FAILED
PENDING → RUNNING → SUCCEEDED/FAILED/INTERRUPTED
```

REJECTED 表示执行前控制面明确不允许；FAILED 表示准备或执行发生错误。

## 第 35 章：DefaultPiControlPlane 的兼容策略

旧 API 没有 templateId/instanceId。Resolver 按 Tenant 懒创建稳定默认对象：

```text
default-pi-template:${tenant}
default-pi-template-version:${tenant}:1
default-pi-instance:${tenant}
```

然后验证相同 sessionId 不得跨 Tenant/Instance 使用，最终返回版本和 Instance 绑定。

这个类是迁移桥：它让旧 API 创建的新 Run 真实进入新模型，但不等于未来完整模板管理
API。关键是解析发生在 Run 创建时，所以排队后发布 v2 不影响已固定的 v1。

# 第十部分：Stage 2 五层策略

## 第 36 章：策略层与配置字段不是同一件事

Template spec 说“这个模板配置了哪些工具”；Tenant policy 说“这个 Tenant 最多允许
哪些工具”；Workspace policy 说“本次目录边界在哪里”。它们不能互相覆盖，只能求交：

```text
Platform ∩ Tenant ∩ Template ∩ Workspace ∩ Run
```

五层分别回答：

| Layer | 控制主体 | 典型约束 |
| --- | --- | --- |
| PLATFORM | 平台运维者 | 全局禁用危险模型、网络、Secret |
| TENANT | 租户管理员 | Tenant 可用 Tool/Skill/预算 |
| TEMPLATE | 已发布配置 | 本模板实际声明的 Model/Tool/Skill |
| WORKSPACE | 任务目录 | 文件根路径 |
| RUN | 单次调用方 | 本次进一步收紧的临时权限 |

### 36.1 null 与空数组

这是策略实现中必须牢牢记住的区别：

```text
allowedTools = null  → 本层不额外限制
allowedTools = []    → 本层明确禁止所有 Tool
```

`unrestrictedPolicy` 的集合字段为 null、布尔为 true、资源上限为 null。

### 36.2 为什么必须存在全部五层

即使 Platform 当前不限制，也必须传入 PLATFORM unrestricted layer。否则无法区分：

```text
确实加载过平台策略且无限制
vs
程序忘记加载平台策略
```

`computeEffectivePolicy` 缺任一 kind 直接抛错。

## 第 37 章：交集算法细节

### 37.1 集合

```ts
if (left === null) return right;
if (right === null) return left;
return left.filter((item) => rightSet.has(item));
```

一层 unrestricted 不改变另一层；两个具体集合只保留共同值。

### 37.2 布尔权限

```ts
allowNetwork = left.allowNetwork && right.allowNetwork
allowProcess = left.allowProcess && right.allowProcess
```

任一上游拒绝，下游不能重新打开。

### 37.3 数值预算

```ts
minimum(null, 4) = 4
minimum(8, null) = 8
minimum(8, 4) = 4
```

null 表示无额外上限；最终取最严格非空上限。

### 37.4 Workspace roots

两个根目录相交时保留更窄的包含路径：

```text
/workspaces
∩ /workspaces/project-a
= /workspaces/project-a
```

完全不相交得到空数组，随后 Sandbox workspace 校验拒绝。

`isWithin` 使用绝对路径和 `${root}${sep}`，避免：

```text
root=/tmp/work
path=/tmp/work-evil
```

被字符串前缀误判为子目录。

## 第 38 章：EffectivePolicySnapshot 的审计语义

Snapshot 同时保存：

```text
五层原始输入 layers_json
+ 交集结果 effective_json
+ runId / tenantId / templateVersionId
+ createdAt
```

Store 读取时重新计算五层交集并与保存结果比较，用于发现证据不一致。Snapshot 不在
执行中途随 Registry 变化；一次 Attempt 始终使用创建时的不可变结果。

## 第 39 章：Pi Policy Compiler

抽象策略必须转为 Runtime 能消费的配置：

```ts
interface PiCompiledPolicy {
    runtimeKind: "PI";
    provider: string;
    modelId: string;
    tools: readonly string[];
    skills: readonly string[];
    policySnapshotId: string;
}
```

### 39.1 Model

模板确定实际模型 `${provider}/${modelId}`。如果有效 allowlist 非 null 且不包含它，
Compiler 抛错；它不会静默换成另一个模型，因为模型替换可能改变行为和成本。

### 39.2 Tool/Skill

Compiler 保留 Template 原始顺序，但只保留 Effective allowlist 中存在的值：

```text
Template tools = [read, write, bash]
Effective      = [read, write]
Compiled       = [read, write]
```

Template 是实际可配置集合，Policy 是最大许可；Policy 中即使额外包含 deploy，模板没有
声明也不会凭空启用。

### 39.3 Compilation Record

```text
APPLIED  = required 全满足，编译成功，无降级
DEGRADED = 编译成功，但 optional capability 缺失
REJECTED = required 缺失或模型被策略拒绝
```

保存 compiled JSON 和 reasons，使“允许但降级”也能解释。

---

# 第十一部分：ManagedAgentRuntime 完整调用栈

## 第 40 章：它为什么是核心编排器

结构：

```text
RunService
  → ManagedAgentRuntime
      → inner AgentRuntime
          → PiAdapter
```

RunService 只理解通用 AgentRuntime；ManagedRuntime 把 Template、Capability、Policy、
Attempt 和 Sandbox 包在任意具体 Adapter 外层。PiAdapter 不需要知道 Tenant 策略来源。

## 第 41 章：start/resume 的兼容分流

```ts
if (!hasControlBinding(request)) return this.inner.start(request);
return this.execute("START", request, invokeInner);
```

只有完全没有 Stage 1 引用的旧直接 Runtime 测试才透传。只提供其中一个引用时
`hasControlBinding=true`，execute 随后因引用不完整拒绝，避免半受管状态。

## 第 42 章：执行前引用校验

按 Run 固定 ID 加载 TemplateVersion、Instance、Session 和 CapabilityProfile，然后检查：

```text
instance.tenantId == run.tenantId
instance.templateVersionId == run.templateVersionId
session.tenantId == run.tenantId
session.instanceId == instance.id
profile.id == instance.capabilityProfileId（通过查找建立）
```

这是一道服务层 Tenant 完整性校验。数据库外键能证明 ID 存在，却不能自动证明多个表
中的 tenantId 都相同。

## 第 43 章：Snapshot 和 Attempt 的精确顺序

```text
1. 计算五层 Snapshot
2. 持久化 Snapshot
3. 创建 PENDING Attempt，并立即绑定 Snapshot ID
4. 持久化 Attempt
5. 才进行 Capability 和 Compiler 检查
```

为什么被拒绝前也要 Snapshot 和 Attempt？因为“控制面基于什么策略拒绝了哪次尝试”
本身就是必须保留的执行事实。

## 第 44 章：所有前置分支

### 44.1 required capability 缺失

```text
Compilation REJECTED + reason
Attempt PENDING → REJECTED + reason
不创建 Sandbox
不调用 inner Runtime
抛错给 RunService
RunService 将 RUNNING Run → INTERRUPTED(START_FAILED/RESUME_FAILED)
```

### 44.2 Model policy 拒绝

与能力拒绝相同，只是 reason 来自 Compiler。

### 44.3 optional capability 缺失

```text
Compilation DEGRADED + reasons
继续创建 Sandbox
继续执行 Runtime
```

### 44.4 Sandbox create 失败

```text
Compilation 已 APPLIED/DEGRADED
Attempt PENDING → FAILED + provider reason
没有 sandboxId
不调用 inner Runtime
错误交给 RunService，Run → INTERRUPTED
```

Compilation APPLIED 只表示 Runtime 配置编译成功，不表示 Sandbox 准备成功；两条证据
描述不同阶段。

## 第 45 章：进入实际运行

Sandbox 成功后：

```text
Attempt PENDING → RUNNING，写 sandboxId
Instance READY → ACTIVE
activeBySandboxId[sandboxId] = {attemptId, instanceId}
```

随后构建 RuntimeExecutionContext：

```ts
execution: {
    attemptId,
    policySnapshotId,
    sandboxId,
    runtimeConfig: compiled,
}
```

这个 context 是控制面输出给 Adapter 的“本次执行授权包”。Adapter 消费编译结果，
不能重新读取 Registry 并自行放宽。

## 第 46 章：为什么有两套订阅

RunService 通过 `ManagedAgentRuntime.subscribe` 订阅，负责：

- Run 状态；
- RunEvent；
- 模型/工具审计事件。

ManagedRuntime 在 execute 内另外订阅 inner，负责：

- 绑定 HarnessSession.runtimeSessionRef；
- 捕获 Attempt 终态。

同一个 RuntimeEvent 被不同职责的消费者观察，但它们更新不同状态聚合，避免一个巨型
类拥有所有写权限。

监听器具体先后不属于公共合同；最终一致性依靠状态机和幂等判断。

## 第 47 章：正常返回和异常

如果 inner 发出 agent_completed 并正常返回：

```text
RunService: Run → COMPLETED
Managed: terminal=SUCCEEDED
inner Promise 返回
Managed: Attempt → SUCCEEDED
finally: Sandbox → TERMINATED
finally: Instance ACTIVE → READY
```

如果 inner 抛错且 Attempt 仍 RUNNING：Attempt → FAILED；RunService 根据是否已有 Runtime
终态决定保留 FAILED 或改 INTERRUPTED。

## 第 48 章：Sandbox LOST

Provider 先把 Sandbox 行改为 LOST、删除 Secret，再发 LifecycleEvent。ManagedRuntime 用
`activeBySandboxId` 找到执行：

```text
Instance ACTIVE → FAILED(reason=SANDBOX_LOST:...)
Attempt RUNNING → INTERRUPTED
emit agent_interrupted 给 RunService
Run → INTERRUPTED
inner.interrupt(runId)
```

finally 中只有 current Instance 仍 ACTIVE 才恢复 READY，所以 FAILED 不会被清理逻辑
错误覆盖。

---

# 第十二部分：Tool Policy 强制点

## 第 49 章：Guard 为什么必须是 ToolGateway 的第一行

```ts
this.policyGuard?.assertAllowed(input);
const history = store.getByToolCall(...);
// PREPARED 和真实工具在后面
```

策略拒绝意味着“没有执行意图获准”，所以：

```text
ToolPolicyDecision = DENY
ToolExecution       = 不存在
真实 invoke         = 0 次
Checkpoint          = 不存在
```

如果先 PREPARED，再 DENY，恢复扫描会把纯授权拒绝误判成不确定副作用。

## 第 50 章：Snapshot 归属检查

Guard 不只按 ID 加载 Snapshot，还验证 `snapshot.runId === input.runId`。否则恶意或错误
调用方可以借用另一个 Run 的宽松策略。

## 第 51 章：工具检查顺序

```text
1. toolName 是否在 allowedTools
2. bash 是否能证明满足 process/network/workspace
3. path/filePath 是否在 workspaceRoots
4. 保存 ALLOW 或 DENY
5. DENY 抛错，ALLOW 返回 Gateway 主流程
```

当前 path 提取只识别参数对象中的 `path` 或 `filePath`。新增带其他路径字段的工具时，
必须扩展 Guard 或使用工具专属校验，不能假定自动受保护。

## 第 52 章：为什么 bash 特别保守

任意 shell 命令可以：

- 使用绝对路径；
- 通过 `cd` 越界；
- 启动子进程；
- 使用 curl/ssh 访问网络；
- 运行解释器间接执行任意操作。

ManagedLocal 没有 syscall/network namespace，因此只要存在 process 禁止、network 禁止
或 Workspace root 限制，就无法证明 bash 安全，直接拒绝。

---

# 第十三部分：Sandbox 与 Secret

## 第 53 章：SandboxProvider 合同

上层只依赖：

```text
create(policy, workspace, run, instance) → SandboxHandle
terminate(id)
subscribe(LOST/FAILED)
```

未来 Docker/Kubernetes/远程 Sandbox 可以替换 Provider，但 Attempt、Snapshot、Instance
和故障事件语义保持不变。

## 第 54 章：ManagedLocal 的真实保证

它提供：

- Workspace 起始路径校验；
- ToolGateway 协同的文件/进程/网络 fail-closed；
- PROVISIONING/ACTIVE/TERMINATED/LOST 证据；
- Secret 名称持久化、值仅内存、结束销毁；
- LOST 回调。

它不提供：

- chroot/mount namespace；
- 网络 namespace；
- cgroup CPU/内存限制；
- 磁盘 quota；
- 不受信代码的 Secret 防窃取。

所以有效策略包含任何 CPU/内存/磁盘硬限制时直接拒绝，不保存了配置却继续运行。

## 第 55 章：Secret 生命周期

```text
EffectivePolicy.allowedSecrets = [API_TOKEN]
→ SecretProvider.get(API_TOKEN)
→ 值保存到 private Map[sandboxId]
→ SandboxRecord 只写 secretNames=[API_TOKEN]
→ Handle.withSecrets(callback) 访问
→ terminate/lose 删除 Map
```

当前还没有把 `withSecrets` 接进 Pi 工具子进程，所以真实保证是“不落库 + 生命周期销毁
的访问边界”，不是完整进程级注入。回调也不能阻止受信任调用方把值复制出去。

未来正确方向是由强 Sandbox Provider 把 Secret 注入受控进程环境，仍然不把值放进
RunEvent、RuntimeExecutionContext 或普通日志。

---

# 第十四部分：PiAdapter 逐层翻译

## 第 56 章：Adapter 不负责策略决策

PiAdapter 的边界：

```text
Harness start/resume/interrupt → Pi SDK
Pi AgentSessionEvent → RuntimeEvent
```

它不读取 Tenant Policy，不写 SQLite，不创建 Attempt。这样未来另一个 Adapter 可以
复用 ManagedRuntime，而不复制控制面。

## 第 57 章：全局配置与本次编译配置

```ts
const config = request.execution?.runtimeConfig ?? this.config;
```

- 正式受管路径：使用 Policy Compiler 的本次配置；
- 旧直接测试：使用构造时全局配置。

模型通过 provider/modelId 从 `ModelRuntime` 查找；找不到立即抛错，不让 Pi 使用隐式
默认模型。

## 第 58 章：Session 创建

```ts
createAgentSession({
    cwd: workspacePath,
    modelRuntime,
    model,
    tools: [...config.tools],
    customTools: gatewayWrappedTools,
    sessionManager: SessionManager.create(workspacePath),
    resourceLoader: policyResourceLoader,
});
```

同名 custom tool 覆盖内置 execute，所以模型仍看到 read/write 等标准名称，真实调用
却经过 Gateway。

`session.sessionFile` 必须存在；它作为 runtimeSessionRef 进入 HarnessSession 和
Checkpoint。没有引用就 dispose 并拒绝，因为之后无法恢复。

## 第 59 章：Skill 落实

`DefaultResourceLoader` 使用：

```text
noSkills = allowlist 为空
skillsOverride = 只保留 name 在 allowlist 的 Skill
```

这证明 Skill 不是只在 Snapshot 中记录，而是影响 Pi 实际加载资源。

## 第 60 章：事件映射细节

| Pi Event | RuntimeEvent | 后续消费者 |
| --- | --- | --- |
| agent_start | agent_started/resumed | Session binding + Run 生命周期 |
| message_start assistant | model_started | RunEventBridge |
| text_delta | text_delta | 当前不持久化 |
| message_end assistant | model_completed + usage | RunEventBridge |
| tool_execution_start | tool_started | RunEventBridge |
| tool_execution_end | tool_completed | RunEventBridge |
| agent_end aborted | agent_interrupted | RunService + Attempt |
| agent_end error | agent_failed | RunService + Attempt |
| agent_end normal | agent_completed | RunService + Attempt |

`willRetry=true` 的 agent_end 不产生终态，因为 Pi 自己还会重试。

模型 duration 使用 message_start 时记录的本地时间；缺失时回退 Pi message timestamp。
usage 映射到 Harness 稳定字段，避免数据库 payload 直接依赖 SDK 类型名字。

## 第 61 章：清理

start/resume 的 finally 总是：

```text
unsubscribe Pi events
delete sessionsByRunId
session.dispose()
```

`interrupt(runId)` 查 Map 中当前 AgentSession 并调用 abort。没有 active Session 时抛错，
防止“中断成功”的虚假确认。

# 第十五部分：Composition Root 与完整对象图

## 第 62 章：为什么组装代码也是架构代码

`createHarnessApplication.ts` 决定真实主路径是否经过新对象。仅仅定义一个 Guard 或
ManagedRuntime 类不代表系统使用了它。

关键实例化顺序：

```text
Database
  → RunStore / ToolStore / TemplateStore / ...

EffectivePolicyStore
  → PersistentToolPolicyGuard
      → ToolGateway

ToolGateway + ModelRuntime
  → PiAdapter (baseRuntime)

baseRuntime + 所有控制面 Store + Sandbox
  → ManagedAgentRuntime (runtime)

Template/Instance/Session/Capability Stores
  → DefaultPiControlPlane

RunStore + ManagedAgentRuntime + DefaultPiControlPlane
  → RunService

RunService + Scheduler + Admission
  → RunQueueCoordinator

Coordinator + Pump + Recovery + query stores
  → HarnessApplication
```

三个最重要的连线断言：

```text
RunService.runtime === ManagedAgentRuntime，不是裸 PiAdapter
RunService.bindingResolver === DefaultPiControlPlane
PiAdapter.gateway === 带 PersistentToolPolicyGuard 的 ToolGateway
```

测试注入 FakeAgentRuntime 时，它只是替换 inner Runtime，仍被 ManagedRuntime 包裹。因此
Stage 1–2 e2e 无需真实模型也能验证控制面路径。

## 第 63 章：完整领域关系

```text
Tenant
  ├── HarnessTemplate
  │     └── HarnessTemplateVersion
  │             ├── PiTemplateSpec
  │             └── capability requirements
  │
  ├── HarnessInstance
  │     ├── templateVersionId
  │     └── capabilityProfileId ── RuntimeCapabilityProfile
  │
  └── HarnessSession
        ├── instanceId
        ├── runtimeSessionRef
        └── AgentRun
              ├── templateVersionId
              ├── harnessInstanceId
              ├── RunEvent[]
              ├── PolicyDecision[]（资源准入）
              ├── ToolExecution[]
              │      └── Checkpoint
              └── RunAttempt[]
                     ├── capabilityProfileId
                     ├── EffectivePolicySnapshot
                     │      ├── PolicyCompilation[]
                     │      └── ToolPolicyDecision[]
                     └── Sandbox
```

### 63.1 所有权与引用方向

TemplateVersion 不引用 Run，因为一个版本可被多个 Run 使用；Run 引用所用版本。
Checkpoint 引用 ToolExecution，因为它表示某个确定工具结果之后的安全点。Attempt 引用
Snapshot 和 Sandbox，因为它们属于一次真实执行，不属于逻辑 Run 的永久单值属性。

---

# 第十六部分：用贯穿案例重放完整成功路径

## 第 64 章：提交阶段的对象

输入：

```text
tenant-a / session-42 / /workspaces/project-a
```

ControlPlane 首次创建：

```text
CapabilityProfile:
  id = pi-capability:local-vllm/qwen3.5-9b
  supported = SESSION_CREATE, SESSION_RESUME, INTERRUPT, ...

TemplateVersion tpl-a-v1:
  model = local-vllm/qwen3.5-9b
  tools = read, write, bash

Instance instance-a:
  desired = RUNNING
  actual = READY

Session session-42:
  runtimeSessionRef = NULL
```

RunStore 事务创建：

```text
Run run-100 status=QUEUED
RunEvent #1 RUN_CREATED
```

Scheduler：

```text
tenantOrder=[tenant-a]
tenant-a queue=[run-100]
```

## 第 65 章：资源准入

假设 Snapshot：

```text
GPU used 20/48 GB = 41.7%
KV cache = 25%
running=0, waiting=0
```

Classifier：NORMAL/WITHIN_THRESHOLDS。

Policy：START/RESOURCE_NORMAL。

PolicyDecisionStore 原子保存 Snapshot + Decision。Run 已被 Scheduler claim，active Map
含 run-100。

## 第 66 章：受管 Runtime 准备

RunService 事务：

```text
Run QUEUED → RUNNING
RunEvent #2 RUN_STARTED
```

ManagedRuntime 加载引用并计算：

```text
Platform  unrestricted
Tenant    tools=[read]
Template  tools=[read,write,bash], model=[local-vllm/qwen3.5-9b]
Workspace roots=[/workspaces/project-a]
Run       unrestricted

Effective:
  tools=[read]
  model=[local-vllm/qwen3.5-9b]
  roots=[/workspaces/project-a]
```

保存：

```text
PolicySnapshot policy-100-1
Attempt attempt-100-1 status=PENDING, policy=policy-100-1
Compilation APPLIED, tools=[read]
Sandbox sandbox-100-1 ACTIVE
Attempt RUNNING, sandbox=sandbox-100-1
Instance ACTIVE
```

## 第 67 章：Pi 和工具

PiAdapter 得到：

```text
model local-vllm/qwen3.5-9b
tools [read]
skills []
policySnapshotId policy-100-1
```

Pi Session 创建后发 agent_started：

```text
HarnessSession.runtimeSessionRef = /.../session-xyz.jsonl
```

模型请求 read：

```text
ToolPolicyDecision ALLOW
ToolExecution PREPARED
真实 read 返回 README 内容
ToolExecution SUCCEEDED
Checkpoint checkpoint-1
Run.checkpointId = checkpoint-1
```

Pi 同时发 tool events，经 Bridge 形成 TOOL_STARTED/TOOL_COMPLETED RunEvents。注意
ToolExecution 是副作用恢复状态，RunEvent 是时间线事实；它们不是重复表。

## 第 68 章：完成与清理

Pi agent_end normal：

```text
RunService: Run → COMPLETED + RUN_COMPLETED
Managed: Attempt → SUCCEEDED
Sandbox → TERMINATED，Secret Map 删除
Instance → READY
Scheduler finally release run-100 slot
```

最终可查询：

```text
Run current state
ordered RunEvent timeline
resource Snapshot + START Decision
Effective Policy layers + result
Compilation APPLIED
Tool ALLOW Decision
ToolExecution result
Checkpoint
Attempt evidence
Sandbox lifecycle record
```

---

# 第十七部分：失败矩阵

## 第 69 章：每个失败点最终应留下什么

| 失败点 | Run | Attempt | Compilation | Sandbox | 真实 Runtime |
| --- | --- | --- | --- | --- | --- |
| 资源观测失败 | QUEUED | 无 | 无 | 无 | 未调用 |
| CRITICAL/UNKNOWN | QUEUED | 无 | 无 | 无 | 未调用 |
| 引用/Tenant 不一致 | INTERRUPTED | 可能无 | 无 | 无 | 未调用 |
| required capability 缺失 | INTERRUPTED | REJECTED | REJECTED | 无 | 未调用 |
| 模型不允许 | INTERRUPTED | REJECTED | REJECTED | 无 | 未调用 |
| Sandbox 不支持硬限制 | INTERRUPTED | FAILED | APPLIED/DEGRADED | 当前无持久 Sandbox 行 | 未调用 |
| Pi 模型找不到/Session 创建失败 | INTERRUPTED 或 FAILED，取决于事件 | FAILED | APPLIED/DEGRADED | TERMINATED | 调用失败 |
| 工具 Policy DENY | Run 可继续或由 Pi 决定终态 | RUNNING | APPLIED | ACTIVE | 工具 invoke=0 |
| 工具真实失败 | 最终由 Pi 事件决定 | RUNNING/FAILED | APPLIED | ACTIVE | ToolExecution FAILED |
| Sandbox LOST | INTERRUPTED | INTERRUPTED | APPLIED/DEGRADED | LOST | interrupt |
| 正常完成 | COMPLETED | SUCCEEDED | APPLIED/DEGRADED | TERMINATED | 完成 |

### 69.1 为什么有些 Run 是 INTERRUPTED 而不是 FAILED

RunService 将“Runtime 调用没有形成确定终态”视为 INTERRUPTED，为恢复或人工检查保留
入口。Attempt 提供更具体的 REJECTED/FAILED。两个状态属于不同聚合，不能只看 Run
判断前置失败类型。

### 69.2 当前一个值得继续改进的证据点

ManagedLocal 在检查到硬资源限制时，在创建 SandboxRecord 之前抛错，所以 Attempt 有
FAILED reason，但没有 `sandboxId → FAILED SandboxRecord`。当前仍可解释，但未来 Provider
可以先创建 PROVISIONING 行，再以 FAILED 收敛，增强 Sandbox 级审计。

---

# 第十八部分：测试是可执行规格

## 第 70 章：测试金字塔

```text
纯函数单元测试
  状态机、分类、策略交集、恢复决定

Store 测试
  SQL 映射、事务回滚、条件更新、迁移

组件测试
  RunService、Coordinator、ToolGateway、Application

端到端测试
  完整 Composition + Fake 外部依赖

进程/HTTP smoke
  Bun Server 生命周期与真实端口
```

Fake 不等于“假装成功”。它隔离不可控外部系统，让状态机和故障分支确定性重现。

## 第 71 章：核心测试文件阅读地图

### 71.1 Run 和事件

| 文件 | 重点 |
| --- | --- |
| `runs/run-state-machine.test.ts` | 合法/非法转换 |
| `runs/runstore.test.ts` | Run+Event 事务、去重、回滚 |
| `runs/run-service.test.ts` | start/resume/interrupt、事件终态 |
| `events/runtime-event-bridge.test.ts` | 事件映射与 dedupeKey |

### 71.2 工具与恢复

| 文件 | 重点 |
| --- | --- |
| `tools/tool-execution-store.test.ts` | PREPARED、三写事务、回滚 |
| `tools/tool-gateway.test.ts` | 复用、重放、未知副作用拒绝 |
| `checkpoints/recovery-decision.test.ts` | 恢复真值表 |
| `checkpoints/recovery-service.test.ts` | 重启扫描和计划 |
| `integration/day7-recovery-resource.e2e.test.ts` | 恢复重新经过资源队列 |

### 71.3 资源和调度

| 文件 | 重点 |
| --- | --- |
| `resources/vllm-resource-observer.test.ts` | 双来源降级、counter rate |
| `resources/resource-classifier.test.ts` | 阈值边界和多原因 |
| `resources/execution-policy.test.ts` | 压力决策表 |
| `scheduling/tenant-run-scheduler.test.ts` | round-robin 和 slot |
| `scheduling/run-queue-coordinator.test.ts` | release、single-flight、故障隔离 |

### 71.4 Stage 1–2

| 文件 | 重点 |
| --- | --- |
| `templates/*` | 不可变版本和 Store |
| `runtime/runtime-capability.test.ts` | required/optional |
| `instances/harness-instance.test.ts` | Instance 生命周期 |
| `runs/run-attempt.test.ts` | Attempt 证据和终态 |
| `policies/effective-policy.test.ts` | 五层数学 |
| `policies/policy-compilation.test.ts` | Tool/Skill/Model 编译 |
| `sandbox/managed-local-sandbox.test.ts` | Secret 与 hard-limit 拒绝 |
| `integration/stage1-stage2-control-plane.e2e.test.ts` | 新对象进入真实主路径 |

## 第 72 章：如何阅读一个测试

不要只看 `expect(status).toBe(...)`。按四列记录：

```text
Arrange：构造了什么旧状态和外部事实？
Act：调用了哪个公开入口？
Assert：检查了哪些状态、事件和副作用次数？
Property：这些断言共同证明什么系统性质？
```

例如“拒绝 write”测试的 Property 不是“抛了一个错误”，而是：

```text
授权决定持久化
+ invoke 次数为 0
+ PREPARED 不存在
= 被拒绝调用没有真实副作用，也不会污染恢复证据
```

---

# 第十九部分：调试课

## 第 73 章：Run 一直 QUEUED 怎么查

顺序不要乱：

1. `agent_runs.status` 是否 QUEUED；
2. Application 是否 started；
3. `scheduler.listQueue()` 是否包含 Run；
4. capacity 是否已有 slot 泄漏；
5. 最新 PolicyDecision action/reason；
6. ResourceObservation 是否失败；
7. QueuePump 是否继续 tick；
8. Coordinator 是否有未清理 drainPromise。

常见原因映射：

```text
RESOURCE_CRITICAL → 等资源恢复
RESOURCE_UNKNOWN → 指标全部缺失
OBSERVATION_FAILED → 查 vLLM/nvidia 探针
GLOBAL_CONCURRENCY_LIMIT → 查 active slot 是否正常 release
队列中无 Run但数据库 QUEUED → 启动恢复/入队窗口问题
```

## 第 74 章：Run INTERRUPTED 怎么查

先看最后一个 RUN_INTERRUPTED payload：

```text
USER_REQUEST
RUNTIME_INTERRUPTED
START_FAILED
RESUME_FAILED
PROCESS_RESTART
```

然后查最新 Attempt：

```text
REJECTED → 看 Compilation reasons/Capability
FAILED + sandboxId null → 看 Sandbox create/provider
FAILED + sandboxId 有 → 看 Runtime error
INTERRUPTED → 看 Sandbox LOST 或 Runtime abort
```

再查是否有 Checkpoint 和 PREPARED UNKNOWN_EFFECT 工具，判断能否恢复。

## 第 75 章：工具好像执行了两次怎么查

1. 比较两次 Runtime 事件的 toolCallId；
2. 查 `(run_id, tool_call_id)` 是否只有一条 ToolExecution；
3. 查第一次状态是 SUCCEEDED 还是 PREPARED；
4. 如果 PREPARED，确认 effect 是否 READ_ONLY；
5. 检查 Runtime 是否为重试生成了新 toolCallId；
6. 检查调用是否绕过 Pi Gateway wrapper。

Gateway 的幂等单位是 `runId + stable toolCallId`。如果 Runtime 重试时生成全新 ID，
控制面不能凭参数相同安全猜测是同一次副作用。

## 第 76 章：策略看起来没有生效怎么查

沿执行链逐层检查：

```text
PolicyRegistry 中的 layer
→ EffectivePolicySnapshot.layers_json
→ effective_json
→ PolicyCompilation.compiled_json
→ RuntimeStartRequest.execution.runtimeConfig
→ PiAdapter createAgentSession tools/resourceLoader
→ ToolGateway input.policySnapshotId
→ ToolPolicyDecision
```

任何一层断链都能定位。不要只看 Registry 配置然后断言 Runtime 已受限。

## 第 77 章：Sandbox LOST 后 Instance 为什么仍 ACTIVE

检查：

1. Provider 是否先持久化 LOST；
2. `ManagedAgentRuntime` 是否订阅该 Provider；
3. activeBySandboxId 中是否存在 ID；
4. 失联是否发生在 Attempt 进入 RUNNING 之前；
5. Instance Store 条件更新是否失败；
6. finally 是否错误覆盖 FAILED（当前代码有 ACTIVE 条件保护）。

---

# 第二十部分：如何安全修改项目

## 第 78 章：修改领域状态时

增加一个状态不能只改 union type。至少检查：

```text
领域状态机
SQLite CHECK constraint / migration
Store row type
所有 exhaustive switch
恢复扫描条件
HTTP 序列化
单元测试和 e2e
```

## 第 79 章：增加一种 RuntimeEvent 时

检查：

```text
AgentRuntime union
PiAdapter 映射或显式忽略
RuntimeEventBridge 映射/忽略
dedupeKey 语义
RunEventType
payloadVersion
测试 unknown-event exhaustive guard
```

`never` 参数让 TypeScript 在 union 扩展后迫使开发者决定新事件如何处理。

## 第 80 章：增加一个 Tool 时

不能只加入 PI_TOOLS：

```text
PiBuiltInToolName / ToolDefinition factory
ToolEffect 分类
路径参数的策略校验
是否可能访问网络/启动进程
恢复幂等合同
Template/Policy allowlist
Gateway wrapper 测试
拒绝零副作用测试
```

## 第 81 章：增加一个 Sandbox Provider 时

必须证明：

- create 返回前环境真实可用；
- terminate 幂等；
- LOST/FAILED 事件稳定；
- Workspace 约束真实落实；
- process/network/resource limits 不是假配置；
- Secret 不落控制面日志/数据库；
- 故障使 Instance/Attempt/Run 收敛；
- Provider 重启后如何发现遗留环境。

## 第 82 章：增加 Claude Adapter 时为什么不能复制 Pi 假设

Stage 3 要先列出 Claude 的真实能力差异，再映射：

```text
Session identity/lifecycle
resume/fork guarantee
permissions/hooks
native vs external sandbox
tool interception timing
usage/event completeness
interrupt semantics
```

不能为了适配当前接口而声称 Claude 与 Pi 完全相同。差异进入 CapabilityProfile 和
Runtime-specific Compiler。

---

# 第二十一部分：当前技术债与诚实边界

## 第 83 章：单进程队列

Scheduler 状态在内存，SQLite 只保存 QUEUED/Run facts。重启可重建，但多个 Worker
同时运行会各自拥有 slot 和队列，不能保证全局并发与不重复执行。进入多 Worker 前
需要持久 claim/lease 或外部协调存储。

## 第 84 章：PolicyRegistry 持久性

Registry 当前在进程内。历史 Effective Snapshot 已持久化，所以过去可解释；但策略
定义本身的管理、版本、重启加载和授权 API 尚未实现。

## 第 85 章：Sandbox 强度

ManagedLocal 主要证明控制面合同和 fail-closed 语义，不是生产隔离。受信代码仍与 Harness
同进程/宿主环境运行。Stage 2 完成不等于容器安全完成。

## 第 86 章：Secret 消费

Secret Handle 尚未接入实际 Pi 工具进程。当前测试证明值不落库和结束销毁；未来仍需
证明授权工具能使用、未授权工具拿不到、stdout/stderr 和异常不会泄漏。

## 第 87 章：恢复层次

当前恢复重点是 Checkpoint + ToolEffect。尚未完整区分：

```text
对话恢复
Workspace 恢复
Runtime 进程恢复
Sandbox 恢复
跨主机恢复
工具副作用恢复
```

Stage 4 才会基于 Capability 和故障类型深化恢复矩阵。

### 87.1 Default Instance 的并发假设

`DefaultPiControlPlane` 当前为每个 Tenant 创建一个固定 Instance，而 Instance 状态机只有
单值 `READY/ACTIVE`，没有 active attempt 计数。默认配置
`maxActiveRunsPerTenant=1` 与这个模型一致。

如果把单 Tenant 并发提高到 2，同一 Instance 的第二个 Run 可能尝试 `ACTIVE → ACTIVE`
并被状态机拒绝；即使允许该转换，第一个 Run 完成时也可能把仍承载第二个 Run 的
Instance 提前改回 READY。因此当前真实不变量是：

```text
一个 Default HarnessInstance 同时最多承载一个 active Attempt
```

未来需要选择其一：每个并发 Session/Run 创建独立 Instance，或把 Instance 生命周期
改成带 active lease/count 的模型。不能只提高 Scheduler 配置就宣称支持 Instance 并发。

### 87.2 Attempt 编号的单进程假设

`nextAttemptNumber()` 使用 `MAX(attempt_number)+1`，随后再 INSERT。当前同一 Run 不会在
单进程 Coordinator 中并发启动，所以成立；多 Worker 下两个进程可能同时算出相同编号，
最终由 UNIQUE 约束拒绝其中一个。分布式阶段需要事务内分配、Run 级 lease 或数据库序列。

### 87.3 ToolPolicyDecision 的唯一键限制

表当前使用 `UNIQUE(run_id, tool_call_id)`，Store 使用 `INSERT OR IGNORE`。它适合重复投递
同一次工具调用，但有一个细节：恢复 Attempt 若使用新的 PolicySnapshot 重放相同
toolCallId，新的 ALLOW/DENY Decision 会因唯一键被忽略。Guard 仍会执行新策略并可能
抛出 DENY，但数据库可能只保留旧 Snapshot 的第一次决定。

若未来允许跨 Attempt 策略变化，唯一键应至少包含 snapshot/attempt，或增加追加式
decision sequence，才能完整审计每次重新授权。

### 87.4 Policy 输入验证还不完整

当前交集代码会去重并冻结集合，但没有完整拒绝：

- 重复 Policy layer kind；
- 负数或非有限资源上限；
- 空 Tool/Skill/Secret 名称；
- 语义重复但路径写法不同的所有情况。

五层“至少各一层”已校验，但还不是完整 Policy schema validator。未来开放外部 Policy
API 前必须在领域入口补验证，不能只依赖 TypeScript 类型，因为 HTTP/JSON 不受编译器保护。

### 87.5 当前 HTTP 暴露范围

`StartRunInput` 在代码层支持 `runPolicy`，但当前 `POST /runs` 只解析 Tenant、Session、
输入和 Workspace；没有 Template、Policy 或 Sandbox 管理 API。因此：

- 五层 Run policy 可通过程序化调用/测试注入，尚不能由现有 HTTP 客户端提交；
- 默认模板的 skills 是空数组，主 HTTP 路径不会加载 Skill；
- 默认 Tenant 都使用进程配置中的同一模型，按 Tenant 选择不同模型需要正式模板 API；
- PolicyRegistry 也没有 HTTP CRUD。

这些不影响控制面执行机制已经接通，但影响“当前产品接口能配置到什么程度”的判断。

### 87.6 部分 Store 的一致性由上层维护

例如 `HarnessSessionStore.update()` 没有检查 `changes===1`，Instance/Attempt Store 则有
previous state 条件更新。Session 的调用路径会先 get 再 update，所以当前测试成立，但
未来并发绑定或删除场景需要更强 CAS/错误检查。

类似地，数据库外键证明引用存在，却不能证明所有对象 tenantId 一致；这个跨表不变量
由 DefaultPiControlPlane 和 ManagedAgentRuntime 服务层验证。

### 87.7 默认对象懒创建存在跨事务窗口

默认 Template 创建和 v1 发布是两个 Store 事务：

```text
createTemplate 成功
→ 进程崩溃
→ publishVersion 尚未执行
```

下次 `resolve()` 只检查 Template 是否存在；存在就跳过整个发布分支，随后 Instance 引用
不存在的固定 versionId，最终触发外键错误。更稳妥的实现应分别检查 Template 和 v1，
使 bootstrap 可重入，或在一个上层数据库事务中创建二者。

Instance 也先 INSERT PROVISIONING，再单独 UPDATE READY。崩溃可能留下永久 PROVISIONING；
当前 Resolver 看到 Instance 已存在就不会继续协调。控制面真正成熟后，`resolve()` 不应
只是“存在则复用”，而要执行 desired/actual reconciliation。

### 87.8 受管准备阶段的补偿还不完整

ManagedRuntime 在 Sandbox 创建后依次：

```text
Attempt → RUNNING
Instance → ACTIVE
注册 activeBySandboxId
进入包围 inner invoke 的 try/finally
```

如果 Attempt Store 或 Instance Store 在这个准备区间失败，代码尚未进入后面的 finally，
可能留下 ACTIVE Sandbox 或 RUNNING Attempt。尤其是上一节的残留 PROVISIONING Instance，
`PROVISIONING → ACTIVE` 非法，会在 Sandbox 已创建后抛错。

未来应把“Sandbox 已创建后的所有步骤”放入补偿作用域：任一步失败都 terminate Sandbox，
并把 Attempt/Sandbox 收敛为 FAILED。更强实现可以使用显式 saga/compensation 状态机。

### 87.9 某些类型和事件是预留而非已接通

当前 union/schema 包含 `WAITING_TOOL`、`TOOL_REQUESTED` 和 `CHECKPOINT_SAVED`，但真实
RunService/Bridge 还没有产生这些状态或事件。不要因为类型中出现就向外宣称该时间线
已经实现。

当前工具边界主要通过 `TOOL_STARTED/TOOL_COMPLETED/TOOL_FAILED`、ToolExecution 和
Checkpoint 表达；Run 在工具执行期间通常仍是 RUNNING。

### 87.10 “不可变版本”仍不是完整内容寻址

TemplateVersion 固定 Skill 名称、Tool 名称和 Model ID，但没有固定：

- Skill 文件内容 hash/version；
- Workspace 内容快照；
- 模型权重或服务部署 digest；
- 外部 Tool 实现版本。

因此它保证“控制面配置引用不漂移”，还不能保证所有外部执行内容字节级可复现。例如
同名 Skill 文件被修改后，旧 TemplateVersion 仍可能加载新内容。更强可复现性需要内容
寻址 artifact、镜像 digest 和 Workspace snapshot。

### 87.11 Capability 更新策略

Capability Store 对相同 `(runtimeKind, deploymentKey)` 的不同声明直接拒绝，而不是覆盖。
这保护历史不会静默变化，但部署升级能力时目前需要新 deploymentKey/新记录；尚没有
显式 CapabilityProfile version/revision 模型。

### 87.12 外键和循环引用

`agent_runs.checkpoint_id`、`run_attempts.policy_snapshot_id`、`run_attempts.sandbox_id` 当前
没有数据库外键。原因包括表在后续 migration 才创建和引用方向形成生命周期循环。
代码通过 RecoveryService、ManagedRuntime 和 Store 校验维护这些关系，但直接 SQL 仍可能
写入悬空 ID。生产化时可以通过重建表 migration 增加可延迟外键，或设计独立关联表。

### 87.13 Legacy 兼容入口也是绕过面

ManagedRuntime 对完全没有 Template/Instance 引用的请求直接透传；ToolGateway 输入没有
policySnapshotId 时 Guard 直接返回。这是为了 Stage 0 单元测试和渐进迁移，不是生产
安全默认。

正式外部入口当前经过 DefaultPiControlPlane 并携带 Snapshot，但如果未来暴露低层
Runtime/ToolGateway API，必须关闭 legacy bypass 或把它限制为明确测试模式。

### 87.14 阈值配置验证

配置层验证了数字和部分正整数，但尚未完整证明：

```text
0 <= busyPercent < criticalPercent <= 100
busyRunning <= criticalRunning
busyWaiting <= criticalWaiting
```

错误阈值仍可能通过解析并产生反直觉分类。生产配置入口需要跨字段 validator。

### 87.15 关闭不是完整 graceful drain

`RunQueuePump.stop()` 只清除定时器，不中断也不等待已经开始的 drain；随后
`composition.close()` 可能关闭 SQLite。当前测试覆盖幂等关闭和 HTTP 生命周期，但对
长时间活跃 Runtime 的完整 graceful shutdown 仍不充分。

成熟实现应：停止接收请求 → 停止新 claim → 等待或中断 active Attempts → 终止 Sandbox
→ 确认状态持久化 → 关闭数据库。

### 87.16 PiAdapter 的重复映射

start 和 resume 中存在两份相近的 Pi event switch。当前测试能防部分漂移，但新增事件时
仍可能只修改其中一个。可以抽取共享 subscription mapper，把“首次事件是 started 还是
resumed”的差异作为参数。

---

# 第二十二部分：推荐学习安排

## 第 88 章：第一遍——理解事实流

只读以下内容，不纠结 SQL：

```text
agent-run.ts
agent-runtime.ts
harness-application.ts
run-service.ts
runtime-event-bridge.ts
```

目标：能解释 Command、RuntimeEvent、RunEvent、State 的区别。

## 第 89 章：第二遍——理解可靠性

```text
runstore.ts
tool-execution.ts
tool-gateway.ts
tool-execution-store.ts
recovery-decision.ts
recovery-service.ts
```

目标：能手工推演每个崩溃窗口，并解释为什么 UNKNOWN_EFFECT 不能自动重放。

## 第 90 章：第三遍——理解调度

```text
resource-observer.ts
vllm-resource-observer.ts
resource-classifier.ts
execution-policy.ts
resource-admission-service.ts
tenant-run-scheduler.ts
run-queue-coordinator.ts
run-queue-pump.ts
```

目标：给定 A1/A2/B1 和资源 Snapshot，准确算出下一次 claim、decision、queue reason
和 slot 状态。

## 第 91 章：第四遍——理解 Stage 1–2

按顺序：

```text
runtime-capability
→ harness-template
→ harness-instance
→ harness-session
→ run-attempt
→ default-pi-control-plane
→ effective-policy
→ policy-compilation
→ managed-agent-runtime
→ tool-policy-guard
→ sandbox-provider/managed-local
→ pi-adapter
→ composition root
```

目标：给定一个 Run，能够列出从 Template 到 Sandbox 的全部引用和拒绝点。

## 第 92 章：第五遍——只读测试

按纯函数 → Store → Service → Coordinator → e2e 顺序读。对于每个测试，写下它防止的
具体回归，而不是只记录测试名称。

---

# 第二十三部分：必须完成的自测题

## 第 93 章：概念题

1. RuntimeEvent 和 RunEvent 为什么不能合并？
2. Run 与 Attempt 为什么是一对多？
3. Resource Snapshot 与 Effective Policy Snapshot 有什么不同？
4. TemplateVersion 和 CapabilityProfile 分别表达期望还是真实能力？
5. 为什么 Sandbox LOST 修改 Instance，而模型请求失败通常只结束 Attempt/Run？

## 第 94 章：推演题

配置：全局 slot=2，Tenant slot=1；队列 A1、A2、B1；资源 BUSY。

请回答：

1. 第一轮最多 claim 哪两个？
2. 为什么 A2 暂时不能 claim？
3. Policy 为什么仍可能允许 B1？
4. A1 完成后 tenantOrder 如何变化？

## 第 95 章：事务题

解释以下三个事务为什么不能拆：

1. Run 快照更新 + RunEvent；
2. ResourceSnapshot + PolicyDecision；
3. Tool SUCCEEDED + Checkpoint + Run.checkpointId。

每题至少写出一个“第一步成功、第二步失败”导致的错误恢复结论。

## 第 96 章：故障题

一个 Run 数据如下：

```text
Run=INTERRUPTED
Attempt=REJECTED
Compilation=REJECTED: missing TOOL_INTERCEPTION
Sandbox 不存在
Runtime startRequests=0
```

请解释每个状态由哪一层写入，以及为什么 Run 和 Attempt 使用不同终态词。

## 第 97 章：策略题

```text
Platform tools=[read,write,bash], network=false
Tenant   tools=[read,write], network=true
Template tools=[read,bash], network=true
Workspace root=/repo/a
Run      tools=null
```

请计算 Effective tools/network/root，并判断 read、write、bash 三个调用的结果。

答案：

```text
tools=[read]
network=false
root=/repo/a
read 在路径内可允许
write 因不在 tools 拒绝
bash 先因不在 tools 拒绝；即使在 tools，也因网络/Workspace 无法证明而拒绝
```

---

# 第二十四部分：运行与验证

## 第 98 章：局部测试

```bash
bun test tests/runs/runstore.test.ts
bun test tests/runs/run-service.test.ts
bun test tests/tools/tool-gateway.test.ts
bun test tests/checkpoints/recovery-service.test.ts
bun test tests/scheduling/tenant-run-scheduler.test.ts
bun test tests/scheduling/run-queue-coordinator.test.ts
bun test tests/policies/effective-policy.test.ts
bun test tests/integration/stage1-stage2-control-plane.e2e.test.ts
```

## 第 99 章：完整验收

```bash
bun run verify:stage0
```

虽然名称保留 Stage 0，它运行当前全部顶层测试、严格 TypeScript 和 Day 7 Fake 演示。

当前基线：

```text
184 tests passed
690 assertions
TypeScript strict check passed
Day 7 demo RESULT: PASS
```

---

# 附录 A：当前 HTTP API 的完整职责

| Method | Path | 作用 | 返回重点 |
| --- | --- | --- | --- |
| GET | `/health` | 查询 Application 是否完成启动 | ok/started |
| GET | `/queue` | 读取 Scheduler 的只读 round-robin 视图 | position、tenantPosition、reason |
| GET | `/resources` | 主动执行一次资源观测 | success snapshot 或 failure |
| POST | `/runs` | 创建并可靠入队新 Run | 202 + QUEUED Run |
| GET | `/runs/:id` | 查询当前 Run 和资源准入决定历史 | run、decisions |
| GET | `/runs/:id/events` | 查询按 sequence 排序的 RunEvent | events |
| POST | `/runs/:id/interrupt` | 中断 queued/active Run | 最新 Run |
| POST | `/runs/:id/resume` | 使用 Run 当前 Checkpoint 提交恢复 | 202 + QUEUED Run |

API 的 409 是领域冲突或未分类内部错误的统一当前映射；它不是完整生产错误分类。
`resume` 不相信客户端直接提供 Checkpoint 内容，而是按 Run.checkpointId 从 Store 读取并
校验归属，避免客户端伪造 runtimeSessionRef。

---

# 附录 B：源码文件职责索引

## B.1 app / process / HTTP

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 配置、Composition、恢复后监听、信号和安全关闭 |
| `src/app/harness-config.ts` | 环境变量解析、默认值和启动期验证 |
| `src/app/create-harness-application.ts` | 全部具体依赖的唯一组装入口 |
| `src/app/harness-application.ts` | 用例门面、启动门、提交/查询/中断/恢复 |
| `src/http/harness-http-api.ts` | HTTP 路由、JSON 校验、错误响应 |
| `src/http/harness-http-server.ts` | Bun Server 薄包装 |

## B.2 Run 和事件

| 文件 | 职责 |
| --- | --- |
| `src/runs/agent-run.ts` | AgentRun、RunEvent 类型 |
| `src/runs/run-state-machine.ts` | Run 合法转换 |
| `src/runs/runstore.ts` | Run/Event SQL、事务、CAS、dedupe |
| `src/runs/run-service.ts` | Run 生命周期与 RuntimeEvent 消费 |
| `src/runs/run-attempt.ts` | 单次真实执行状态机 |
| `src/runs/run-attempt-store.ts` | Attempt SQL 和条件更新 |
| `src/events/runtime-event-bridge.ts` | RuntimeEvent → 可持久 RunEvent 草稿 |
| `src/events/run-event-timeline.ts` | 面向展示的有序时间线格式化 |

## B.3 Runtime 与 Pi

| 文件 | 职责 |
| --- | --- |
| `src/runtime/agent-runtime.ts` | 所有 Adapter 必须遵守的命令/事件合同 |
| `src/runtime/runtime-capability.ts` | 细粒度能力和 required/optional 校验 |
| `src/runtime/runtime-capability-store.ts` | 部署能力持久化 |
| `src/runtime/managed-agent-runtime.ts` | Stage 1–2 核心执行编排器 |
| `src/runtime/pi-adapter.ts` | Harness ↔ Pi SDK 翻译 |
| `src/runtime/pi-tool-gateway.ts` | Pi ToolDefinition 的 Gateway 包装和 effect 分类 |

## B.4 工具、Checkpoint 和恢复

| 文件 | 职责 |
| --- | --- |
| `src/tools/tool-execution.ts` | ToolExecution/Effect 和可重放判断 |
| `src/tools/tool-execution-store.ts` | PREPARED、结果、Checkpoint 三写事务 |
| `src/tools/tool-gateway.ts` | 授权后执行、复用、重放、Checkpoint |
| `src/checkpoints/checkpoint.ts` | Checkpoint 稳定数据合同 |
| `src/checkpoints/checkpoint-store.ts` | 只读恢复点查询；写入集中在 Tool Store 事务 |
| `src/checkpoints/recovery-decision.ts` | AUTO_RESUME/MANUAL_REVIEW 纯策略 |
| `src/checkpoints/recovery-service.ts` | 重启扫描、状态修正、恢复计划 |
| `src/checkpoints/recovery-executor.ts` | 隔离地把安全计划提交回队列 |
| `src/checkpoints/recovery-startup-coordinator.ts` | 启动恢复顺序 |

## B.5 资源与调度

| 文件 | 职责 |
| --- | --- |
| `src/resources/resource-observer.ts` | 资源事实和观测失败合同 |
| `src/resources/vllm-resource-observer.ts` | vLLM Metrics + nvidia-smi 真实采集 |
| `src/resources/resource-classifier.ts` | Snapshot → 压力和原因 |
| `src/resources/execution-policy.ts` | 压力/并发 → START/QUEUE |
| `src/resources/resource-admission-service.ts` | Observer/Classifier/Policy/Store 编排 |
| `src/resources/policy-decision-store.ts` | Snapshot + Decision 原子证据 |
| `src/scheduling/tenant-run-scheduler.ts` | Tenant FIFO、round-robin 和逻辑 slot |
| `src/scheduling/run-queue-coordinator.ts` | claim、准入、执行、release、single-flight drain |
| `src/scheduling/run-queue-pump.ts` | 定时和立即触发 drain，错误隔离 |
| `src/scheduling/queued-run-recovery-service.ts` | 重启时从 SQLite 重建新任务/恢复任务队列 |

## B.6 Template、Instance、Session

| 文件 | 职责 |
| --- | --- |
| `src/templates/harness-template.ts` | Template 和 Pi 不可变版本领域对象 |
| `src/templates/template-version-policy.ts` | 连续版本规则 |
| `src/templates/harness-template-store.ts` | 模板版本事务发布和 JSON 校验 |
| `src/instances/harness-instance.ts` | desired/actual 生命周期 |
| `src/instances/harness-instance-store.ts` | Instance SQL 和 actualState CAS |
| `src/sessions/harness-session.ts` | Harness Session 与 Runtime ref 绑定 |
| `src/sessions/harness-session-store.ts` | Session SQL |
| `src/control-plane/default-pi-control-plane.ts` | 旧 API 到默认正式对象的迁移桥 |

## B.7 Policy 与 Sandbox

| 文件 | 职责 |
| --- | --- |
| `src/policies/effective-policy.ts` | 五层约束数据和交集算法 |
| `src/policies/policy-registry.ts` | 当前进程内 Platform/Tenant 策略来源 |
| `src/policies/effective-policy-store.ts` | Snapshot、Compilation、ToolDecision 证据 |
| `src/policies/policy-compilation.ts` | Effective Policy → Pi RuntimeConfig |
| `src/policies/tool-policy-guard.ts` | 副作用前 Tool/Path/Process/Network 检查 |
| `src/sandbox/sandbox-provider.ts` | Provider、Handle、Secret、Lifecycle 合同 |
| `src/sandbox/managed-local-sandbox.ts` | 本地最小实现和 fail-closed 边界 |
| `src/sandbox/sandbox-store.ts` | Sandbox 生命周期 SQL |

## B.8 基础设施和演示

| 文件 | 职责 |
| --- | --- |
| `src/storage/database.ts` | SQLite 打开、foreign key、migration 事务 |
| `src/storage/migrations.ts` | v1–v7 schema |
| `src/demo/day7-fake-demo.ts` | CRITICAL 排队、重启恢复、NORMAL 推进的可执行演示 |
| `src/demo/demo-agent-runtime.ts` | 演示专用确定性 Runtime |
| `src/spikes/pi-vllm-tool.ts` | Pi + vLLM + read 的真实外部 Spike |
| `src/index.ts` | 包公共导出面 |

---

# 附录 C：数据库表的系统角色

| 表 | 可变/追加 | 核心唯一性 |
| --- | --- | --- |
| `schema_migrations` | 追加 | version |
| `agent_runs` | 当前快照 | id |
| `run_events` | 追加 | id；run+sequence；run+dedupeKey |
| `tool_executions` | 条件状态更新 | id；run+toolCallId |
| `checkpoints` | 追加 | id；toolExecutionId |
| `resource_snapshots` | 不可变证据 | snapshotId |
| `policy_decisions` | 追加 | decisionId |
| `harness_templates` | 稳定身份 | id |
| `harness_template_versions` | 追加版本 | id；template+version |
| `runtime_capability_profiles` | 部署能力 | id；runtime+deployment |
| `harness_instances` | 生命周期快照 | id |
| `harness_sessions` | Session 当前绑定 | id |
| `run_attempts` | 条件状态更新 | id；run+attemptNumber |
| `effective_policy_snapshots` | 不可变证据 | id |
| `policy_compilations` | 追加 | id |
| `tool_policy_decisions` | 当前为每 toolCall 一条 | id；run+toolCallId |
| `sandboxes` | 生命周期快照 | id |

这里的“追加”指业务上不更新历史事实；当前 schema 并没有为每张证据表增加数据库触发器
来物理禁止 UPDATE。真正的写入面由 Store API 收窄。

---

# 结课：你真正需要掌握的十条系统性质

1. Run 当前快照和 RunEvent 历史必须原子一致。
2. RuntimeEvent 是候选即时事实，持久化前需要映射和去重。
3. Scheduler 的 claim 必须同时占 slot，release 必须覆盖全部异常路径。
4. 资源不可观测不是资源正常，当前采用 fail closed。
5. 工具真实执行前必须先有授权决定和 PREPARED 意图证据。
6. 不确定副作用不能因为“想恢复”就自动重放。
7. Run 固定不可变 TemplateVersion，排队和恢复不能漂移配置。
8. Runtime 的真实 Capability 与 Template 的期望要求必须在执行前比较。
9. 五层策略必须编译并进入 Model/Tool/Skill/Sandbox 执行点，CRUD 不算控制。
10. 每次真实执行使用独立 Attempt，故障后 Run、Attempt、Instance 和 Sandbox 必须收敛。

当你能从任意失败现象反向沿这十条性质定位到具体 Store、状态机、Decision 和测试时，
才算真正具备这个项目的细节级理解。
