# 端到端真实运行走查：一个任务从输入到输出的完整链路

> 本文不是设计说明，而是**实测记录**。所有终端输出、HTTP 状态码、事件时间线、
> 数据库证据都来自在本机真实执行 `scripts/e2e-walkthrough.ts` 与 `bun run demo:day7`
> 的原始 stdout，未做改写。
>
> 复现命令：
>
> ```bash
> bun run scripts/e2e-walkthrough.ts           # 主链路：准入 / 排队 / 公平 / 工具前沿
> bun run scripts/e2e-walkthrough.ts failure   # 故障分支：崩溃 / 主动失败 / 卡死超时
> bun run demo:day7                            # 进程重启后的 Checkpoint 恢复闭环
> ```
>
> 本文所有时间戳取自一次具体执行（`2026-09-10T16:14:37Z` 起），
> 临时目录 `/var/folders/.../harness-e2e-<随机>/` 每次运行都会变化。

---

## 0. 这份走查演示了什么

系统的一句话职责：

> **VRAM-Aware Agent Harness 是一个支持团队共享本地大模型的多租户 Agent 任务服务。**
> 用户在独立 Workspace 中提交任务；系统负责可信身份、隔离运行环境、公平调度共享 GPU、
> 工具权限与副作用治理，以及故障后的安全恢复。

一次 `POST /runs` 在系统内部要穿过 **7 个阶段、3 个进程边界、22 张表**：

```text
① HTTP/身份      →  ② 提交与入队   →  ③ 资源准入与调度
     ↓                                        ↓
⑦ 结果闭环       ←  ⑥ 事件与输出   ←  ④ 受管执行边界(Instance/Attempt/Policy/Sandbox)
                                              ↓
                                        ⑤ Worker 子进程 + 工具治理
```

**关键点：整条链路的"真实程度"是有意分层的**——控制面、调度、IPC、持久化、审计
全部是生产代码路径；唯一被替换的输入是"GPU 现在有多忙"这一个观测值
（`MutableResourceObserver` 代替需要真实 vLLM + `nvidia-smi` 的观测器），
以及 Worker 内的模型调用走了 `HARNESS_WORKER_SIMULATE=mock_stream` 的固定回放。
这不是 mock 整个系统，而是**只把不可复现的物理输入参数化**。

---

## 1. 起点：进程启动与依赖组装

`scripts/e2e-walkthrough.ts` 调用生产入口 `src/main.ts` 的 `startHarnessProcess()`，
和线上唯一的差别是注入了一个可切换的观测器、并用 `port: 0` 让内核分配空闲端口。

实测输出（阶段 0）：

```text
baseUrl              = http://127.0.0.1:50031
databasePath         = /var/folders/.../harness-e2e-PmlE22/harness.sqlite
sandboxProvider      = managed-local
sandboxProfile       = development
workerIsolation      = process
workerScriptPath     = .../src/worker/worker-main.ts
pumpIntervalMs       = 1000
maxActiveRuns        = 30
沙箱阈值 busy/critical GPU% = 70/90
沙箱阈值 busy/critical KV%  = 60/85

GET /health -> 200 {"ok":true,"started":true}
```

### 1.1 启动顺序保证

`startHarnessProcess()` 的顺序是刻意设计的（`src/main.ts:52-58`）：

```text
createHarnessApplication()      # 打开 SQLite、跑 migration、组装所有 Store/Service
  → application.start()         # 重建等待队列 + 扫描可恢复 Run（不开放 HTTP）
  → resourceMetrics.start()     # 启动资源采样后台任务
  → startHarnessHttpServer()    # 最后才监听端口
```

**为什么这个顺序重要**：如果先开 HTTP，用户可以在队列尚未重建、可恢复 Run 尚未
扫描完成时提交任务，就会出现"新任务与恢复任务竞争 slot 却没有统一视图"的窗口。
关闭顺序严格相反：先 `server.stop()` 停止接收新请求，再 `composition.close()`
停止 Pump 并关闭 SQLite。

### 1.2 组装根（Composition Root）产出的组件

`createHarnessApplication()`（`src/app/create-harness-application.ts`）一次性构造
约 30 个组件，关键的运行时分层是**四层 Runtime 装饰器**：

```text
WorkerProcessAgentRuntime        ← 第 4 层：子进程隔离 + IPC + 看门狗
  └── SupervisedAgentRuntime     ← 第 3 层：执行超时 + 优雅中断 → 强杀阶梯
        └── ManagedAgentRuntime  ← 第 2 层：Instance/Attempt/Policy/Sandbox 受管边界
              └── (Worker 内部) PiAdapter ← 第 1 层：真正驱动 Pi Agent Runtime
```

装饰顺序决定了"谁先看到错误"：超时由第 3 层裁决、进程崩溃由第 4 层裁决、
沙箱失败由第 2 层裁决，三者互不覆盖。

---

## 2. 阶段①：边界与异常（实测）

这一步故意在跑正常流程之前先打一遍非法输入，用来证明**失败发生在正确的层、
返回正确的码、并且被审计**。

```text
空 body、无凭证         -> HTTP 400 {"error":"请求体必须是有效 JSON"}
合法 JSON、无凭证       -> HTTP 401 {"error":"缺少 API Key"}
错误密钥                -> HTTP 401 {"error":"API Key 无效或已撤销"}
仅 models:generate 密钥 -> HTTP 403 {"error":"缺少权限：tasks:write"}
未知路由 POST /nope     -> HTTP 404 {"error":"找不到 HTTP 路由"}
查询不存在的 Run       -> HTTP 404 {"error":"找不到 AgentRun：does-not-exist"}
```

处理顺序在 `HarnessHttpApi.submitRun()`（`src/http/harness-http-api.ts:508-555`）：

| 顺序 | 检查 | 失败码 | 语义 |
| --- | --- | --- | --- |
| 1 | `readJsonObject` | 400 | body 必须是 JSON 对象 |
| 2 | `requirePrincipal(request, "tasks:write")` | 401 / 403 | 先证身份，再验 scope |
| 3 | `workspaceService.getForTenant(workspaceId, tenantId)` | 404 | **反枚举**：不属于本租户的 Workspace 与不存在的 Workspace 返回同一个 404 |
| 4 | 会话归属校验（首次使用即认领） | 409 | 防跨租户抢注 `sessionId` |
| 5 | `requireUserInput` 长度校验 | 413 | 提交期就拒绝，而不是让模型侧 400 |
| 6 | `application.submitRun` → 202 | — | 返回 `run` 快照 |

超长输入实测（注意：**长度校验在 Workspace 解析之后**，所以必须带一个真实存在的
`workspaceId` 才能命中 413）：

```text
超长输入 2001 字符      -> HTTP 413 {"error":"任务输入过长：2001 字符，超过上限 2000 字符（可用 HARNESS_MAX_USER_INPUT_CHARS 调整）"}
```

### 2.1 为什么"先 401 再 403"而不是合并

`401` 表示"你是谁不知道"，`403` 表示"知道你是谁，但你没这个权限"。两者在
多租户系统里是**不同的运维信号**：401 激增通常意味着密钥轮换或客户端配置问题，
403 激增通常意味着客户端在用错误的凭据访问错误的 API。实测里
`demo-agent-key-0002` 持有 `models:generate` 但缺 `tasks:write`，因此
`POST /runs` 返回 403 而不是 401——这正是设计意图。

---

## 3. 阶段②③：提交、入队、准入（场景 A：GPU 空闲 → 直接 START）

### 3.1 示例数据

```json
POST /workspaces {"name":"demo-a-<ts>"}   -> 201
workspaceId    = 400b2155-9962-4b87-929c-252952053045
workspacePath  = /var/folders/.../workspaces/bootstrap/400b2155-9962-4b87-929c-252952053045

POST /runs
{
  "sessionId":    "sess-a-e31f11fd-84ce-426d-a71b-af763c73b9df",
  "userInput":    "请读取 README.md，并只用一行回答首行内容。",
  "workspaceId":  "400b2155-9962-4b87-929c-252952053045",
  "thinkingLevel":"low"
}
-> 202
run = {
  "id":                "23ac085f-b9fc-45b5-8f08-4e35285870e9",
  "status":            "QUEUED",
  "templateVersionId": "default-pi-template-version:bootstrap:1",
  "harnessInstanceId": "default-pi-instance:bootstrap"
}
```

**Workspace 路径是不可伪造的**：`WorkspaceService.create()` 用
`resolve(root, tenantId, workspaceId)` 生成宿主路径（`src/workspaces/workspace-service.ts:26`），
并再次校验前缀防目录穿越，然后 `mkdirSync({mode:0o700})`。HTTP 层只接受
不透明的 `workspaceId`，**客户端永远不提交宿主机路径**——这是 Tenant 边界的第一道闸门。

### 3.2 提交只做两件事

`RunQueueCoordinator.submit()`（`src/scheduling/run-queue-coordinator.ts:186-200`）：

```text
createQueuedRun(input)   → 1 次事务：INSERT agent_runs + INSERT run_events(seq=1, RUN_CREATED)
scheduler.enqueue(...)   → 放进内存 Tenant 队列，不碰 DB
synchronizeQueueBlockers() → 把"为什么不能跑"物化成 QUEUE_BLOCKED 事件
```

**设计要点**：Run 的权威状态在 SQLite，队列位置只在内存。两者靠
`reconcileQueuedRuns()` 对账（见 §7.5 的 TOCTOU 处理）。

### 3.3 准入决策链

Pump 每 `pumpIntervalMs`（1000ms）触发一次 `drain()`，同时启动时立即 tick 一次。
`drainOnce()` → `attemptNext()` 的决策路径：

```text
scheduler.claimNext()                       # 选 Run，并原子占用 slot
  → 返回 null → { kind: "EMPTY" }
  → capacity = scheduler.getCapacity(tenantId)
  → admissionRequest = { activeRunCount: capacity-1, activeTenantRunCount: capacity-1 }
      # 减 1 是因为 claimNext 已经把本次 Run 计入 active，回避自己
  → ResourceAdmissionService.evaluate()
       ① observer.observe()
       ② 失败 → QUEUE / RESOURCE_OBSERVATION_FAILED（fail-closed）
       ③ classifyResource(snapshot, thresholds) → NORMAL | BUSY | CRITICAL | UNKNOWN
       ④ policy.decide(...) → START | QUEUE + reasonCode
       ⑤ decisionStore.save(decision, snapshot)   # 快照与决策一起落库
  → decision.action === "QUEUE"
       → release slot → 按原 enqueuedAt 重新入队（TTL 时钟不重置）→ DEFERRED
  → decision.action === "START"
       → executeQueuedRun(runId) 或 executeQueuedResume(pendingResume)
       → finally 释放 slot + drain 下一轮
```

场景 A 的结果：

```text
终态 status = COMPLETED
decisions = [{"action":"START","reasonCode":"RESOURCE_NORMAL","pressure":"NORMAL","snapshot":"snap-normal-1"}]
limitations = []
```

`limitations = []` 表示这个 Run 没有因为策略拒绝而"减配完成"——语义见 §7.7。

---

## 4. 阶段④：受管执行边界（Instance / Attempt / Policy / Sandbox）

这是 `ManagedAgentRuntime.execute()`（`src/runtime/managed-agent-runtime.ts:104-318`）
的核心，也是 Stage 1–2 深化的落点。它把"一次执行"拆成**可审计的四步**：

### 4.1 控制面引用完整性校验

```text
runs.get(runId) → templateVersionId + harnessInstanceId 必须存在
templates.getVersion() / instances.get() / sessions.get() 三者必须齐全
instance.tenantId === run.tenantId
instance.templateVersionId === template.id
session.tenantId === run.tenantId
session.instanceId === instance.id
capabilities.get(instance.capabilityProfileId) 必须存在
```

任何一项不符就抛错，Run 停在 RUNNING→由 RunService 收敛为 INTERRUPTED。
**这一步把"Run 归谁、跑在哪个模板、绑哪个会话"从约定变成断言。**

### 4.2 五层有效策略求交

`computeEffectivePolicy()` 把五层策略**逐层求交**（`src/policies/effective-policy.ts:105-127`）：

| 层 | 来源 | 关键约束 |
| --- | --- | --- |
| PLATFORM | `PolicyRegistry.getPlatformPolicy()` | 非 development profile 时强制 `allowNetwork=false` |
| TENANT | `PolicyRegistry.getTenantPolicy(tenantId)` | 租户级工具/网络/Secret 约束 |
| TEMPLATE | `template.spec` | `allowedTools=spec.tools`、`allowedModels=[provider/modelId]` |
| WORKSPACE | `run.workspacePath` | `workspaceRoots=[run.workspacePath]`（单根） |
| RUN | `run.runPolicy` | 本次提交的额外约束 |

求交规则是**单调收紧**，不可能放宽：

```text
allowNetwork   = left && right          # 逻辑与
allowProcess   = left && right
allowedTools   = 取交集（null 视为全集）
workspaceRoots = 取"更内层"的路径（isWithin 判定）
resourceLimits = 取 min                 # CPU/内存/磁盘取最小值
sandboxProfile = 必须相等，否则抛"策略冲突"
```

实测落库的策略快照（阶段 5 输出）：

```text
policySnapshot id=ec9e7a13-4b62-41e8-919f-f71854b8f85e
  profile=development
  allowNetwork=true
  allowedTools=["read","bash","edit","write","grep","find","ls"]
  workspaceRoots=["/var/folders/.../workspaces/bootstrap/400b2155-9962-4b87-929c-252952053045"]
  compilation status=APPLIED reasons=[]
  toolDecisions = []
```

> `compilation status=APPLIED` 说明"策略成功编译到 Pi 运行时配置"；
> 若 Runtime 缺少**强制**能力则是 `REJECTED`（Attempt 直接拒绝，Run 不启动），
> 缺少**可选**能力是 `DEGRADED`（可在审计里看到 degraded 原因）。

### 4.3 Attempt：不可变策略绑定的执行单元

```text
createRunAttempt({ attemptNumber: attempts.nextAttemptNumber(runId), kind: "START",
                   instanceId, templateVersionId, capabilityProfileId,
                   policySnapshotId: snapshot.id, sandboxId: null })
```

`attempt` 从创建那一刻就绑定 `policySnapshotId`——**即使能力校验或沙箱创建失败，
拒绝记录也能完整解释当时用的是哪份策略**。这是"失败可归因"的关键设计。

实测阶段 5 的 Attempt 证据：

```text
attempt#1 kind=START status=SUCCEEDED sandboxId=d47b1a12-e879-4fb4-a92b-b7f76b0a43b2 reason=none
  sandbox provider=MANAGED_LOCAL status=TERMINATED runtime=managed-local
  spec = {"profile":"development","runtime":"managed-local","networkMode":"bridge",
          "readOnlyRootfs":false,"droppedCapabilities":"NONE","noNewPrivileges":false,"pidLimit":null}
  runtimeEvidence = {"adapter":"managed-local","requestedRuntime":"managed-local",
                     "observedRuntime":"managed-local","verified":true,
                     "verificationReason":"仅开发/测试生命周期证据；不代表内核隔离",
                     "verifiedAt":"..."}
  failureReason   = none（正常终止）
```

> 注意 `verificationReason` 的措辞——系统**主动声明** development profile 的
> 证据"不代表内核隔离"。这类诚实边界在代码里是显式字段，而不是文档里的免责声明。

### 4.4 Sandbox 生命周期

```text
sandbox.create({id, runId, instanceId, workspacePath, policy: snapshot})
  → emit sandbox_acquired { durationMs, warmHit, runtime: profile }
  → startRunAttempt(...) + instances.acquireRun(instanceId)   # active_run_count +1
  → invoke(inner, managedRequest)                              # 真正启动 Runtime
  → finally: sandbox.terminate(handle.id) + instances.releaseRun()
```

沙箱**无论成功失败都在 finally 里终止**，实测两个 Run 的 sandbox 都是
`status=TERMINATED`。若沙箱发生异常事件，`onSandboxFailure()` 会把
Instance 打成 `FAILED`、Attempt 打成 `INTERRUPTED`，并补发 `agent_interrupted`。

---

## 5. 阶段⑤：Worker 子进程与工具治理

### 5.1 为什么需要子进程

`workerIsolation = process` 时，每个 Run 在**独立的 OS 子进程**里执行
（PID ≠ Master PID），Master 与 Worker 之间是 stdio 上的 NDJSON 协议
（`WORKER_PROTOCOL_VERSION = 2`）。收益是**故障爆炸半径隔离**：
Worker 崩溃/死循环/OOM 不会带走控制面与 SQLite。

Worker 启动后第一件事是发 `WORKER_READY`（带 pid + 协议版本），
Master 有 `workerHandshakeTimeoutMs`（默认 15s）握手看门狗，超时则 SIGKILL 并
把 Run 判失败。**协议版本号是前向兼容检查点**：不匹配时可以拒绝而不是误解析。

### 5.2 IPC 消息全集

| Master → Worker | Worker → Master |
| --- | --- |
| `START_RUN`（含 `workerConfig`） | `WORKER_READY` |
| `RESUME_RUN`（含 checkpoint） | `RUNTIME_EVENT` |
| `INTERRUPT_RUN` | `RUN_COMPLETED` |
| `SHUTDOWN` | `RUN_FAILED` |
| `TOOL_PREPARE_RESPONSE` | `RUN_INTERRUPTED` |
| `TOOL_COMPLETE_RESPONSE` | `TOOL_PREPARE_REQUEST` / `TOOL_COMPLETE_REQUEST` |

**工具治理跨越 IPC 两侧**：Worker 想执行真实工具时，先发
`TOOL_PREPARE_REQUEST`，Master 走完整 `ToolGateway.prepare()` 后回
`TOOL_PREPARE_RESPONSE`（`ALLOWED` / `REUSE` / `DENIED`）。Worker 进程内
**不存在旁路放行的工具路径**。

```text
ALLOWED → Master 已写 PREPARED 记账，Worker 才可触碰真实沙箱工具
REUSE   → 历史 SUCCEEDED 命中，直接复用缓存结果，不重复产生副作用
DENIED  → 策略或恢复裁决拒绝，Worker 不得执行
```

`process.stdin.on("end")` 时 Worker 会 `failAllPending()`：**Master 断连即刻
fail-closed**，拒绝所有在途工具裁决——宁可任务失败，也不放过未受治的执行。

### 5.3 ToolGateway 两阶段与幂等算法

`ToolGateway`（`src/tools/tool-gateway.ts`）在唯一的外部回调 `invokeTool()` 处切分：

```text
prepare(input):
  1. policyGuard.assertAllowed(input)        # 策略否决优先于一切
  2. history = store.getByToolCall(runId, toolCallId)   # 稳定业务键
  3. history === null → 写 PREPARED，返回 PREPARED
  4. history.status === "SUCCEEDED" → REUSE(result)
  5. history.status === "FAILED"    → DENIED(reason)
  6. history.status === "PREPARED"  → canAutomaticallyReplay(status, effect) ?
         是 → PREPARED(复用原记录，不再 prepare，避免违反唯一约束)
         否 → DENIED("不允许自动重放：<effect>")

complete(input, execution, outcome):
  失败 → store.fail(status=FAILED, errorMessage)
  成功 → store.completeWithCheckpoint(SUCCEEDED + Checkpoint)  # 原子
```

重放判定（`src/tools/tool-execution.ts:36-54`）是**故意保守**的：

| effect | PREPARED 时能否自动重放 | 理由 |
| --- | --- | --- |
| `READ_ONLY` | ✅ 能 | 无副作用，重试安全 |
| `IDEMPOTENT_WRITE` | ❌ 不能 | "声明幂等"≠"外部系统真用了稳定幂等键"，**证据不足即 fail closed** |
| `UNKNOWN_EFFECT` | ❌ 不能 | 进程在副作用窗口内崩溃，结果不可知 |

> 注意没有 `NON_IDEMPOTENT` 这个枚举——它被 `UNKNOWN_EFFECT` 吸收了。
> 语义上更准确：系统关心的不是"这个工具是不是幂等的"，而是
> **"我当前能不能证明这次执行的副作用状态"**。

### 5.4 mock_stream：被替换的只有模型

本走查用 `HARNESS_WORKER_SIMULATE=mock_stream`，Worker 不启动 Pi，直接回放：

```text
agent_started{runtimeSessionRef:"mock-session-ref"}
text_delta{delta:"Hello from isolated worker subprocess!"}
agent_completed{}
RUN_COMPLETED{output:"Done!"}
```

**除了 token 来源，其余全是真链路**：真实子进程、真实 NDJSON、真实事件桥、
真实 SQLite 事务、真实沙箱创建/终止、真实审计。故障注入模块
（`worker-fault-injection.ts`）只在 `HARNESS_WORKER_SIMULATE` 显式设置时
**动态 import**，默认生产入口不含任何注入代码路径。

---

## 6. 阶段⑥⑦：事件落库与结果闭环

### 6.1 事件时间线（实测原文）

**场景 A（NORMAL 直接启动）**：

```text
0001 2026-09-10T16:14:37.578Z RUN_CREATED
0002 2026-09-10T16:14:37.586Z RUN_STARTED
0003 2026-09-10T16:14:37.591Z CONTROL_PREPARED dedupe=control:23ac085f-...:prepared
0004 2026-09-10T16:14:37.593Z SANDBOX_ACQUIRED dedupe=sandbox:d47b1a12-...:acquired
0005 2026-09-10T16:14:37.962Z RUN_COMPLETED
```

**场景 B（CRITICAL 排队 → 回落 → 启动）**：

```text
0001 2026-09-10T16:14:38.018Z RUN_CREATED
0002 2026-09-10T16:14:38.020Z QUEUE_BLOCKED        ← 排队事实被物化
0003 2026-09-10T16:14:38.568Z RUN_STARTED          ← 550ms 后资源回落，自动启动
0004 ... CONTROL_PREPARED
0005 ... SANDBOX_ACQUIRED
0006 2026-09-10T16:14:38.938Z RUN_COMPLETED
```

### 6.2 事件产生者分工（这是最容易记混的一层）

| 事件 | 产生者 | 说明 |
| --- | --- | --- |
| `RUN_CREATED` | `RunService.createQueuedRun` | seq 恒为 1 |
| `RUN_STARTED` / `RUN_QUEUED` / `RUN_RESUMED` | `RunService` | 状态机驱动，与状态变更同事务 |
| `RUN_COMPLETED` / `RUN_FAILED` / `RUN_INTERRUPTED` | `RunService.subscribeToRuntime` | 消费 Runtime 终态事件 |
| `QUEUE_BLOCKED` | `RunQueueCoordinator.synchronizeQueueBlockers` | **不改变**权威状态，只解释"为什么还不能跑" |
| `TOOL_STARTED` / `TOOL_COMPLETED` | `RunService.markToolPhase` | Run 在 `RUNNING ⇄ WAITING_TOOL` 间摆动 |
| `CONTROL_PREPARED` / `SANDBOX_ACQUIRED` / `SESSION_INITIALIZED` | `RuntimeEventBridge` | 带 `dedupeKey` |
| `MODEL_STARTED` / `MODEL_COMPLETED` / `MODEL_FIRST_TOKEN` | `RuntimeEventBridge` | 含 usage / stopReason / durationMs |
| `text_delta` / `thinking_delta` | **不落 run_events** | 走 `run_output_chunks`，避免逐 token 写事件表 |

`RuntimeEventBridge.map()` 对生命周期事件返回 `null`——**故意不重复写**。
注释写得很直白：`agent_started` 等事件的 Run 状态更新是 `RunService` 的职责，
Bridge 再存一遍就会产生重复业务事件。

### 6.3 去重：为什么不靠"别重复发"

`appendEventIfNew` 依赖 migration v2 建的部分唯一索引：

```sql
CREATE UNIQUE INDEX idx_run_events_run_dedupe_key
    ON run_events(run_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
```

**在至少一次（at-least-once）投递下，"别重复发"是不现实的**。正确做法是
让重复写入在数据库层变成一个可捕获的约束冲突，而不是逻辑判断。`dedupeKey`
的构造规则也是稳定业务键，例如：

```text
control:<runId>:prepared        sandbox:<sandboxId>:acquired
model:<modelCallId>:started     model:<modelCallId>:finished
```

### 6.4 输出与可观测性（实测原文）

```text
GET /runs/:id/output -> finalText = "Hello from isolated worker subprocess!"
```

```json
GET /runs/23ac085f-.../observability = {
  "scope": "host-overlap-not-exclusive-run-usage",
  "retention": "bounded-in-memory; export reports before restart",
  "timings": { "queue_wait_ms": 8, "model_start_delay_ms": null,
               "runtime_start_ms": null, "ttft_ms": null, "e2e_ms": 384 },
  "control":  [ { "timestamp": "...:37.591Z", "durationMs": 2 } ],
  "sandbox":  [ { "durationMs": 1, "warmHit": false, "profile": "development",
                  "sandboxId": "d47b1a12-...", "attemptId": "036cf2df-..." } ],
  "resources": { "gpu": {...}, "kv": {...} },
  "sampleCount": 0, "failedSamples": 0
}
```

**两个字段值得单独看**：

- `scope: "host-overlap-not-exclusive-run-usage"` —— 系统显式声明"主机级指标
  包含其它 Run 的重叠用量，不是本 Run 独占"。避免把共享 GPU 读数误读成单任务成本。
- `retention: "bounded-in-memory; export reports before restart"` —— 观测采样是
  **有界内存 + 重启即失**，需要留存必须先导出。这是刻意的取舍，不是遗漏。

`timings.queue_wait_ms=8` 与 `e2e_ms=384` 的对比很有信息量：这个任务几乎没排队，
384ms 里绝大部分是沙箱创建 + 子进程启动 + IPC 往返。

---

## 7. 调度算法：公平性、并发与饥饿防护

### 7.1 槽位模型

`TenantRunScheduler` 维护三个内存结构：

```text
queuesByTenant     : Map<tenantId, QueuedRun[]>   # 每租户 FIFO
tenantOrder        : string[]                     # 租户轮转环
activeTenantByRunId: Map<runId, tenantId>         # 已占用的 slot（也是全局计数）
activeSessionByRunId: Map<runId, sessionId>       # 会话串行化
```

slot 是**保守的 Run 级语义**：从 Run 启动到进入终态全程占用，包括工具执行期间。

### 7.2 claimNext：选择与占位必须原子

`claimNext()` 的返回值（`QueuedRun`）本身就是契约：**"这个 Run 已经离开队列、
已经占用 slot，调用方可以启动它"**。之所以要在同一个同步动作里完成"选 + 占"，
是因为分离会导致多个调度尝试同时看到空闲容量 → 超额启动。

轮转算法：

```text
for inspected in 0..tenantCount:
    tenantId = tenantOrder.shift()            # 取本轮队首租户
    if 该租户队列空 → 删除该租户，continue
    if 该租户 active >= maxActiveRunsPerTenant → push 回队尾，continue
    run = tenantQueue.shift()
    if run.sessionId 已有活跃 Run → unshift 放回 + push 租户回队尾，continue   # 会话串行
    if 该租户还有排队 → push 租户回队尾，否则删除该租户
    登记 slot，return run
return null                                    # 全员达上限或队列为空
```

### 7.3 公平性实测（场景 C）

```text
Tenant A 视角的 /queue：
  position=1 tenantPosition=1 reason=RESOURCE_CRITICAL run=1e4aa45b-...
  position=3 tenantPosition=2 reason=RESOURCE_CRITICAL run=4aacdad8-...

Tenant B 视角的 /queue（同一份全局序号，另一租户的切片）：
  position=2 tenantPosition=1 reason=RESOURCE_CRITICAL run=572cdc8c-...
  position=4 tenantPosition=2 reason=RESOURCE_CRITICAL run=fa198122-...

全局投影顺序为 A1, B1, A2, B2 —— 每租户内部 FIFO，租户之间轮转
```

**为什么不能用全局 FIFO**：若 A 连续提交 A1..A100，全局 FIFO 下 B1 要等 100 个
任务，这就是永久饥饿。`position`（全局轮转序号）与 `tenantPosition`（租户内序号）
两个字段并存，让用户既能看到"我在全局排第几"，也能看到"我在自己队列里排第几"。

### 7.4 drain：单飞（single-flight）与重入

```text
drain():
  drainRequested = true
  if drainPromise !== null: return drainPromise   # 复用同一个 in-flight promise
  drainPromise = runDrainLoop()
  return drainPromise

runDrainLoop():
  while drainRequested:
      drainRequested = false
      results.push(...drainOnce())
  finally: drainPromise = null
```

**语义**：drain 表示"系统状态可能变了，至少再检查一轮"。执行期间的新请求只会把
`drainRequested` 置真，不会创建第二个循环——所以资源在 drain 中途恢复也能被同一轮
消费掉。

`drainOnce()` 内层用 `Promise.allSettled` 并发尝试，**单个 Run 失败不会阻塞其它
Run**，最后把错误聚合成 `AggregateError` 抛出（由 Pump 的 `onError` 记账）。

### 7.5 排队 TTL 与 DB 对账（防饥饿与防泄漏）

`enforceQueueTtl()`：等待超过 `queueTtlMs`（默认 300s）仍未获准入的 Run，
**先落库 `QUEUED → FAILED(reason=QUEUE_TIMEOUT)`，成功后才摘除内存队列条目**。
顺序不能反——若先摘队列、后落库失败，这个 Run 就既不在队列也不是终态。

`reconcileQueuedRuns()` 同时对账两件事：

1. **孤儿补入队**：DB 里是 `QUEUED` 但不在内存队列（`claimNext` 之后、
   `release + re-enqueue` 之前崩溃的 TOCTOU 窗口）→ 重新入队，
   `enqueuedAt` 取 DB `updatedAt`，**TTL 时钟跨重启累计、不重置**。
2. **DB 侧超时熔断**：即使 pump 已停，下一次 drain 或重启也会补上熔断。

### 7.6 并发上限参数

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `HARNESS_MAX_ACTIVE_RUNS` | 30 | 全局并发 slot 上限 |
| `HARNESS_MAX_ACTIVE_RUNS_PER_TENANT` | 10 | 单租户上限；构造时校验 `≤ 全局` |
| `HARNESS_PUMP_INTERVAL_MS` | 1000 | drain 周期（启动时立即 tick 一次） |
| `HARNESS_QUEUE_TTL_MS` | 300000 | 排队超时熔断门限 |

### 7.7 limitations：把"受限完成"从"真完成"里分离

`summarizeToolDenials()`（`src/policies/run-limitations.ts`）聚合该 Run 的
`tool_policy_decisions` 里所有 `DENY`，按 `(toolName, reason)` 归并计数：

```text
limitations = []   # 本走查的场景 A/B 都是空
```

非空时的含义是：**Run 走到了 COMPLETED，但有些工具被策略拒绝了**。
模型可能在回答里诚实说明"环境不支持"，但状态栏和真完成长得一样——
`limitations` 就是给这种情况一个结构化出口，而不需要改动状态机终态语义。

---

## 8. 阶段⑦：审计链（ALLOW / DENY 都留痕）

实测：

```text
GET /audit（租户 bootstrap 视角）-> 200，共 50 条
GET /audit（租户 B 视角）        -> 200，共 10 条（租户隔离）
全库审计共 63 条

DENY 记录（含被尝试密钥摘要，不存明文）：
  2026-09-10T16:14:37.570Z action=AUTHENTICATE tenant=NULL reason=missing_api_key keyDigest=none
  2026-09-10T16:14:37.571Z action=AUTHENTICATE tenant=NULL reason=invalid_or_revoked_api_key
                           keyDigest=5e179de47cd13ded21b125506a6b3a92922a9dcec651c7454f2e4c7012c98806
  2026-09-10T16:14:37.572Z action=tasks:write  tenant=agent-runtime reason=missing_scope keyDigest=none
```

三个设计点：

1. **`tenant = NULL` 的 DENY 不出现在任何租户视图里**（63 − 50 − 10 = 3），
   因为它们没有可归属的租户。这是正确的：不能把"未知调用方的攻击尝试"
   塞给某个随机租户。
2. **`attempted_key_digest` 记录被尝试密钥的 SHA-256**，不存明文。
   这样爆破/重放可以在**零明文密钥存储**的前提下做关联分析。
3. **ALLOW 也全部留痕**：`RUN_SUBMIT` 记录到 `tenant=bootstrap` /
   `tenant=bad19157-...`，跨租户可见性由 `tenant_id` 收口。

---

## 9. 故障分支实测：三个不同层级的失败

`bun run scripts/e2e-walkthrough.ts failure` 用同一套生产入口，只换 Worker 注入模式。

### 9.1 Worker 崩溃（SIGKILL 自身）→ FAILED

```text
终态 status = FAILED
failureReason = "WORKER_CRASHED: exitCode=137, signal=SIGKILL
                 Stderr: [Worker PID 26981] Simulating SIGKILL"

事件时间线：
0001 RUN_CREATED
0002 RUN_STARTED
0003 CONTROL_PREPARED
0004 SANDBOX_ACQUIRED
0005 2026-09-10T16:14:50.195Z RUN_FAILED

attempt#1 status=FAILED reason=WORKER_CRASHED: exitCode=137, signal=SIGKILL
  sandbox status=TERMINATED failureReason=none    ← 异常路径也没留下未回收环境
```

`exitCode=137` = 128 + 9，Master 的 `child.exited` 看门狗把它翻译成
`agent_failed → RUN_FAILED`。**关键证据是 `sandbox status=TERMINATED`**：
崩溃路径上孤儿沙箱被 `orphanSandboxCleaner` 回收了。

### 9.2 Worker 主动回报失败 → INTERRUPTED（已知不一致，脚本自曝）

```text
终态 status = INTERRUPTED
failureReason = null
attempt#1 status=FAILED reason=Simulated worker execution failure

[WARN] 行为不一致：RUN_FAILED 分支只 rejectPromise，不发 agent_failed 事件，
       于是走 markRuntimeInvocationFailureInterrupted → Run 变成 INTERRUPTED
       且 failureReason=null，而不是像崩溃分支那样 FAILED。失败原因只留在
       RUN_INTERRUPTED 事件的 payload.message 与 attempt.failureReason 里，
       Run 级 API 看不到。此差异无测试覆盖。
```

**这段 WARN 是脚本自己打印的**——走查脚本把"观察到的不一致"写成显式告警而不是
偷偷断言通过。这是这个项目里我最欣赏的一处工程习惯：**缺陷不隐藏，但也不伪装成
测试失败**，而是以 `warning` 字段随证据一起输出。

### 9.3 Worker 卡死且忽略中断 → 超时兜底

注入环境：`HARNESS_EXECUTION_TIMEOUT_MS=3000`、`HARNESS_INTERRUPT_GRACE_MS=1000`

```text
[WorkerProcessRuntime] Worker for run 5c7d69e2-... timed out in grace. Escalating to SIGTERM.

终态 status = INTERRUPTED
attempt#1 status=FAILED reason=Agent Runtime 执行超时：5c7d69e2-... (3000ms)

RunQueuePump onError 触发次数 = 9，去重后 = 1
  [WARN] 同一次 drain 失败被重复上报 9 次：drain() 会把同一个 in-flight promise
         返回给每个等待的 tick，它 reject 时所有等待者各自调用一次 onError。
```

**这里暴露了一个真实缺陷**：single-flight 让 9 个并发 tick 共享同一个被 reject 的
promise，于是每个等待者都调一次 `onError` → 同一次失败被记 9 次。
功能够用（去重后是 1 条独立错误），但计数语义不准确。脚本同样以 WARN 形式暴露它。

**中断升级阶梯**（`worker-process-runtime.ts`）：

```text
优雅中断 → 等待 interruptGraceMs（默认 10s）
  → 未退出 → SIGTERM
    → 等待 2s → 未退出 → SIGKILL
      → 最多等 2s 让进程退出事实落地 → 清理孤儿沙箱
```

生产默认 `executionTimeoutMs = 30 分钟`；本走查把它压到 3s 才能在几秒内验证阶梯。

---

## 10. 进程重启后的恢复（`bun run demo:day7`）

这是"故障后安全恢复"的最小闭环，**故意跨进程**：先用第一个进程把 DB 种入
一个带 Checkpoint 的中断 Run 和一个普通排队 Run，关闭进程，再用第二个进程恢复。

实测输出：

```text
[CRITICAL] queue snapshot
1. tenant-b 596290fa-... reason=RESOURCE_CRITICAL
2. tenant-a 72f402d5-... reason=RESOURCE_CRITICAL

[NORMAL] runtime.start  -> 596290fa-...      ← 排队 Run 走 start
[NORMAL] runtime.resume -> 72f402d5-...      ← 中断 Run 走 resume

--- Tenant A / Checkpoint Recovery ---
run=72f402d5-... status=COMPLETED
0001 RUN_CREATED
0002 RUN_STARTED
0003 RUN_INTERRUPTED        ← 上一个进程死在这里
0004 RUN_QUEUED             ← 恢复：INTERRUPTED → QUEUED
0005 QUEUE_BLOCKED          ← CRITICAL，仍不能跑
0006 QUEUE_BLOCKED
0007 RUN_RESUMED            ← 资源回落，走 resume 而非 start
0008 RUN_COMPLETED
policy decisions:
QUEUE RESOURCE_CRITICAL pressure=CRITICAL snapshot=demo-critical
QUEUE RESOURCE_CRITICAL pressure=CRITICAL snapshot=demo-critical
START RESOURCE_NORMAL   pressure=NORMAL   snapshot=demo-normal
```

三个必须成立的不变量：

1. **恢复任务不绕过调度器**：`RUN_QUEUED` 之后它仍然要重新经过
   `ExecutionPolicy` 与 slot 占用，所以会有 `QUEUE_BLOCKED`。恢复不是特权通道。
2. **start / resume 分流是正确判定的**：同一份队列里，无 Checkpoint 的走
   `runtime.start`，有 Checkpoint 的走 `runtime.resume`，且 `RUN_RESUMED`
   而不是 `RUN_STARTED`。
3. **`RUN_CREATED → RUN_INTERRUPTED → RUN_QUEUED → RUN_RESUMED → RUN_COMPLETED`
   的 sequence 连续**（1..8 无空洞），说明恢复后的事件追加没有重置计数器。

恢复时的续跑输入也不是空话（`buildRecoveryContinuationInput`）：

```text
你此前在执行下面的任务时被中断，系统已从恢复点（Checkpoint <id>）回滚。
请从中断处继续，完成整个任务；已确认成功的工具结果会被自动复用，不要重复执行已完成的副作用。
原始任务：
<userInput>
```

**注释解释了为什么**：只写"请从恢复点继续"会让模型丢失目标，续跑变成无的放矢。

---

## 11. 数据结构：22 张表的分工

| migration | 表 | 职责 |
| --- | --- | --- |
| v1 | `agent_runs` | Run 当前快照（**权威状态**） |
| v1 | `run_events` | 追加式历史事实（**为什么变成这个状态**） |
| v2 | `run_events.dedupe_key` | 部分唯一索引，at-least-once 去重 |
| v3 | `tool_executions` | 工具执行意图与结果（**控制重放**） |
| v3 | `checkpoints` | 安全恢复边界（**不是内存 dump**） |
| v4 | `resource_snapshots` / `policy_decisions` | 决策输入与决策本身，一起落库 |
| v5 | `harness_templates` / `harness_template_versions` | 不可变期望配置 |
| v6 | `runtime_capability_profiles` / `harness_instances` / `harness_sessions` / `run_attempts` | 控制面对象 |
| v7 | `effective_policy_snapshots` / `policy_compilations` / `tool_policy_decisions` / `sandboxes` | 策略与隔离证据 |
| v8 | `api_credentials` / `workspaces` | 身份与受管工作区 |
| v9 | `access_audit_events` | 访问审计（ALLOW/DENY） |
| v10 | `run_output_chunks` | 输出分片（answer / thinking 双通道） |
| v11 | `run_workspace_snapshots` / `run_workspace_diffs` | 文件变更的 BEFORE/AFTER 与 diff |
| v12 | `run_artifacts` | 不可变产物（带 hash） |
| v13 | `sandboxes.profile/runtime/spec/evidence` | 隔离证据（三元组） |
| v14 | `policy_decisions` 重建 | 支持 `TENANT_BUDGET_EXCEEDED` |
| v15 | 去 `subject_id` | tenant = 用户，去掉冗余 |
| v16 | `users` / `user_sessions` | 账户与登录会话 |
| v17 | `conversations` | 用户可见的持续对话 |
| v18 | `run_output_chunks.channel` | 区分 answer / thinking |
| v19 | `agent_runs.thinking_level` | 思考等级 |
| v20 | `harness_instances.active_run_count` | 实例级活跃计数 |
| v21 | `llm_cache_metrics` | 前缀缓存命中台账 |
| v22 | `access_audit_events.attempted_key_digest` | 鉴权失败的密钥摘要 |

### 11.1 两组"双表"模式（这是 schema 的核心思想）

```text
agent_runs ↔ run_events       当前状态 ↔ 历史事实
tool_executions ↔ checkpoints 执行意图/结果 ↔ 可恢复边界
```

**为什么不能只保存最终消息**：如果只留最终回答，你无法回答"它执行了哪些工具、
哪些副作用是确定的、失败后能不能安全重试"。`run_events` 与 `tool_executions`
分别服务"解释"和"控制"两个目的，不能合并。

**为什么状态不能靠扫全部事件算出来**：每个 `GET /runs/:id` 都要 O(事件数) 重放，
而且恢复逻辑需要"当前是不是 RUNNING"这种 O(1) 判断。所以两者都要存，
写入时用**同一个事务**保证一致。

### 11.2 数据库层是第二道防线

`agent_runs.status` 有 `CHECK (status IN (...))`，`run_events` 有
`UNIQUE (run_id, sequence)`，`tool_executions` 有 `CHECK` 约束拒绝
"PREPARED 却带 result"、"SUCCEEDED 却没有 finished_at" 这类矛盾组合。
TypeScript 状态机是第一道，SQL `CHECK` 是第二道——**两层都拦，是为了让
"代码 bug 写入非法状态"在最早的地方爆炸**，而不是等到恢复逻辑读到脏数据。

---

## 12. 状态机与非法转换

`src/runs/run-state-machine.ts` 的完整转移表：

```text
QUEUED       → RUNNING | INTERRUPTED | FAILED(仅 QUEUE_TIMEOUT)
RUNNING      → WAITING_TOOL | INTERRUPTED | FAILED | COMPLETED
WAITING_TOOL → RUNNING | INTERRUPTED | FAILED
INTERRUPTED  → QUEUED
COMPLETED    → (终态)
FAILED       → (终态)
```

两个反直觉的设计：

1. **`QUEUED → FAILED` 只用于排队 TTL 熔断**。注释写得很清楚：
   任务等待超门限仍未获准入时安全流转到终态，**杜绝永久饥饿死等**。
   没有这条边，"公平"就只是软承诺。
2. **`INTERRUPTED → QUEUED` 而不是 `→ RUNNING`**。恢复必须重新排队过准入，
   不能直接跳回运行。这就是 Day7 演示里 `RUN_QUEUED` 出现的原因。

### 12.1 并发竞态的处理（真机抓到的毒丸）

`RunService.executeQueuedRun` 有一段专门处理"调度启动与并发处置竞态"（第 223-232 行）：

```text
claimNext 选中 Run → （此窗口内用户点了 interrupt，Run 变 INTERRUPTED）
→ executeQueuedRun 发现 status !== QUEUED
      若是 INTERRUPTED / FAILED（isTakenOverByConcurrentHandling）
        → 直接返回当前状态，不启动 Runtime，由调度器释放 slot
      否则抛"只有 QUEUED Run 可以开始执行"
```

注释引用了真机 A6000 抓到的 `INTERRUPTED -> RUNNING` 非法转换毒丸
（`docs/known-issues` A4）。同类保护在 `store.update()` 抛错处还有一份——
**状态机拒绝写入时也要安全放弃启动，而不是带着半启动状态继续**。

---

## 13. 关键参数总表

### 13.1 资源阈值（`ResourceThresholds`）

| 参数 | 默认 | CRITICAL 判定 |
| --- | --- | --- |
| `HARNESS_BUSY_GPU_MEMORY_PERCENT` / `HARNESS_CRITICAL_GPU_MEMORY_PERCENT` | 70 / 90 | 显存占用率 |
| `HARNESS_BUSY_KV_CACHE_PERCENT` / `HARNESS_CRITICAL_KV_CACHE_PERCENT` | 60 / 85 | KV cache 占用 |
| `HARNESS_BUSY_RUNNING_REQUESTS` / `HARNESS_CRITICAL_RUNNING_REQUESTS` | 4 / 8 | 运行中请求数 |
| `HARNESS_BUSY_WAITING_REQUESTS` / `HARNESS_CRITICAL_WAITING_REQUESTS` | 1 / 4 | 等待请求数 |

**四组信号只要有一个是 `_CRITICAL` 就是 CRITICAL**；否则有一个 `_BUSY` 就是 BUSY；
都没有且至少有一个可用信号是 NORMAL；**全部信号为 null 才是 UNKNOWN**。

本走查用的假快照：`gpuTotal=100, gpuUsed=20 (NORMAL) / 95 (CRITICAL)`，
`kvCacheUsagePercent=20`，所以分类结果分别是 `NORMAL` / `CRITICAL`。

### 13.2 执行与超时

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `HARNESS_EXECUTION_TIMEOUT_MS` | 1_800_000 (30min) | Supervisor 执行超时 |
| `HARNESS_INTERRUPT_GRACE_MS` | 10_000 | 优雅中断宽限，之后 SIGTERM → SIGKILL |
| `HARNESS_WORKER_HANDSHAKE_TIMEOUT_MS` | 15_000 | WORKER_READY 握手看门狗 |
| `LLM_REQUEST_TIMEOUT_MS` | 300_000 | 单次模型请求（含流式全程） |
| `HARNESS_RESOURCE_TIMEOUT_MS` | 3_000 | 单次资源观测超时 |
| `HARNESS_RESOURCE_METRICS_INTERVAL_MS` | 1_000 | 后台采样周期 |

> `LLM_REQUEST_TIMEOUT_MS` 默认从 60s 放宽到 300s 是**真机数据驱动的修复**：
> 50k 字符任务连续 4 次在 ~60s 被掐断后 `RUN_FAILED`，而当时 60s 不可配置。

### 13.3 沙箱

| 参数 | 默认 | 约束 |
| --- | --- | --- |
| `HARNESS_SANDBOX_PROVIDER` | `managed-local` | `container` 时默认 profile 变 `default` |
| `HARNESS_SANDBOX_PROFILE` | managed-local→`development`；container→`default` | managed-local **只能** development |
| `HARNESS_SANDBOX_RUNTIME` | container→`runsc`，managed-local→`runc` | `default`/`restricted-egress` **禁止**回退到 runc |
| `HARNESS_CONTAINER_IMAGE` / `HARNESS_CONTAINER_USER_ID` | `alpine:3.20` / `65532` | 非 root 执行 |

**这些组合是在 `loadHarnessConfig` 里 fail-fast 校验的**，非法组合直接启动失败，
而不是运行到一半才发现隔离等级被悄悄降级。

---

## 14. 边界与异常处理矩阵（全部有实测证据）

| 场景 | 触发 | 系统行为 | 证据 |
| --- | --- | --- | --- |
| 请求体非 JSON | `POST /runs` body=`""` | 400 | 实测 |
| 无凭证 | 无 `Authorization` | 401 missing_api_key + **审计 DENY** | 实测 + 审计表 |
| 凭证无效 | `wrong-key` | 401 invalid_or_revoked + 密钥摘要留痕 | 实测 + 审计表 |
| scope 不足 | 只有 `models:generate` | 403 missing_scope | 实测 + 审计表 |
| 未知路由 | `POST /nope` | 404 | 实测 |
| 跨租户/不存在 Run | `GET /runs/does-not-exist` | 404（**与越权同码，反枚举**） | 实测 |
| 超长输入 | 2001 字符（上限 2000） | 413，**提交期拒绝** | 实测 |
| GPU 压力 CRITICAL | `gpuUsed=95/100` | QUEUE + `RESOURCE_CRITICAL` + `QUEUE_BLOCKED` 事件 | 实测 |
| 压力回落 | 观测器切回 20 | **无需用户操作**，下一 pump tick 自动 START | 实测（550ms 内启动） |
| 观测失败 | observer 抛错 | fail-closed：QUEUE + `RESOURCE_OBSERVATION_FAILED`，`policy_decisions` 的 CHECK 强制"无快照 + UNKNOWN + QUEUE" | 代码 + DB 约束 |
| 单租户持续提交 | 全局并发=1，A1..A3 + B1 | 轮转 A1→B1→A2→A3，B1 不被饿死 | 实测 |
| 排队超时 | 等待 > queueTtlMs | `QUEUED → FAILED(QUEUE_TIMEOUT)`，先落库再摘队列 | 代码 |
| Worker 崩溃 | SIGKILL 自身 | `RUN_FAILED`，`WORKER_CRASHED: exitCode=137`，沙箱回收 | 实测 |
| Worker 卡死 | 忽略 INTERRUPT_RUN | 超时 → 优雅中断 → SIGTERM → SIGKILL → `INTERRUPTED` | 实测 |
| 工具在副作用窗口崩溃 | PREPARED 后 SIGKILL | 重启后 `PREPARED` + `UNKNOWN_EFFECT` → **禁止自动重放** | 代码 + `canAutomaticallyReplay` |
| 工具执行失败 | invokeTool 抛错 | `status=FAILED` + errorMessage 落库，不再重试 | 代码 |
| Master 断连 | Worker stdin end | `failAllPending()` 拒绝所有在途工具裁决（fail-closed） | 代码 |
| 沙箱异常 | provider 生命周期事件 | Instance→`FAILED`、Attempt→`INTERRUPTED`、补发 `agent_interrupted` | 代码 |
| Runtime 启动即抛错 | 未打开 Session | Run `RUNNING → INTERRUPTED`（`START_FAILED`），**Checkpoint 仍有效** | 代码 |
| 能力不足 | 缺 required capability | `compilePiPolicy` → `REJECTED`，Attempt 拒绝，Run 不启动 | 代码 |
| 非法状态转换 | 如 `COMPLETED → RUNNING` | `assertValidTransition` 抛错 + SQL `CHECK` 双保险 | 代码 + schema |
| 事件重复投递 | 同一 dedupeKey 再来 | 唯一索引冲突被 `appendEventIfNew` 吸收 | 代码 + v2 索引 |

---

## 15. 诚实的已知缺陷（脚本自曝，不是我的推断）

1. **`RUN_FAILED` 分支状态语义不一致**：Worker 主动回报失败时，Run 收敛为
   `INTERRUPTED` 且 `failureReason=null`，而不是崩溃分支的 `FAILED`。
   失败原因只在 `RUN_INTERRUPTED.payload.message` 与 `attempt.failureReason` 里，
   **Run 级 API 看不到**。此差异无测试覆盖。
2. **`onError` 重复计数**：single-flight drain 让同一失败被上报 N 次
   （实测 9 次）。功能可用但计数不准确。
3. **development profile 不等于内核隔离**：`runtimeEvidence.verificationReason`
   自己声明"仅开发/测试生命周期证据；不代表内核隔离"。真实隔离证据需要
   `smoke:container` / `smoke:container:attacks` 在 Linux Docker + runsc 上产生。
4. **A6000 真机对照实验未完成**：所有性能结论在获得真机数据前**不成立**。
   本走查证明的是控制面正确性，不是性能收益。
5. **观测采样重启即失**：`retention: "bounded-in-memory; export reports before restart"`。

---

## 16. 复现清单

```bash
# 0. 环境（本机实测 Bun 1.4.2；项目 packageManager 声明 pnpm，
#    但所有 scripts 走 bun run，bun 即可）
bun --version            # 1.4.2

# 1. 安装依赖（首次）
bun install

# 2. 主链路走查（无需 GPU / 无需模型 / 无需 Docker）
bun run scripts/e2e-walkthrough.ts
#    期望末尾：RESULT: PASS

# 3. 故障分支
bun run scripts/e2e-walkthrough.ts failure
#    期望末尾：RESULT: PASS（全部故障分支符合预期）
#    注意：会打印 2 处 [WARN]，那是系统自曝的已知不一致

# 4. 跨进程 Checkpoint 恢复
bun run demo:day7
#    期望末尾：RESULT: PASS

# 5. 交互式用户工作台（Fake Runtime，浏览器打开）
bun run scripts/user-console-demo-server.ts   # http://127.0.0.1:3977/app
#    演示账号：demo@team.local / demo-password-123

# 6. 需要真实环境的验收（本机不具备条件时应失败，不应伪装通过）
bun run start                                  # 需要真实 vLLM
bun run smoke:http                             # 需要已启动的 Harness
bun run smoke:container                        # 需要 Docker daemon + runsc
bun run smoke:container:attacks                # 需要 Linux Docker + runsc
```

**判断"跑通了"的标准**不是终端好看，而是：

```text
□ RUN_CREATED → ... → RUN_COMPLETED 的 sequence 连续无空洞
□ 每个 RUN_STARTED 都有对应的 POLICY_DECISION（包括 QUEUE 的那些）
□ CRITICAL 期间 Run 排队，回落 NORMAL 后无需人工干预自动启动
□ 两个租户在受限并发下都拿到过执行机会
□ 异常路径不留下 TERMINATED 之外的沙箱状态
□ DENY 与 ALLOW 都在 access_audit_events 里可查
```
