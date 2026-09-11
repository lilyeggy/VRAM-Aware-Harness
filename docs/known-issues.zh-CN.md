# 已知问题清单（Known Issues）

> 记录日期：2026-09-08。来源：以面试官视角对全仓库的代码级审计（身份/编排/产品面三路 + 人工复核）。
> 定位：个人面试项目，不追求生产级。因此"无 RBAC / 无限流 / 单机 / 内联 HTML"等平台化缺口**不列入**——
> 它们已由 [完成度对账](completion-status.zh-CN.md) 与手册诚实边界覆盖。
> 本清单只收录**缺陷**：叙事矛盾、功能性 bug、声明漂移、卫生问题。
> 状态约定：`OPEN`（未处理）/ `FIXING`（修复中）/ `FIXED`（已修复并测试）/ `WONTFIX`（明确接受）。
> 每条的**家族归因 + 场景时间线 + 修法 + 面试话术**见逐条讲解版：
> [known-issues-walkthrough.zh-CN.md](known-issues-walkthrough.zh-CN.md)（2026-09-09，行号已按当前代码复核）。

## A 级：叙事级矛盾（面试现场会被问穿）

| # | 问题 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| A1 | **默认生产路径旁路 ToolGateway**：`workerIsolation` 默认 `"process"`，Worker 内 PiAdapter 拿到直通网关 `{ execute: (_i, invoke) => invoke() }`，`getLastEventSequence` 硬编码 0 | `src/worker/worker-main.ts:149-150`、`src/app/harness-config.ts:245-247` | 工具执行不落库、策略守卫不生效、**Checkpoint 永不产生** → 副作用感知自动恢复在默认模式下失灵（恢复扫描只会 NO_CHECKPOINT → MANUAL_REVIEW）。支柱 1 与支柱 0 在默认路径互相拆台 | **FIXED**（2026-09-08，见 §5） |
| A2 | "对话式工作台"无多轮记忆：每 Run 新建空白 Pi 会话并在 finally 中 dispose | 手册 §14（自认）；`PiAdapter.start` 的 `SessionManager.create` | 用户"先写再改"场景第二句丢失上文 | **已实现（本条系文档过时误判，2026-09-09 核实，见 §6）** |
| A3 | LLM 网关不在主链路：Pi 的 models.json 直连 vLLM；流式响应不采集 usage/cache 指标 | `deploy/qwen38-vllm-models.json`（指向 18000）；`src/llm-gateway/llm-gateway.ts:275-300` | 真实 Agent 流式推理下 `llm_cache_metrics` 基本为空；"路由网关"亮点不在 agent 主流量上 | **FIXED**（2026-09-09，见 §7） |

## B 级：功能性 bug

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| B1 | `WAITING_TOOL` 是死状态：状态机/迁移/UI 均有，但无任何写入方 | `src/runs/agent-run.ts:22`、`src/runs/run-state-machine.ts:13-18`；全仓库无写入点 | **FIXED**（2026-09-09，见 §8） |
| B2 | 登录时序侧信道 + 阻塞事件循环：未知邮箱短路跳过 scrypt（可枚举注册邮箱）；`scryptSync` 同步跑在 Bun.serve 事件循环上 | `src/auth/api-credential-store.ts:89-92, 124-134` | **FIXED**（2026-09-09，见 §8） |
| B3 | 恢复续跑 prompt 硬编码"请从恢复点继续完成任务"，不带用户原始任务语境 | `src/checkpoints/recovery-executor.ts:81`、`src/scheduling/queued-run-recovery-service.ts:57` | **FIXED**（2026-09-09，见 §9） |
| B4 | 队列 TTL 只在 drain 时检查（pump 停止即失效）；排队 reasonCode 仅内存，重启不可复现 | `src/scheduling/run-queue-coordinator.ts:265-283`；手册 14.5 ② | **FIXED**（2026-09-09，见 §9） |
| B5 | TOCTOU 归档窗口：`claimNext` 与 release+re-enqueue 之间崩溃，Run 脱离内存队列但 DB 仍 QUEUED，进程内不自动补 | 手册 14.5 ④ | **FIXED**（2026-09-09，见 §9） |
| B6 | `harnessSessionId` 客户端可自选 → 会话抢注/撞车 DoS | 手册 14.5 ① | **FIXED**（2026-09-09，见 §9） |
| B7 | 租户预算子系统未接线：组合根只用 `DeterministicExecutionPolicy`，`TENANT_BUDGET_EXCEEDED` 为生产死代码，账本内存态 | `src/app/create-harness-application.ts:307-315` | **FIXED**（2026-09-09，见 §9） |
| B8 | Secret 值经 `docker run` argv 注入，同用户进程可从 /proc 读到 | `src/sandbox/container-sandbox-provider.ts:263-266` | OPEN |
| B9 | Worker 容器绑定靠命名约定 `agent-harness-${sandboxId}`；`EphemeralSandboxStore` 经 `as unknown as SandboxStore` 强转 | `src/worker/worker-main.ts:111-132` | OPEN |
| B10 | 会话串行化导致租户内队头阻塞（同会话 Run 永不并发，设计使然但需明示） | `src/scheduling/tenant-run-scheduler.ts:189-196, 233-238` | WONTFIX（设计选择） |
| B11 | 调度启动与并发中断竞态：`executeQueuedRun`/`executeQueuedResume` 读到 QUEUED 后无条件写 RUNNING，用户恰在此时中断排队中的 Run（或准入 DEFER 重入队后再次被claim）即撞状态机 `INTERRUPTED -> RUNNING` 非法转换，pump 每轮推进报"RunQueuePump 推进失败" | `src/runs/run-service.ts`（executeQueuedRun/executeQueuedResume） | **FIXED**（2026-09-10 A6000 真机 harness.log 抓到，见 §11） |

## C 级：声明与文档漂移（面试官当场能抓）

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| C1 | 测试数字三处不一致：README 说 184、对账说 254，实际以最近一次全量为准（**396 pass / 4591 断言**，2026-09-10 实测，含 B1–B7、D 级、B11 修复与 N1–N4 修复新增） | README.md、docs/completion-status.zh-CN.md | **FIXED**（2026-09-09 文档对账清理；2026-09-10 快照同步为 392，并注明随开发增长、以最近一次 `bun run test` 为准） |
| C2 | 手册 §7 仍宣传 `/observe` 观测驾驶舱，实际该页已删除（commit `4a1ae49`）；`harness-dashboard.ts` 成未路由死代码 | docs/project-handbook.zh-CN.md、docs/course/index.html | **FIXED**（2026-09-09：手册 §7/§11、完成度对账、面试 prep/lab、course 页全部改为"运行级观测抽屉"表述；死代码 `harness-dashboard.ts` 已删除并移出 barrel export） |
| C3 | README "实时展示…流式输出"实为 1.6s 轮询持久化分片，全仓库无 SSE/WebSocket | README.md、`src/http/harness-user-console.ts:631-645` | **FIXED**（2026-09-09：README 措辞改为"准实时输出（持久化分片轮询，非 SSE 推送）"；SSE 推送属功能增强，未列入） |
| C4 | 部署示例 env 的沙箱是 `development` + `runc`（自带 "explicitly development only" 注释），旗舰 runsc 在部署故事里缺席 | `deploy/qwen38-harness.env.example` | OPEN |
| C5 | 工作区含大量未提交改动与无关项目目录（`ax-code-atlas` 等） | `git status` | OPEN |

## D 级：卫生级

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| D1 | `EvaluationAggregator.computeLlmCacheMetrics` 与 `llm-cache-metrics-store.ts` SQL 逐字重复 | `src/eval/evaluation-aggregator.ts:373-405` | **FIXED**（2026-09-09，见 §10） |
| D2 | eval 聚合 N+1 查询 | `src/eval/evaluation-aggregator.ts:193-210` | **FIXED**（2026-09-09，见 §10） |
| D3 | `GET /resources` 忽略 principal（`void principal;`），主机级 GPU 观测对任意租户可见 | `src/http/harness-http-api.ts:177-185` | **FIXED**（2026-09-09，见 §10） |
| D4 | 审计只记 HTTP 鉴权事件（`resourceType` 恒为 HTTP_REQUEST）；interrupt/resume 无资源级审计；查询无分页；DENY 事件 tenantId 为 null | `src/http/harness-http-api.ts:632-660` | **FIXED**（2026-09-09，见 §10） |
| D5 | 平台仪表盘支持 `#key=` URL 片段注入 API key（进浏览器历史） | `src/http/harness-platform-dashboard.ts`（尾部 bootstrap） | **FIXED**（2026-09-09，见 §10） |
| D6 | 路径前缀检查硬编码 `"/"` 而非 `path.sep` | `src/workspaces/workspace-service.ts:29` | **FIXED**（2026-09-09，见 §10） |
| D7 | `/auth/logout` 对无效 token 静默成功；session token 不轮换、无"撤销全部会话" | `src/auth/api-credential-store.ts:103-106` | **FIXED**（2026-09-09，见 §10；token 轮换为已文档化边界） |
| D8 | Checkpoint 归属校验是应用层的，数据库无 FK 兜底 | `src/checkpoints/recovery-service.ts:39-116` | **误判改判（2026-09-09 实证复核，见 §10）**：FK 兜底早已存在并开启 |
| D9 | `HARNESS_WORKER_SIMULATE` 故障注入钩子编译进生产 worker 入口（env 门控） | `src/worker/worker-main.ts:159-230` | **FIXED**（2026-09-09，见 §10） |

## §5 A1 修复记录（已完成 · 2026-09-08）

**方案：把 ToolGateway 沿 IPC 边界"对折"。** `ToolGateway.execute(input, invokeTool)` 唯一的外部回调
是 `invokeTool()`（真实沙箱执行，留在 Worker）。将其拆为 `prepare`（守卫→历史幂等判断→PREPARED 记账）与
`complete`（SUCCEEDED+Checkpoint 原子落库 / FAILED）两个阶段，阶段间经 NDJSON 协议做请求-响应 RPC：

```
Worker                                     Master（拥有 SQLite）
TOOL_PREPARE_REQUEST(input) ──────────────▶ 守卫断言 → 历史判断 → PREPARED 落库
TOOL_PREPARE_RESPONSE ◀──────────────────── ALLOWED{toolExecutionId,lastEventSequence} / REUSE / DENIED
（REUSE 返回缓存；DENIED 抛错；ALLOWED → invokeTool() 真实执行）
TOOL_COMPLETE_REQUEST(outcome) ───────────▶ SUCCEEDED+Checkpoint 原子落库 / FAILED
TOOL_COMPLETE_RESPONSE ◀──────────────────
```

关键性质：Worker 在 PREPARED 与 COMPLETE 之间被 SIGKILL 时，master 留下
`PREPARED + UNKNOWN_EFFECT` 记账 → 启动恢复扫描 fail-closed（不自动重放 → MANUAL_REVIEW）。
**故障语义自动落入既有恢复模型**，支柱 1 的爆炸半径隔离成为支柱 0 恢复叙事的正常用例。

### 已落地改动

| 文件 | 改动 |
|---|---|
| `src/tools/tool-gateway.ts` | 拆出 `prepare()` / `complete()` 公开阶段；`execute()` 由二者组合，in-process 行为不变 |
| `src/worker/worker-protocol.ts` | 协议版本升至 2；新增 `TOOL_PREPARE_REQUEST/RESPONSE`、`TOOL_COMPLETE_REQUEST/RESPONSE`（requestId 关联的第一对 RPC） |
| `src/worker/worker-tool-gateway.ts`（新） | Worker 侧 `ToolGatewayExecutor` 实现：裁决超时 10s fail-closed；REUSE 直接复用缓存；`failAllPending` 应对 Master 断连；追踪 Master 回传的 `lastEventSequence` |
| `src/runtime/worker-process-runtime.ts` | 新增 `toolGatewayBridge` / `getRunEventSequence` 选项；处理两类 RPC 请求；**未装配治理桥时 fail-closed 拒绝**；Worker 退出清理在途记账（不撤销 PREPARED 证据） |
| `src/app/create-harness-application.ts` | 组合根把现有 `ToolGateway`（守卫+账本）作为桥传入 Worker 运行时，事件序号取自 `runStore.getLastEventSequence` |
| `src/worker/worker-main.ts` | 删除 pass-through 网关；新增 `tool_roundtrip` / `tool_after_prepare` 两个治理故障注入模式；stdin 断连时 `failAllPending` |

### 验证证据

- **全量回归**：362 pass / 0 fail / 4433 断言（修复前基线 352），`tsc --noEmit` 干净。
- **新增接缝测试**（此前为零覆盖的支柱接缝）：
  - `tests/worker/worker-tool-gateway.test.ts`：ALLOWED/REUSE/DENIED/执行失败/裁决超时/Master 断连 6 条路径；
  - `tests/runtime/worker-tool-governance.test.ts`：真实子进程——未装配桥 → fail-closed 拒绝且 Run 失败；装配桥 → prepare/complete 在 Master 侧调用、事件序号由 Master 注入；REUSE → 不回报 COMPLETE；
  - `tests/integration/worker-tool-governance.e2e.test.ts`：完整 HTTP 栈 + 真实 worker——受治工具调用在 SQLite 留下 SUCCEEDED 记账 + Checkpoint + `agent_runs.checkpoint_id`；`tool_after_prepare`（PREPARED 与 COMPLETE 之间 SIGKILL）→ 记账保留为 PREPARED/UNKNOWN_EFFECT、无 Checkpoint、`canAutomaticallyReplay=false`（恢复侧 fail-closed）。
- **顺带修复**：Worker 侧 `getLastEventSequence: () => 0` 硬编码改为 Master 权威值。

## §6 A2 复核记录：多轮会话本已实现，本条系文档过时误判（2026-09-09）

**结论：A2 不是 bug。** 原清单引用手册 §14 的"待实现"声明（"每 Run 新建空白会话，多轮不可用"），
但代码核实该能力**早已实现且有测试证据**——手册 §14 的标题（"定稿设计 · 待实现"）与 14.5 的
"现状"描述过时，误导了本次审计。已将 A2 状态改为"已实现"，并修正手册（见下）。

### 核实到的完整证据链

1. **会话文件是事实源**：`PiAdapter.start` 按 `request.run.runtimeSessionRef` 分支——无引用则
   `SessionManager.create`（首轮），有引用则 `SessionManager.open`（续轮，恢复全部上下文）
   （`src/runtime/pi-adapter.ts:143-175`）。run 结束的 `session.dispose()` 只清理内存对象，
   **会话文件持久保留**，下一 Run 重新打开。
2. **句柄绑定与注入**：`ManagedAgentRuntime` 在 `agent_started/agent_resumed` 事件时把 Pi 会话
   引用 `bindRuntimeSession` 落库到 HarnessSession；START 类 Run 注入 `session.runtimeSessionRef`
   （`src/runtime/managed-agent-runtime.ts:245-269`）。Checkpoint 恢复走自己的引用，不冲突。
3. **对话流**：会话所有消息统一用 `conversation.id` 作 `harnessSessionId`
   （`harness-http-api.ts:516`）→ 第二条消息的 Run 自动续接第一条的 Pi 上下文。
4. **并发安全**：同一会话的 Run 被调度器串行化（`tenant-run-scheduler.ts`），会话文件不会并发打开。
5. **测试证据**：`tests/integration/stage1-stage2-control-plane.e2e.test.ts:379`
   「连续对话：后续 Run 将已持久化的 Runtime Session 注入 Adapter」——第二个 Run 的请求携带
   第一个 Run 绑定的会话引用（`fake-session-${first.id}`）。

### 文档修正

- 手册 §14 标题改为"核心已实现"，14.3 表格逐行标注落实状态，14.5 诚实标注重写（附上述证据）。
- 剩余待办（保留为低优先级）：① 14.3#2 COMPLETED 续接 API（对话流程已可续上下文，此项仅为
  API 便利性）；② 14.4 用户显式 compact 透传；③ PiAdapter `OPEN_EXISTING` 分支缺真实 Pi 会话
  文件的集成测试（现有证据止于请求注入层）。

**教训**：本清单第 0 版把手册的"待实现"当成了代码现状。后续对账一律以代码 + 测试为准，
文档声明只作线索（本次 A2/A3 均因此改写）。

## §7 A3 修复记录：Pi 主流量接入网关 + 流式 usage 采集（2026-09-09）

**问题**：Pi 的 models.json 直连 vLLM（18000），网关不在 agent 主流量上；且 usage/缓存命中
指标只从非流式 JSON 响应提取，而 Agent 推理以流式为主——真实场景下 `llm_cache_metrics` 基本为空。

### 修复内容

| 改动 | 文件 | 说明 |
|---|---|---|
| 流式 usage 采集 | `src/llm-gateway/llm-gateway.ts` | ① 客户端未声明 `stream_options` 时注入 `{ include_usage: true }`（vLLM 据此在 SSE 末尾附带 usage chunk）；② SSE 透传改为经 TransformStream **旁路扫描** `data:` 行——响应字节零改动，末尾 usage chunk 计入同一张缓存台账（环形缓冲 + SQLite sink）；③ `LLM_STREAM_USAGE_CAPTURE=0` 可关（防后端拒绝未知字段） |
| 配置项 | `src/app/harness-config.ts`、组合根 | 新增 `llmStreamUsageCapture`（默认开） |
| Agent 专用低权限凭证 | 组合根 + `harness-config.ts` | 新增 `HARNESS_AGENT_API_KEY`：启动时幂等创建 `tenantId: "agent-runtime"`、仅 `models:generate` scope 的凭证。Pi 经网关调用模型用这把钥匙——与人工 bootstrap key（`["*"]`）分离，最小权限、可独立撤销、审计可归因 |
| Pi 流量指向网关 | `deploy/qwen38-vllm-models.json` | baseUrl 从 `18000`（vLLM 直连）改为 `13000`（网关），并加 `apiKey` 字段（Pi models.json schema 原生支持，node_modules/pi SDK model-config.d.ts:213）；填入 `HARNESS_AGENT_API_KEY` 的值 |
| 部署说明 | `deploy/qwen38-harness.env.example` | 记录 `LLM_STREAM_USAGE_CAPTURE` 与 `HARNESS_AGENT_API_KEY` 的用法 |

### 验证证据

- `tests/llm-gateway/stream-usage.test.ts`（4 个新测试，网关共 30 全绿）：
  ① 注入 include_usage + 末尾 usage chunk 计入台账（promptTokens=120/cached=96，命中率 0.8），
  且**响应字节与上游逐字节一致**；② 客户端自带 `stream_options` 不被覆盖；③ 采集关闭时不注入不采集；
  ④ 无 usage chunk 的普通流不受影响。
- 全量回归：366 pass / 0 fail / 4450 断言，`tsc --noEmit` 干净。

### 诚实边界（陈述时不越界）

- **真机复验待补**：接线与采集已由 mock 上游测试证明；真实 vLLM（18000/18001）+ Pi 的端到端
  需在 GPU 服务器上跑一次（与 A6000 对照实验同一批真机验证）。
- **RouteDecision 仍未持久化**（重启即丢，内存环形缓冲）；流式响应的 RouteDecision 不含 token 数
  （token 走缓存台账）。持久化决策记录仍是后续项。

## §8 B1+B2 修复记录：WAITING_TOOL 接线 + 登录侧信道/阻塞修复（2026-09-09）

### B1：`WAITING_TOOL` 从死状态变为有写入方的真实状态

**方案取向**：状态机、迁移 CHECK 约束、恢复扫描（`listStale` 把 WAITING_TOOL 与 RUNNING 同等对待）、
三个 UI 都已为它建好，删除成本反而高于接线；且接线后"Run 正在执行工具副作用"成为可观测事实，
与支柱 0/1 的恢复叙事互补。选择**接线**而非删除。

| 改动 | 文件 | 说明 |
|---|---|---|
| 工具阶段回调 | `src/runtime/worker-process-runtime.ts` | 新增 `onToolExecutionPhase(runId, "STARTED"\|"ENDED", {toolName, toolCallId})`：治理桥 prepare 裁决 PREPARED（放行）前触发 STARTED，complete 落账后触发 ENDED |
| 状态迁移 | `src/runs/run-service.ts` | 新增 `markToolPhase`：RUNNING→WAITING_TOOL 记 `TOOL_STARTED`，WAITING_TOOL→RUNNING 记 `TOOL_COMPLETED`（事件序号接续 `getLastEventSequence`）；非预期状态（终态/QUEUED/INTERRUPTED）下**静默忽略**迟到回执，不覆盖终态事实 |
| 组合根接线 | `src/app/create-harness-application.ts` | runService 晚绑定引用（runtime 先于 RunService 创建），回调异常仅记日志不阻断工具执行 |

**时序语义**：先落 WAITING_TOOL 再向 Worker 回 ALLOWED——Worker 真正执行副作用时状态已如实。
Worker 在工具执行中崩溃时收不到 ENDED，Run 停在 WAITING_TOOL，恢复扫描与 RUNNING 一视同仁
转 INTERRUPTED（这正是恢复层早就预期该状态的原因）。

**诚实边界**：仅 Worker（默认 process 隔离）模式接线；in-process 模式下工具在 Master 内联同步执行，
无"等待工具"窗口，不产生该状态——两种模式的状态可见性差异已在手册边界内。

**测试**：`tests/runs/run-service-tool-phase.test.ts`（2 个新测试）：① RUNNING↔WAITING_TOOL 往返
+ TOOL_STARTED/COMPLETED 事件与序号断言；② QUEUED/COMPLETED 下迟到回执被忽略、不产生工具事件。

### B2：登录时序侧信道 + 事件循环阻塞

| 改动 | 文件 | 说明 |
|---|---|---|
| 邮箱枚举侧信道 | `src/auth/api-credential-store.ts` | 未知邮箱分支也执行一次完整 scrypt 校验（缓存的 dummy hash，固定盐 + 永不匹配口令），已知/未知邮箱的响应时间对齐 |
| 异步 scrypt | 同上 | `scryptSync` → promisified `scrypt`，`registerUser`/`loginUser` 变 async，密码推导不再阻塞 Bun.serve 事件循环 |
| 调用方适配 | `src/http/harness-http-api.ts` | `accessControl` 接口签名改 Promise，路由内 `await` |

**测试**：`tests/auth/api-credential-store.test.ts`（3 个新测试，此前登录链路零测试覆盖）：
① 注册/登录/会话鉴权/撤销全流程；② 已知+错密码与未知邮箱均拒绝（dummy 路径被真实执行）；
③ 同口令两次注册盐不同。

## §9 B3–B7 修复记录：恢复语境 + 队列对账 + 会话归属 + 预算接线（2026-09-09）

### B3：恢复续跑携带原始任务语境

新增 `buildRecoveryContinuationInput(userInput, checkpointId)`（`src/runs/run-service.ts`），
三处硬编码全部替换：RecoveryExecutor 的 AUTO_RESUME 提交、QueuedRunRecoveryService 的启动重建、
HTTP 手动 resume 的缺省续跑输入。续跑 prompt 现在包含：原始任务全文 + 恢复点标识 +
"已确认成功的工具结果会被自动复用，不要重复执行已完成的副作用"。

### B4+B5：队列 DB 对账（reconcileQueuedRuns）

`RunQueueCoordinator` 新增 `reconcileQueuedRuns()`（每次 `drainOnce` 前调用，组合根注入
`queuedRunReader: runStore`）：

1. **B5 孤儿补回**：DB 仍 QUEUED 但不在内存队列的 Run（claimNext 与 release+re-enqueue
   之间崩溃、executeQueuedRun 启动前抛错等 TOCTOU 窗口的遗落）自动重新入队；
2. **B4 TTL 不依赖 pump 存活**：对 DB 侧超过 `queueTtlMs` 的 QUEUED Run 熔断为
   FAILED(QUEUE_TIMEOUT)——无论它在不在内存队列；
3. **排队时钟持久化**：恢复/补回入队的 `enqueuedAt` 一律取 DB `updated_at`（进入/回到
   QUEUED 的时刻），重启不重置 TTL 时钟，等待时间跨重启累计。

排队原因（reasonCode）事实链：由既有 `QUEUE_BLOCKED` 事件持久化在 run 时间线；
重启后 `synchronizeQueueBlockers` 依据当前调度状态重新推导并继续折叠重复项。
**诚实边界**：reconcile 在 drain 内执行，pump 完全停止期间不会跑——但进程重启后的
第一次 drain 即补上，与"单机控制面 + 启动恢复"的定位一致。

### B6：会话归属校验（防抢注）

- `RunStore.findSessionOwner(harnessSessionId)`：以最早一条 Run 的租户为会话归属，
  null = 未被任何租户使用；
- `POST /runs` 对客户端自选的 `sessionId`/`harnessSessionId` 做校验：**首次使用即认领**
  给提交租户；已被其他租户使用 → 409（归属租户复用放行，全新 id 放行）；
- 对话路径（`POST /conversations/{id}/messages`）本就经 `getForTenant` 归属校验，不受影响。

**语义选择**：没有改成"服务端一律签发新 id"——那会破坏直接 `POST /runs` 续用同一会话的
合法用法；"首次使用即认领"以服务端持久化事实为准，既防抢注又不破坏续聊。

### B7：预算/fair-share 策略接线（opt-in）

- 新增 `SchedulerCapacityBudgetUsage`（`src/resources/budget-aware-policy.ts`）：用量源
  直接取调度器活跃 Run 计数（units/run = 1），与调度器强一致，无需在 Run 生命周期另插
  账本记账；`ResourceLedger` 保留为将来 token/GPU 分钟粒度计费的替换件；
- 配置：`HARNESS_TENANT_BUDGETS`（JSON：`{"team-a":{"weight":2,"maxUnits":8}}`）→
  `config.tenantBudgets`；**空 = 不启用**，admission 行为与历史完全一致；
- 非空时组合根把 `BudgetAwareExecutionPolicy` 叠加在 `DeterministicExecutionPolicy` 之上：
  基础策略 START 后还需租户用量 < min(fairShare, maxUnits)，否则降级为
  QUEUE(TENANT_BUDGET_EXCEEDED)（协调器、QUEUE_BLOCKED 事件、排队原因链路已天然支持）。
  `TENANT_BUDGET_EXCEEDED` 由死代码变为可观测的生产行为。

### 验证证据（8 个新测试）

- `tests/scheduling/queue-reconcile.test.ts`（3）：孤儿补回且 enqueuedAt 取 DB；重启后
  DB 侧超 TTL 熔断（注入时钟，不 sleep）；一致状态零动作。
- `tests/scheduling/queued-run-recovery.test.ts`（1）：启动恢复重建的续跑输入包含原始任务
  全文与 checkpoint id，且不再是空泛指令。
- `tests/resources/budget-policy-wiring.test.ts`（3）：maxUnits 占满 → TENANT_BUDGET_EXCEEDED；
  未配置租户不受影响 + fair-share 按权重分摊；config 解析（合法/非法/缺省）。
- `tests/http/session-squatting.e2e.test.ts`（1）：完整 HTTP 栈（注册→登录→建 workspace→
  提交）验证 202 认领 / 409 抢注 / 归属租户放行 / 新 id 放行。
- 全量：**379 pass / 0 fail / 4516 断言**，`tsc --noEmit` 干净。

## §10 D 级卫生项处置记录（2026-09-09）

### 已修复（D1–D7、D9）

| # | 修复 |
|---|---|
| D1 | `EvaluationAggregator` 构造时持有一个 `LlmCacheMetricsStore`，`computeLlmCacheMetrics` 纯委托 `aggregate()`——缓存指标 SQL 唯一来源，删除逐字重复的第二份 |
| D2 | `listRunMetrics` 从逐 Run 点查 6 张表（N+1）改为**每表一次批量读取**（`GROUP BY run_id` / `DISTINCT` / 全量集合），再装配回每个 Run；装配逻辑抽为 `toRunMetrics` 与单 Run 点查共用同一口径。查询数从 O(Run 数) 降为 O(表数) |
| D3 | `GET /resources` 不再 `void principal;`——响应显式标注 `visibility: "HOST_WIDE"` 与 `requestedByTenant`，把"主机级共享 GPU 遥测（不含跨租户数据）"从**遗漏的过滤**变为**有意的可见性决策**；principal 保留供未来租户切片视图 |
| D4 | ① 资源级审计：`RUN_SUBMIT` / `RUN_INTERRUPT` / `RUN_RESUME`（含各拒绝分支 DENY）/ `SESSION_REVOKE(_ALL)` 直接记 `resourceType=RUN|SESSION` + `resourceId`；② 鉴权 DENY 记录被尝试密钥的 **SHA-256 摘要**（新列 `attempted_key_digest`，migration v22；不存明文）；③ `GET /audit?limit=&offset=` 分页（默认 200、上限 500） |
| D5 | 平台仪表盘删除 `#key=` URL 片段注入 API Key 的入口（URL 片段会进浏览器历史/代理日志）；Key 只经输入框手动粘贴存 sessionStorage，且加载时清掉历史遗留的 hash |
| D6 | Workspace 根目录前缀检查改用 `path.sep`，消除 Windows 语义错误 |
| D7 | `logout` 对无效/已撤销 token 返回 401（不再静默成功）；新增 `DELETE /auth/sessions` 撤销当前用户全部活跃会话（"退出所有设备"）；`revokeSession` 返回布尔。**保留边界**：session token 仍为 7 天长 token、无轮换/refresh 机制（与 API key 无 TTL 同属已文档化的身份边界） |
| D9 | 故障注入整体搬入独立模块 `src/worker/worker-fault-injection.ts`，worker-main 仅在 `HARNESS_WORKER_SIMULATE` 显式设置时**动态 import**——默认生产入口不含任何注入代码路径。全部注入模式（corrupt_stdout/crash_exit/crash_sigkill/fail_run/hang/hang_stubborn/tool_roundtrip/tool_after_prepare/mock_stream）行为不变，真实子进程测试全过 |

### D8：审计误判改判（先验证、再动手的实例）

原判"Checkpoint 归属校验是应用层的，数据库无 FK 兜底"经实证复核**不成立**：
schema 中 `checkpoints` 一直带有 `run_id → agent_runs(id)` 与
`(tool_execution_id, run_id) → tool_executions(id, run_id)` 两组外键，
且 `openHarnessDatabase` 连接默认 `PRAGMA foreign_keys = ON`。
实验：绕过应用直写数据库插入"指向不存在 Run 的 Checkpoint"与"工具执行与 Run 不匹配的
Checkpoint"均被 SQLite 以 `FOREIGN KEY constraint failed` 拒绝（v21 schema、未加任何触发器）。
**处置**：不加冗余触发器；新增回归测试
`tests/storage/checkpoint-ownership.test.ts` 把该行为钉住；应用层校验（RecoveryService）定位
为双保险。本条与 A2 同型：文档/审计结论必须以代码 + 实测为准。

### 验证证据

- `tests/storage/checkpoint-ownership.test.ts`（1）：孤儿 run / 跨 run 工具执行 / 合法写入三种直写场景。
- `tests/auth/api-credential-store.test.ts`（+2）：logout 布尔语义 + 会话归属归因；revokeAllSessions 只作用于本人。
- `tests/audit/access-audit-store.test.ts`（+2）：attemptedKeyDigest 落库且不存明文；limit/offset 分页与钳制。
- `tests/http/session-squatting.e2e.test.ts`（+1）：HTTP 全栈断言 RUN_SUBMIT 资源级审计、/audit 分页、/resources 的 `visibility:"HOST_WIDE"`、登出 401/200/401 语义。
- 全量：**385 pass / 0 fail / 4552 断言**，`tsc --noEmit` 干净。

## §11 B11 修复记录：调度启动与并发中断竞态（2026-09-10，A6000 真机发现）

### 现象（真机 harness.log）

A6000 场景 S4 中断测试后，harness.log 出现重复的 `RunQueuePump 推进失败`：
`非法的 AgentRun 状态转换：INTERRUPTED -> RUNNING`，栈指向
`executeQueuedRun → store.update → assertValidTransition`。

### 根因

`executeQueuedRun`/`executeQueuedResume` 在"读状态"与"写 RUNNING"之间无原子性：
读到 QUEUED 后无条件推进 RUNNING。当用户中断一个还在排队/等待恢复执行的 Run
（QUEUED → INTERRUPTED 落库），而 pump 已把它 claim 出内存队列、正在启动时，
启动写入撞上 DB 层状态机断言抛错——错误逐轮冒泡到 pump 的 onError 日志。
DB 层的乐观并发（`WHERE status = $previousStatus` + 状态机断言）行为正确，
缺的只是启动方对"并发接管"的优雅处置。

### 修复（src/runs/run-service.ts）

1. `executeQueuedRun`/`executeQueuedResume` 入口：Run 已不是 QUEUED 且落点为
   `INTERRUPTED`/`FAILED`（被用户中断 / 排队超时熔断接管）时，**放弃启动、
   返回当前状态**，由调度器 finally 释放 slot；其余非 QUEUED 状态仍抛错
   （如对 COMPLETED Run 重复执行的原语义不变）。
2. 两处 `QUEUED -> RUNNING` 写入包 try/catch：写入失败时重读 DB，若已离开
   QUEUED（并发中断/熔断先赢）则静默放弃启动——此时 Runtime 尚未订阅、
   `runtime.start/resume` 尚未调用，无孤儿 Worker。

### 验证证据

- 新增 `tests/runs/run-service-queued-start-race.test.ts`（5 用例）：
  重入队毒丸防护 / QUEUED→RUNNING 写入竞态注入（子类 Store 模拟并发中断先赢）/
  排队超时熔断后的启动放弃 / 恢复排队中被中断 / 恢复写入竞态注入。
- 全量：**396 pass / 0 fail / 4591 断言**，`tsc --noEmit` 干净。
- A6000 真机：同步代码重启后 S4 中断复测 + pump 日志不再出现非法转换。

## §12 N1–N4 修复记录：全场景 campaign 真机发现（2026-09-10）

来源：[全场景测试报告 §4.1](full-scenario-test-report-20260910.zh-CN.md)（campaign-20260910-01，
独立实例 13001，E1 真实模型链路）。用户确认工作台真实不可用后当日全部修复并复验。

| # | 级别 | 问题 | 根因 | 修复 | 证据 |
| --- | --- | --- | --- | --- | --- |
| N1 | **P0 UI** | 用户工作台 `/app` 浏览器内白屏死壳：内联脚本解析即失败，auth/app 双 `hidden`，有 token 也进不去 | 客户端 JS 整段活在 TS 模板字面量里：`\r\n?`、`join('\n')` 被模板级转义吃成真实控制字符（首个致命点 `markdown()` 正则）；`\s \d \] \( \*` 等也被静默丢弃，多数正则"碰巧"仍可解析但语义已错。字符串级冒烟抓不到 | 客户端 JS 抽出为独立文件 `src/http/user-console-client.js`，TS 侧 `readFileSync` 注入模板（`${USER_CONSOLE_CLIENT_JS}`），消灭模板转义整类问题；新增 N1 回归测试：对每段 `<script>` 做 `new Function` 解析断言 | 真浏览器端到端：注册→登录→建 Workspace→UI 发任务→回答 UI-FIX-OK / 17×23=391→刷新恢复 全通过 |
| N2 | C 运维 | kill -9 重启对账窗口 pump 抛 `HarnessInstance 无法获取执行槽位` 异常栈（瞬态竞争被当事故） | 重启后 DB 实例行 actual_state 未就绪，第一批启动尝试必失败；协调器无差别抛给 onError | 新增 `InstanceSlotUnavailableError`；协调器识别后先 release 再重新入队（reasonCode `INSTANCE_NOT_READY`）返回 DEFERRED，下一轮 pump 重试 | `tests/scheduling/instance-not-ready-defer.test.ts` |
| N3 | C 产品 | 受环境约束未完成任务（bash 被 fail-closed 拒绝）终态仍 COMPLETED，状态栏无法与真完成区分 | 无"受限完成"的结构化出口，只有 finalText 文本 | 新增 `src/policies/run-limitations.ts`：DENY 账本聚合；`GET /runs/:id` 新增 `limitations`（toolName/reason/count/lastDecidedAt），不改状态机语义 | 活体验证：bash 拒绝任务 COMPLETED 且 `limitations=[{bash, 拒绝原因, 1}]`；`tests/policies/run-limitations.test.ts` |
| N4 | 观察项 | 网关 backendStates `healthy:false` 与真实可用矛盾（探活 404 但请求正常） | 默认探活 `{baseUrl}/health`（vLLM 无此路由）；且 baseUrl 已含 `/v1`，`/v1/models` 默认会拼成 `/v1/v1/models` | 默认探活路径改 `/models`（拼出 `/v1/models` OpenAI 标准端点），`LLM_HEALTH_PROBE_PATH` 可覆盖；头注释更正错误假设 | 真机复验 `healthy:true`；G02 故障注入回退行为不变（load-balancing 31 测试全过） |

全量：**396 pass / 0 fail / 4591 断言**，`tsc --noEmit` 干净（N1–N4 新增 4 个回归测试）。

## §13 第二轮补测发现（2026-09-10，campaign-20260910-01 续测）

来源：[全场景测试报告 §8](full-scenario-test-report-20260910.zh-CN.md)。覆盖矩阵与未执行项见该节，未执行不等于通过。

| # | 级别 | 问题 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| N5 | 部署/配置（高） | 资源准入默认按 host 显存已用比例（BUSY 70%/CRITICAL 90%）判定，而 vLLM 默认预分配约 90% 显存 → 平台仅凭自身模型服务就会长期判 CRITICAL，任务批量排队后按 TTL 熔断（含 13 字符小任务） | `QUEUE_BLOCKED reasonCode=RESOURCE_CRITICAL`；GPU 44.9/49.1GB 中 vLLM 占 42.1GB；多个 `QUEUE_TIMEOUT` | 未改默认（避免影响他部署）；按部署校准 93%/98% 后恢复。建议文档明确阈值必须按推理框架预分配校准，或以 KV cache/请求数为主判据 |
| N6 | **P1** | 网关模型请求超时硬编码 60s 且无环境变量：长输入/长输出每次调用 ~60s 被掐断，重试 4 次后报 `Stream ended without finish_reason`；超限输入报 `400 status code (no body)`，用户无法判断 | C03-L3 事件链 4×~60s `stopReason=error`；C08-512 同因失败 | **已修复**：`LLM_REQUEST_TIMEOUT_MS`（默认 300s）接线 + 失败原因归类。复验：50k 字符任务 FAILED→109s COMPLETED；超限任务给出"模型后端拒绝请求（HTTP 400，常见原因：输入超出模型上下文上限）"。测试 `tests/runs/model-failure-classification.test.ts` |
| N7 | UI（中） | 工作台连点两次发送会提交两个任务并都执行（无在途防重/幂等） | 浏览器实测两条 88+88 回答 | 未修，建议禁用按钮 + runId 去重 |
| N8 | API 契约（中） | 78 万字符输入被 202 接受后才在模型侧 400 失败；提交响应回显全量 userInput（响应体同量级） | C04：body 780KB→202→FAILED(400) | 未修，建议提交期上界校验（413/400）且不回显全量输入 |
| N9 | 观察 | 未知模型返回 503 `no_available_backend`（语义清晰但非常见 404） | evidence/cases/G04.json | 记录 |
| N10 | 观察 | 洪泛下正常租户尾延迟可达 215s（无永久饥饿） | evidence/cases/Q05.json | 记录 |
| N11 | 测试稳定性 | `worker-process-runtime` 的 corrupt_stdout 用例 5s 预算对真子进程偏紧，偶发超时（实测 5.00s 失败 / 3.21s 通过） | 2026-09-10 两次重跑对照 | **已修**：该用例时限放宽到 15s 并注明原因 |

回归基线：**399 pass / 0 fail / 4598 断言**（新增 3 个 N6 测试）。

## §14 第三轮：E2 容器隔离真机执行发现（2026-09-10，campaign-e2-20260910）

背景：此前把 S05–S08/G09/G10/X10 记为"环境 BLOCKED（本机无 runsc）"。本轮实际把 gVisor 装上了，场景全部跑通，并发现下列问题。
安装方式：`runsc release-20260817.0`（SHA-512 校验通过）→ `/usr/local/bin/runsc` → `daemon.json` 注册 → `systemctl reload docker`（SIGHUP 热加载，**未重启 dockerd**：PID 260689 不变，22 个 `polar-*` 容器全程未受影响）。

| # | 级别 | 问题 | 根因 | 修复 | 证据 |
| --- | --- | --- | --- | --- | --- |
| N12 | **隔离/资源（高）** | 沙箱进程数**完全不设上限**：`OciSandboxSpecCompiler` 对 runsc 不下发 `--pids-limit`（本项目自己的 `smoke:container:attacks` 因此报 "PID 耗尽没有返回受限结果"） | 代码注释断言"Docker 的 runsc 集成在受支持镜像上启动阶段会拒绝 `--pids-limit`"。实测该断言在 `release-20260817.0` 上不成立：容器正常启动；不传参数时 900/900 个子进程全部创建成功，传 `--pids-limit 128`/`512` 时分别约在 **40 / 229** 个子进程处被拦停 | **已修复**：runsc 与 runc 统一下发 `--pids-limit 128`；`pidLimitEnforced` 变为 true；`tests/sandbox/container-sandbox-provider.test.ts` 增加断言 | `evidence/runsc-install.txt`、`evidence/n12-pids-limit-probe.txt`；修复后 `smoke:container` 与 `smoke:container:attacks` 全 PASS |
| N13 | **安全 P0（已修复）** | 容器 Secret 明文可从宿主读出：创建期出现在 docker CLI argv，创建后长期留在容器 `Config.Env`，任何 docker 组成员 `docker inspect --format '{{json .Config.Env}}'` 即可获取。指南 S06 规定"已知 argv 风险如复现必须 FAIL" → S06 判 FAIL | `OciSandboxSpecCompiler` 用 `--env NAME=__HARNESS_SECRET_…__` 占位、由 `withSecretValues` 在短生命期 argv 内替换为明文；容器起来后该明文即固定在其环境里 | **已修复**：Secret 不再进入容器创建参数（连占位符也没有），改为执行期 `docker exec --env NAME`（只带名字），明文由 docker CLI 从客户端进程环境取值，因此既不在 argv、也不写进容器 `Config.Env`。残留边界：同机同用户仍可读 docker CLI 子进程的 `/proc/<pid>/environ`（与 owner 权限同级，远窄于原先“任何 docker 组成员 docker inspect 可读”） | `evidence/cases/s08-s06-sandbox-limits.json`（`hostVisibleSecretLeak=true`）；直连复现 `docker inspect` 返回 `["TOKEN=PLAINTEXT-CANARY-DEMO", …]` |
| N14 | 观察（隔离语义） | gVisor 下触达 PID 上限会**终结整个沙箱**：`docker exec` 随后报 `container … is not running`（runsc 收尾 `urpc … WaitPID failed: EOF`）；runc 只是 fork 失败、容器继续存活。harness 能把前者正确对账为 `LOST` 并发事件、无残留容器（fail-closed 收敛正确），但"一条命令吃满 PID"会连带中断该 Run | 两个 runtime 的 cgroup/进程模型不同 | 记录，不改；建议文档写明该差异 | `evidence/cases/s08-s06-sandbox-limits.json`（`sandboxStillRunning=false`）、`scripts/e2-container-failure.ts` |
| N15 | 产品缺口（中） | **没有任何产品入口可配置租户/运行的资源限额与授权 Secret**：`PolicyRegistry.setTenantPolicy/setPlatformPolicy` 仅被测试调用，HTTP 无对应路由，`StartRunInput.runPolicy` 无调用方 → 每次运行都落在 `unrestrictedPolicy`（CPU/内存无限额、无 Secret）。因此 S06/S08 只能在 Provider 边界用自建 policy 验收，真实产品路径无法表达"受限租户" | 策略模型（TENANT 层、resourceLimits、allowedSecrets）已具备，但缺少配置面 | 未改；建议补管理面（或环境变量/模板层）以落地多租户资源配额 | 报告 §8.4；`src/app/create-harness-application.ts` 无 `setTenantPolicy` 调用；`submitRun` 不接受 runPolicy |

回归基线：**399 pass / 0 fail / 4600 断言**（N12 新增 2 条断言），`tsc --noEmit` 干净。
附加可复现工具：`scripts/e2-sandbox-limits.ts`、`scripts/e2-warm-pool.ts`、`scripts/e2-container-failure.ts`。

### X05 补测（同日，E2 实测通过）与 N16

X05 原本因"缺真实写盘夹具"记 BLOCKED。改用真实 bash 工具构造窗口后已实测通过：夹具命令 `echo <marker> >> /workspace/x05-marker.txt; echo APPEND_DONE; sleep 30`——追加在工具开始后立刻完成，而 COMPLETE 回执要等 sleep 结束，这段窗口就是剧本要求的"已保存 PREPARED、已真实写盘、COMPLETE 未提交"。窗口内 `kill -9` 该 Run 的 Worker 子进程（`pgrep -P <master>` 定位）。

| 观测点 | 实测 |
| --- | --- |
| 崩溃前 | `tool_executions.status=PREPARED`、`effect=UNKNOWN_EFFECT`，marker 文件已含 1 次 |
| Run 收敛 | `FAILED`，原因 `WORKER_CRASHED: exitCode=137, signal=SIGKILL` |
| 伪成功 | 无：工具未被改写成 SUCCEEDED |
| 恢复尝试 | `POST /runs/:id/resume` 被诚实拒绝（`Run 没有可用 Checkpoint`） |
| 副作用次数 | marker **恰好 1 次**，恢复未触发不安全重放 |
| 邻居 B | 并发正常任务 COMPLETED |

| # | 级别 | 问题 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| N16 | 体验缺口（中） | 工具停在 `PREPARED/UNKNOWN_EFFECT`（副作用可能已发生）后，**没有产品流程让用户/运维确认并消解该状态**：resume 因无 Checkpoint 被拒，Run 停在 FAILED，界面无法表达"该命令可能已执行过，请人工核对" | `evidence/cases/x05.json` | 未修（产品设计选择）；建议给 UNKNOWN_EFFECT 一个显式的"人工确认/标记已核对"出口 |

证据：`campaign-e2-20260910/evidence/cases/x05.json`；驱动 `e2_x05.py`。

## §15 第三轮补跑：G03/C06 与 N17/N7/N8 修复（2026-09-10）

来源：[报告 §8.5](full-scenario-test-report-20260910.zh-CN.md)。

| # | 级别 | 问题 | 根因 | 修复 | 证据 |
| --- | --- | --- | --- | --- | --- |
| N17 | **网关可用性（中）** | 后端在 `finish_reason` 之前断流时：①网关只按 HTTP 首包状态判成功，断流不算后端失败；②`recordSuccess` 在首包时就执行、把失败计数清零。两者叠加 → 熔断器永不打开、健康备用后端永不被使用，重试一直撞同一个坏后端 | 成功/失败记账发生在 `tryBackend` 返回时，而流式响应此时只拿到了响应头 | **已修复**：流式响应统一经包装器，成败裁决推迟到流结束（`finish_reason`/`[DONE]`→成功，提前断开→失败，下游 cancel 不计）；`deferOutcomeToStream` 阻止首包即记成功。包装器保持按需拉取（`highWaterMark:0`），字节原样透传 | G03：修复前 5 次掐断 → Run `FAILED`；修复后 3 次掐断 → 熔断 → 健康后端接管 → `COMPLETED`。回归 `tests/llm-gateway/stream-usage.test.ts` "N17" 用例 |
| N7 | UI（中） | 连点两次"发送"提交两个任务并都执行 | 前端无在途防重 | **已修复**：`sendMessage` 加 `S.sending` 守卫（置位前先判、成败都复位）+ 在途禁用发送按钮 | 真浏览器同一 tick 双触发 → 服务端仅 1 个 Run；后续单次点击仍正常产生新 Run。回归 `tests/http/user-console.test.ts` "N7 回归" |
| N8 | API 契约（中） | 78 万字符输入被 202 接受后才在模型侧 400 失败；提交响应回显全量输入 | 提交期无上界校验 | **已修复**：`HARNESS_MAX_USER_INPUT_CHARS`（默认 100,000）→ 超限 **413** 且不创建 Run；提交响应只回显 200 字符摘要（`userInputTruncated`/`userInputLength`） | 真机 780,000 字符 → 413；正常输入 202。回归 `tests/http/harness-http-api.test.ts` 两条 N8 用例 |

### 同轮观察（未修）
- **C06 截断不告知模型**：工具输出 253,890 字节被收敛到 ~104KB，但截断事实没有传给模型，模型据此回答"输出没有被截断"。属体验缺口，非正确性问题。
- **Pi bash 工具在容器内偶发临时文件缺失**：C06 首次两次工具调用报 `sh: can't open /tmp/pi_bash_stdout_<ts>: no such file`，第三次成功。属 Pi 库在容器模式下的行为，未做根因定位。
- **共享机上 llama-server（PID 3815946, 端口 48809）进程存活但已不监听**：与本轮操作无关（无主机级 OOM；当日 8 次 OOM 全部是自有 128MiB 测试沙箱的 cgroup OOM，唯一主机级 OOM 发生在 9 月 9 日且是 cpptools）。登记备查。

回归基线：**403 pass / 0 fail / 4620 断言**，`tsc --noEmit` 干净。

## §16 第四轮：故障与恢复批次（2026-09-10）

来源：[报告 §8.6](full-scenario-test-report-20260910.zh-CN.md)。全部在一次性实例（13004）上用故障夹具执行。

| # | 级别 | 问题 | 根因 | 修复 | 证据 |
| --- | --- | --- | --- | --- | --- |
| N18 | **恢复正确性（高）** | 损坏的 Checkpoint（`runtime_session_ref` 指向不存在文件）在恢复时被静默忽略：Run 照常 `COMPLETED`，日志零告警，用户不知道这次恢复没有续接此前会话上下文 | 恢复路径只校验 Checkpoint 归属（runId 匹配），不校验其引用的会话是否真的可打开；打不开时按新会话继续 | **未修**。建议：恢复前校验 `runtime_session_ref` 可达，不可达则拒绝自动恢复并转 MANUAL_REVIEW（与"未知副作用不得自动重放"同一原则） | `evidence/cases/r10.json`：`httpStatus=202`、`runStatus=COMPLETED`、`failureReason=null` |
| N19 | **恢复可用性（高）** | Run 执行中被 SIGTERM 重启后，该租户 `harness_instances` 停在 `actual_state=FAILED, active_run_count=1`（槽位泄漏）；此后该 Run 每次恢复都 `RESUME_FAILED: HarnessInstance 无法获取执行槽位` 后被重新入队，形成 **INTERRUPTED↔QUEUED 活锁**，每轮还真实创建/销毁一个沙箱 | 两处叠加：①重启时在执行的 Run 的 instance 槽位未释放、状态未回到可服务；②N2 的 INSTANCE_NOT_READY 重新入队与运行期 `markRuntimeInvocationFailureInterrupted` 同时生效，前者重排、后者把 Run 打回 INTERRUPTED，二者互相抵消 | **未修**。建议：启动对账时把 `active_run_count` 归零并把实例置回 READY（或显式 FAILED 且不参与调度）；同一 Run 的 INSTANCE_NOT_READY 重试要有上限，超过即转人工，避免活锁与沙箱 churn | `evidence/cases/r11-instance-livelock.txt`（**并附容器泄漏实证**：活锁期间每次失败的 RESUME 都真实创建了一个沙箱且无人回收，实测留下 2 个 `agent-harness-*` 容器） |
| N20 | **关闭顺序（中）** | SIGTERM 关闭途中 queue pump 仍推进 Run，工作区快照写入落在已关闭 DB：`RangeError: Cannot use a closed database`（同实例日志 20 次） | 关闭顺序为"停 HTTP → 停 pump → 关 DB"，但 pump 已启动的 tick 没有被 await，越过 DB 关闭 | **未修**。建议：关闭时先 await 在飞 tick 与执行中的 Run 收尾，再关闭 SQLite | 同上（日志第 1173/1188/1203 行） |

### 同轮通过项（不构成问题）
- **G04 网关错误矩阵 14/14 PASS**：401/400 不透传不误回退；429/500 回退且尝试次数有界；坏 JSON/坏 SSE/截断 SSE 不崩；usage 缺失不计、重复只计一次。
- **G08 PASS**：SQLite 忙 → 提交 409 `database is locked`（不伪造成功）；只读 → 启动 fail-closed；工作区只读（root 所有）→ 写入真实拒绝且不伪装成功；三种情况恢复后均能继续服务。
- **R11a/R11b PASS**：资源 CRITICAL 下恢复被准入拦下，停在 `QUEUED` / `reasonCode=RESOURCE_CRITICAL`。
- **R12 PASS**：终态 Run 拒绝 interrupt/resume；追加迟到/重复事件不改变终态。

## §17 第五轮：浏览器 UI 批次 B1（2026-09-10）

来源：[报告 §8.7](full-scenario-test-report-20260910.zh-CN.md)。一次性实例 13011（E1 / `managed-local`），独立租户 `ui-b1@example.test` 与两条对话；浏览器操作由主智能体执行（`browser-use` 为 main-agent-only，不得派子智能体）。

| # | 级别 | 问题 | 根因 | 修复 | 证据 |
| --- | --- | --- | --- | --- | --- |
| N21 | 前端渲染保真（中） | 行内代码中的下划线被当作 Markdown 强调吞掉：`` `new_python_script.py` `` 渲染为 `<code>new<em>python</em>script.py</code>`，显示与复制得到 `newpythonscript.py`。文件名/路径/标识符（如 `harness_instances`）普遍受影响 | `src/http/user-console-client.js:48-54` `inlineMd()`：第 49 行先把反引号内容包成 `<code>x</code>`，随后第 51–54 行的强调规则仍在**同一整串**上继续替换，因而进入 `<code>` 内部；第 54 行 `/(^|[^_])_([^_]+)_(?!_)/g` 命中 `_python_`，把两个下划线都吃掉 | **未修**。建议：先按"行内代码 / 普通文本"分段，只对非代码段套用强调规则；或让强调匹配不跨越 `<code>…</code>` | DOM 实测 `outerHTML` = `<code>new<em>python</em>script.py</code>`、`emphasisInsideCode=1` |
| N22 | 用户旅程正确性（中高） | 切换对话时，**迟到的轮询响应无条件覆盖当前页**：状态已是对话 B，页面却显示 A 的标题与 A 的消息（跨对话串扰）。用户在正文里对"进行中的任务"点停止/恢复时可能作用到错误对象 | `src/http/user-console-client.js:207-226` `refreshConversation()`：请求 URL 在调用时读取 `S.conversationId`，但响应处理里对 `S.conversation` / `S.runs` / `convTitle` 的赋值与 `renderThread()` 调用**没有任何"响应是否仍属于当前对话"的校验**。轮询每 1600ms 触发，内部还有 `loadOutput`/`loadFacts` 链式请求，窗口可达数百 ms 到数秒 | **未修**。建议：在响应入口比对 `body.conversation.id === S.conversationId`（或用请求序号/调用时快照做守卫），不一致即丢弃、不写 `S.runs`、不重渲染；并让 `openConversation` 立即 `stopPoll()` 而非等刷新完成后才重排 | `evidence/cases/U04/ui-b1-u04.json`：`state_conversation_id=B` 而 `rendered_title=A`、`rendered_first_user_message=A`；重开 B 后恢复 |

### 同轮通过项（不构成问题）
- **C09 PASS**：会话内 `script` 元素数 0、无 JS 弹窗，`<script>alert(1)</script>` 按**文本**渲染，emoji / ZWJ 家族 / 中文文件名均未损坏。防注入是**结构性**的——控制台先 `esc()` 再 `inlineMd()`，`<script>` 在任何 HTML 组装前已转义。证据 `evidence/cases/C09/`。
- **U08 PASS（下载部分）**：嵌套路径产物整段编码 `docs%2Fnotes%2Fhello.txt` → 200 / 9 字节 / 内容精确 `nested-ok`；不编码则 404，与指南 §5.3 契约一致。**滚动断言 INCONCLUSIVE**（长输出任务只产出 3 行，内容不够长），未计入通过。小 UX：产物 chip 只显示 basename，同名不同目录无法区分。

### 边界（非缺陷，但必须写进报告）

**不存在"E1 且能用 bash"的档位组合，一切含 bash 的场景实际都是 E2。**

- 现象：`managed-local` 档下 `bash` 工具被拒绝，错误文案「执行环境无法隔离 Workspace，拒绝 bash」。夹具子智能体在 13016（managed-local）上跑 T8 失败、改到 13017（container/runsc）才通过。
- 机制：`src/policies/tool-policy-guard.ts` 对 `bash` 的硬门槛——策略设了 `workspaceRoots` 而执行环境报不出 `filesystemIsolation=true` 时直接 `DENY`。`managed-local-sandbox.ts:115` 恒报 `false`，`container-sandbox-provider.ts:203` 报 `true`。
- 性质：**这是设计上的 fail-closed 安全边界，不是缺陷**。`sandbox-profile.ts:4` 的注释本身写明 development 档 deliberately 不是隔离档。
- 但推论需要修正文档口径：`HARNESS_SANDBOX_PROVIDER` 只有 `container` / `managed-local` 两个取值（`harness-config.ts:116/154` 是二元判断），所以 bash ⇔ container ⇔ **E2**。指南 §3.1 把 E1 描述为"Pi + 网关 + vLLM + GPU + process Worker"、暗示工具任务可在 E1 跑，与该实现不一致。
- 影响面：**55% 的 §9.2 负载组合**（T4/T7/T8/T10）以及 R01/R04/R07 都依赖 bash，因此容量与长稳只能在 E2 执行。这也意味着**容量数字里含容器获取/创建开销**，报告里必须说明这是 E2 口径。
- 附带约束：容器默认镜像 `alpine:3.20` **没有 python**，跑 T4「运行测试」必须换带解释器的镜像，否则会把"镜像缺依赖"误判成"模型失败"（指南 §3.4 已点名这条风险）。

### 模型能力数据点（非缺陷）

同一实例、temperature 0，仅改提示词措辞，Qwen2.5-7B 对同一道算术题给出**确定性**的不同答案：
- 「计算 17×23，只返回整数」→ `391`（发压器 `c2-60s-canon`，36/36 全对）
- 「只返回最终的整数结果，不要输出算式」→ `491`（`c2-60s`，**37/37 全错**，已独立复核）

对测试的含义：**T1 措辞必须冻结**，否则正确率统计会被措辞漂移污染。7B 量级的算术稳定性本身也是任务能力的真实边界，应在报告中如实呈现。

## §18 第六轮：功能场景批次 C（2026-09-10）

来源：[报告 §8.8](full-scenario-test-report-20260910.zh-CN.md)。实例 `campaign-func-20260910`（13013，managed-local）与 `campaign-func-e2-20260910`（container/runsc），均为独立租户。

| # | 级别 | 问题 | 根因 | 修复 | 证据 |
| --- | --- | --- | --- | --- | --- |
| **N23** | **公平性 / 可用性（高）** | **任何 ceiling=1 的租户永远无法启动任何 Run**。等权 3 租户（fairShare 各 1）全部 `admitted=false`，每个 Run 反复 `QUEUE / TENANT_BUDGET_EXCEEDED` 直到 TTL 失败；`maxUnits=1` 的租户同样饿死；ceiling≥2 正常 COMPLETED | `src/scheduling/run-queue-coordinator.ts:320` 在 `claimNext()` 之后向 base policy 传 `activeTenantRunCount - 1`（正确地扣掉刚 claim 的 Run），但 `src/resources/budget-aware-policy.ts:73` 的 `SchedulerCapacityBudgetUsage.activeUnits()` **绕过该修正**，直接重读 `scheduler.getCapacity(tenantId).activeTenantRunCount`（仍含刚 claim 的 Run）→ `availableUnits = ceiling - 1`，**ceiling==1 时恒为 0** | **未修**。建议：预算用量必须与 base policy 用同一份"已扣除 claim 中 Run"的口径——把 coordinator 修正后的计数传进 admission，或让 `activeUnits()` 不再二次重读调度器 | `evidence/cases/Q08/` + `q08-analysis.json`：三条 Run 均 `_contractAdmit=true` 而 `admitted=false`（base policy 本会放行，被预算层错误拦下），`contract_violation=true` |
| 观察（未定级） | 中 | 反复"带未决 QUEUED Run 重启实例"后 `harness_instances.active_run_count` 可残留（ACTIVE=1 而 Run 未启动），并出现 `/queue` 停在 `AWAITING_SCHEDULING` + `database is locked` | 同 N19 家族（重启时槽位未释放）。本轮由测试自身的重启风暴诱发，未做干净复现 | 建议独立跟进 | `evidence/q08-probe3.json` |

### 同轮通过项（不构成问题）
- **X04 PASS（E1/REAL）**：资源强制 CRITICAL 后 `resume` 返回 202 但停在 **QUEUED**（`QUEUE_BLOCKED reasonCode=RESOURCE_CRITICAL`，activeRunCount=0）；排队期间二次重启控制面仍 QUEUED、runId/checkpointId 不变；恢复 NORMAL 后**同一 runId** 推进为 COMPLETED，该租户 Run 数 2→2（**未新建 Run**），`RUN_RESUMED` 引用同一 Checkpoint、`userInput` 原样保留。
- **X06 PASS（E1/REAL + 网关故障 SIMULATED）**：L6（500,008 字符）→ **413** 且不创建 Run；超模型上下文（70,020 字符）→ 202→**FAILED** 且原因可读、无伪成功、无无限重试；L5（16,012 字符）→ COMPLETED；正常用户 B **3/3 COMPLETED** 且答对 391；503 代理命中 POST=7，`failureCount=3 / fallbackCount=3`，fault 后端 `circuitOpen=true`、vllm healthy；解除故障后全新 T3 COMPLETED。
- **R05 PASS（E2 / container+runsc，REAL）**：真实 bash 处于 `PREPARED / UNKNOWN_EFFECT`、marker 已真实追加 1 次、COMPLETE 未提交时 `kill -9` Worker → Run **FAILED**（`WORKER_CRASHED exitCode=137 SIGKILL`），工具未被写成 SUCCEEDED；marker 崩溃前 = 崩溃后 = resume 后 = **1**（**无不安全重放**）；`resume` → **409「Run 没有可用 Checkpoint」**（fail-closed）。**指南 §4.3 硬性不变量第 3 条未违反**。

### 边界 / 配置语义（非缺陷）
- `HARNESS_TENANT_BUDGETS` 的值含空格时必须用 shell 引号包裹。
- `LLM_BACKENDS=''` 会**显式禁用网关**，不会回退到 `VLLM_BASE_URLS`。

## §19 测试工具缺陷（T 系列）

> 下面两条是**测试工具自身的缺陷**，不是被测系统的缺陷。登记原因：它们会让已产出的数字失效，后续读者必须知道哪些结果不可信。

| # | 级别 | 问题 | 根因 | 修复 | 证据 |
| --- | --- | --- | --- | --- | --- |
| **T1** | **测试有效性（高）** | 发压器对 `workspace-diff` 的 **`modified` 桶恒为空**，导致 T4/T7/T10 的"diff 只含允许文件"判据退化为**恒真空判**——模型越权修改任何非允许文件都不会被发现（假 PASS 风险） | `load-driver.ts` 的 `pathOf(x)` 只认 `string \| {path:string}`；但真实 `modified` 条目结构是 `{before: WorkspaceFileSnapshot, after: WorkspaceFileSnapshot}`（`src/workspaces/workspace-snapshot.ts:13`），**没有顶层 `path` 字段** → 返回空串被 `clean()` 过滤 → `b.modified` 恒为 `[]`。`added`/`deleted` 是 `WorkspaceFileSnapshot[]`（有 `.path`），不受影响 | **未修**。一行修复：`pathOf` 增加 `if (x?.after?.path) return x.after.path; if (x?.before?.path) return x.before.path;` | 真机证据（lane A 的 A1）：`cap-a1-t4/runs/*/acceptance.json` 中 `diff_modified_deleted_only_calc ok=True` 且 `buckets={"added":[],"modified":[],"deleted":[]}` ——三个桶全空；但 T4 任务要求模型修改 `calc.py` 修 bug，正确的 run 必有 `modified:[calc.py]`。`cap-a1-t7` 的 `diff_modified_only_modules ok=True bad=[]` 同为空判 |
| **T2** | 测试有效性（中） | T8 的容器泄漏判据用**全局** `harnessRunContainers() - baseline`，C>1 时会把兄弟 run 的沙箱容器当成泄漏 → T8 假 FAIL，且并发档位越高越容易误报 | 判据用全局容器列表而非按 runId 归属过滤 | **未修**。建议：按 `runId` 标签过滤容器，或只统计本 run 生命周期内新建且未回收的 | 见 §18 同轮并发观察；`cap-a2-c2` 进入并发档 |

### 对已有结果的影响（必须随报告披露）
- **跑道 A 的 A1 中，T4/T7/T10 的 `diff_*` 判据不可信**，其 PASS 属于空判通过；这些族的正确率不能作为最终结论。**必须修 T1 后重跑或对已保存的 diff 离线复算**。
- 部分补偿控制仍然有效：`test_files_unmodified` 用夹具快照 sha256 比对，能真实发现"测试文件被改"；受限的是"只允许 calc.py 变更"这一半。

### 对 T2/T3/T6/T7 "0 通过" 的归因（2026-09-10 复核，**修正此前结论**）
- 早先写的"T2/T6 的 0/x 属模型能力边界"**不成立于 T2，也不成立于 T3/T6 的落盘环节**。逐条复核见 §20。
- 只有 **T7 的 0/10 是真实的能力/步数上限失败**。

## §20 第七轮：T2/T3/T6/T7 "全数不通过" 的归因复核（2026-09-10 夜）

> 触发：跑道 A 的 `CAPACITY-SUMMARY.md` 报出 t2 0/10、t3 0/12、t6 0/10、t7 0/10。逐案复核发现**四条 0% 的成因完全不同**，其中三条与模型能力无关。此前"0% 源于模型能力边界"的结论须撤回。

| 族 | 0/x 的真实成因 | 模型实际表现 | 定性 |
| --- | --- | --- | --- |
| **T2 读项目** | **0% 与能力无关**。① 10 例最终答案 `{"readmeTitle":…,"addReturns":"a-b"}` 全部正确；② 第 1 例（12:25:56）真实调用 `read` 且 `read_trace_*`/`no_file_modification`/`add_returns` 全过，唯一失败项 `readme_title_matches_fixture` 是**验收器字符串比较缺陷**——模型返回带 markdown 前缀的 `# base-project — 基准夹具（campaign §3.4）`，而夹具 README 首行本来就是 `# base-project — …`，验收器却拿掉 `#` 的 `wantTitle` 做 `normDash` 全等（`normDash` 只归一化短横线与空白，不剥 `#`）；③ 其余 9 例零 `TOOL_*` 事件但答案正确，因为**驱动把 10 个用例塞进同一个会话**，第 1 例已把 README/calc.py 读进上下文，后续直接从上下文作答 | 10/10 答案与夹具一致 | **驱动设计 + 验收器缺陷** |
| **T3 创建文件** | **0% 与能力无关**，三层叠加。① **首个用例**（`ba017806`，12:03:45）的 diff 里 `added` **确实含** `{"path":"result.json","hash":"07bd18a0…","size":46}`，但当时那版验收器仍判 `result_json_created=false`（`detail` 把整个对象原样打出，说明判据没有先取 `.path`）——**纯测试工具缺陷**；② **第 2–12 个用例**因为驱动**复用同一工作区**，`result.json` 只出现在 `modified`，而 `modified` 条目是 `{before,after}` 无顶层 `path`（同 T1 根因）→ `pathOf` 返回空串 → `added=[]` → 恒判 false；③ `result_json_content` 全程 `ok=null`，因为 t3 无 fixture root、artifacts 又不带 content，**根本无法独立核对**；④ 落盘内容**缺最后一个 `}`**（磁盘实测 46 字节 `{"caseId":"…","answer":42`） | 反复 write→read→重写，模型在最终答复里把 `{…,"answer":42}` 写全了，缺的只有落盘那一个字符 | **验收器缺陷 + 驱动缺陷 + N27**（三层都要修，缺一仍会 0%） |
| **T6 数据汇总** | **0% 与能力无关**。`independent_expected_from_fixture`、`trace_read_orders`、`trace_write_summary` 三项全过，数值与独立实现完全一致（books 200 / food 150 / toys 200）；唯一失败是落盘 `summary.json` 为 34 字节 `{"books":200,"food":150,"toys":200`，**缺最后一个 `}`** 被严格 `JSON.parse` 拒绝 | 汇总结果完全正确 | **N27** |
| **T7 工具密集** | **真实能力/步数上限失败**。只读 10/20 个模块、只改 5 个缺陷模块中的 1 个（mod03），独立 `check_all.py` 仍报 4 个缺陷未修（基线"先失败"判据与独立运行器本身工作正常） | 有实质进展但未完成 | **模型能力**（如实报） |

### N27（**上游依赖，高**）：流式工具调用参数偶发丢失末字符

| 项 | 内容 |
| --- | --- |
| 现象 | 流式 `chat/completions` 的 `tool_calls[].function.arguments` 偶发**丢最后一个字符**。写文件任务里内容串以 `}` 收尾，于是落盘 JSON 少了右花括号 → 严格 `JSON.parse` 失败 |
| 归因证据 | **完全绕过 Harness 直连 `127.0.0.1:18000` 即可复现**——探测脚本不经网关、不经沙箱、不经写工具，说明缺陷在 Harness 上游。vLLM 以 `--enable-auto-tool-choice --tool-call-parser hermes` 在**服务端**把模型原始输出解析成结构化 tool_calls |
| 复现率 | 合计 **69 次流式工具调用 / 18 次丢末字符（26%）**；批次间 **5%–58%** 波动，直接对比 `stream_options.include_usage` 开关不是诱因（5% vs 10%），指向**负载/分块时序敏感的竞态** |
| 与 campaign 的对应 | 跑道 A（13010）**24/24 次 JSON 写入全丢末字符**（该时段另一路发压器并发在跑）；同代码、同镜像、同提示词的 campaign-driverdev（13018，单用例独立会话、时段安静）**9/9 全完整**。故既非稳定模型属性，也非环境档差异 |
| 未做的事 | 未改 vLLM 配置，未在 Harness 侧加兜底（如对 `arguments` 做 JSON 修复重试）；本轮只做归因与证据留存 |
| 证据路径 | `/home/f630/cxr/harness-deploy/hermes-truncation-20260910/`（`README.md` + `hermes-probe{1,2,3}.py`）；campaign 侧 `cap-a1-t3/runs/*/events.json`、`cap-a1-t6/runs/*/events.json` 的 `TOOL_STARTED.arguments` 与磁盘产物逐字节一致 |

### 必须随报告披露
- 跑道 A 的 `CAPACITY-SUMMARY.md` 里 t2/t3/t6 的 **"验收 PASS/FAIL" 列不能被读成任务能力**：那三行的 0% 主要由上述驱动/验收器缺陷与 N27 造成。t7 的 0% 是唯一的真实能力数据点。
- 修正后的口径：**T1 30/30 与 T2 10/10 的"答案正确率"成立；T3/T6 的答案正确但落盘被 N27 破坏；T7 未通过。**

## §21 第八轮：8 小时长稳（跑道 D，2026-09-11）

> 实例 `campaign-soak-20260911`（端口 13020，container/runsc + `python:3.12-alpine`）。
> 开环、指数到达、**0.12 任务/s**、4 租户、混合 `40:40:20:0:0`（不含 T7/T8）、提交窗口 28,800s。
> 结果：计划 3505 / 全部发出 / **完成 2722 / 失败 783**；守恒成立、账本 0 异常、沙箱 **0 残留**。

### 通过项（本轮的核心产出）
- **8 小时无泄漏**：RSS 四时段均值 237,350 / 230,775 / 232,742 / 233,962 KB（线性外推 11.6h 变化 −1.2%）；FD 24.5 → 29.5 → 29.7（早期升到 ~30 后持平）；线程 22–25；沙箱容器 0–6 随任务生灭、收工归零。
- **元数据接口在 8 小时内保持可用**：`GET /runs` p50 11ms / max 951ms；`GET /eval` p50 14ms / max 374ms。
- **沙箱生命周期健康**：3,505 次创建/回收，终态全部 TERMINATED，无孤儿容器。
- → 此前"长稳完全没跑，所以不能声称没有内存/FD/队列泄漏"的空白**由 8 小时档补齐**（24h 档仍未跑）。

### N28（**高，已修**）：会话上下文撑爆后**永久不可用**
| 项 | 内容 |
| --- | --- |
| 现象 | 会话累积上下文超过模型窗口后，该会话**之后每个任务都在模型侧 400**，且永不恢复。783 个失败里 **746 个（21.3%）**属于此类，其余 37 个是流中断 |
| 因果证据 | 发压器按任务族会话（4 租户 × 6 族 = 24 会话），失败与族**完全对应**：t6 会话 4/4 全死（142/114/109/78 次失败）；t4 会话 4/4 全死（68/58/48/44）；t10 1/4 死；t3 2/4 死；**t1、t2 会话 0 失败**。最典型会话 `36e566bd`：第 58 次运行起失败，**此后 142 次运行、0 次成功** |
| 机制 | t6/t4 这类"读大文件 / 跑测试 / 长工具输出"的任务每次给会话贡献的上下文远大于 t1/t2，累积到 32k 窗口即撞墙；一旦撞墙，后续每个请求都在模型侧 400 |
| 三个可修点 | ① 无上下文压缩/截断/滚动，会话撞墙后不自愈，也没有"开启新会话"的引导；② **提交期不校验**（与 N8 同源），先 202 接受再在模型侧失败；③ 失败只散落在该会话的每个 run 上，**没有"此会话已不可用"的整体信号** |
| 如实标注 | 本轮的"一族一会话连发 200 条"放大了该问题（真实用户不会这样用）；但底层行为真实——**长会话必然撞墙且撞墙后不可恢复**。短时会话（跑道 A 的 30min 档）不会暴露，属**只有长稳才能发现的问题** |
| 证据 | `/home/f630/homePLUS/soak-evidence/README-soak-8h.md`、`session-analysis.py`、`family-analysis.py`、`monitor.jsonl` |

#### 修复（2026-09-11）
- **新增 `src/llm-gateway/context-budget.ts`**：按**轮次边界**丢弃最老的对话历史，并插入一条显式说明（`DEFAULT_COMPACTION_NOTICE`），让模型知道早前内容已被省略——**不静默降级**。token 数为保守估计（CJK 约 1 字/token，其余 4 字符/token），不引入 tokenizer 依赖。
- **为什么在网关做**：会话历史由 Pi 持有，Harness 只在模型边界能看到完整 messages，这里是唯一能压缩的地方，也是 400 的产生点。压缩在 prefix 规范化**之前**执行（规范化会重排 messages，压缩需要原始轮次结构）。
- **边界安全**：一轮 = 一条 user 消息及其后到下一 user 之前的全部消息，因此 `assistant.tool_calls` 与其 `tool` 结果**永远同轮存亡**；压缩后再丢弃开头可能残留的孤立 `tool` 消息（孤立工具结果会被上游直接拒绝）。
- **配置**：`LLM_CONTEXT_BUDGET_TOKENS`（默认 **24000**，= 模型窗口 32768 − 预留输出 4096 再留余量；**0 = 关闭压缩，回到旧行为**）。已写入 `.env.example` 与 `deploy/qwen38-harness.env.example`。
- **可观测**：压缩时 `console.warn` 打出丢弃轮数/条数/token 变化，并可通过 `LlmGateway.lastCompactionStats()` 查询——N28 的另一半问题是"用户与运维都不知道被裁过"。
- **回归**：新增 9 条用例（`tests/llm-gateway/context-budget.test.ts`，按本轮约定**只留在本地、未入库**），覆盖"不拆工具对""预算关闭即旧行为""极紧预算至少留 1 轮""网关转发前生效"；仓库自身全套 **412 pass / 0 fail**。
- **仍未做（如实标注）**：① 当前是"**丢弃 + 告知**"，**不是 LLM 摘要式压缩**——被丢掉的信息不会以摘要形式保留；② 界面层仍没有"此会话已被裁剪"的提示，用户侧仍感知不到（只有服务端日志与 `lastCompactionStats()` 事实）；③ **压缩只在网关按请求进行，Pi 侧存的历史不会被裁剪**——复验日志显示每个请求的量持续在 ~18k、压到 ~2.4k，即"每次请求都放得下"，而非"会话不再变大"。会话托管侧的无界增长是另一个问题，本轮未处理。

| 修复项 | 内容 |
| --- | --- |
| 改动文件 | `src/llm-gateway/context-budget.ts`（新增）、`src/llm-gateway/llm-gateway.ts`、`src/app/harness-config.ts`、`src/app/create-harness-application.ts`、`.env.example`、`deploy/qwen38-harness.env.example` |
| 验证 | `bun test ./tests` → 412 pass / 0 fail；`bun run typecheck` → `src/` 0 错误 |
| 真机复验 | **通过**。实例 `campaign-n28-20260911`（端口 13030，container/runsc + `python:3.12-alpine`），故意把预算设成 **2000**（远小于默认 24000，即更苛刻的触发条件），负载用**单用户 t6**——正是 8h 长稳里 4/4 全死的那一族。结果：**同一会话 104 次运行、0 个上下文超限失败**（唯一 1 个失败是流中断，与上下文无关），压缩触发 **204 次**。对照修复前：t6 会话在第 ~58 次运行处开始 400，此后 **142 连败 0 成功**。证据 `/home/f630/homePLUS/soak-evidence/n28-verify-verdict.json`、`n28-compaction-samples.txt` |

### 同轮修掉的测试工具缺陷
- **T6（测试工具）**：`provision-instance.sh` 生成的 `start.sh` 用相对路径定位 `campaign.env`——`cd code` 之后 `$(dirname "$0")` 仍指向原相对路径，**只有绝对路径调用才能启动**。已同时修实例与模板。

## §22 第九轮：N28 主机制——让 Pi 自己的摘要式压缩真正生效（2026-09-11）

> §21 的修复把压缩放在**网关**（丢弃 + 告知），能止血，但机制层级低：按时间砍、不做摘要、且 Pi 侧历史仍无界增长。
> 本轮改成**分层**：Pi 会话内的**摘要式压缩当主机制**，网关截断降级为**兜底**。
> 实例 `campaign-pi-compact-20260911`（端口 13031，container/runsc + `python:3.12-alpine`）。

### 根因：上游默认参数在 32k 窗口下**退化成空操作**（不是"没配压缩"）
| 项 | 内容 |
| --- | --- |
| 默认值 | Pi `DEFAULT_COMPACTION_SETTINGS = {enabled:true, reserveTokens:16384, keepRecentTokens:20000}` |
| 触发条件 | `shouldCompact(tokens, window, s)` → `tokens > window − reserveTokens` |
| 32k 窗口的后果 | 触发点 = 32768 − 16384 = **16384**，而它被要求**至少保留 20000** 的近期历史——**保留目标比触发点还大** |
| 静默退化链 | `findCutPoint` 从尾部往前累计 token 永远够不到 20000 → 切点一路退到会话开头 → `messagesToSummarize` 为空 → `prepareCompaction` 返回 `undefined` |
| 为什么长期没被发现 | `_runAutoCompaction` 在 `preparation === undefined` 时**静默 `return false`**，不报错不告警；且 overflow 恢复路径 `_overflowRecoveryAttempted` **只允许重试一次**，失败后该会话永久不可用 |
| 8h 长稳实证 | 87 个 Pi 会话文件中**只有 7 个**含 `compaction` 记录（~8%）；会话 `36e566bd` 撞窗后 **142 连败、0 成功** |

**关键是：这不是"没配置压缩"，而是配置了却退化成空操作**——比不配置更难发现。

### 修复（三处）
1. **配置契约**（`src/app/harness-config.ts`）：新增 `piCompactionEnabled` / `piCompactionReserveTokens`（默认 **12288**）/ `piCompactionKeepRecentTokens`（默认 **8192**），对应环境变量 `PI_COMPACTION_ENABLED` / `PI_COMPACTION_RESERVE_TOKENS` / `PI_COMPACTION_KEEP_RECENT_TOKENS`。
   标定依据：窗口 32768、单次输出上限 4096 → 触发点 **20480**、压缩后保留 ~8192、为输出留 12288。
   两条**不变量**（违反任一条即退化成空操作）：`reserve > keepRecent`，且 `reserve > 单次输出上限`。
2. **注入方式**（`src/runtime/pi-adapter.ts`）：`SettingsManager.create(cwd, ~/.pi/agent)` + `applyOverrides({compaction})`，再经 `createAgentSession({settingsManager})` 下发。`applyOverrides` **只改内存副本、不落盘**（已用测试锁定），因此不污染部署方的 `settings.json`，也不必往每个 Run 的临时工作区写 `.pi/settings.json`。`start` 与 `resume` 两处建会话调用都改。
3. **装配路径**（`src/app/create-harness-application.ts` + `src/worker/worker-protocol.ts` + `src/worker/worker-main.ts`）：压缩参数**随 `workerConfig` 经 IPC 下发**。默认隔离模式是 `process`，Pi 会话建在 worker 子进程里——只在 Master 侧装配会漏掉**占绝大多数的执行路径**。

### 顺带修掉：worker 模式下的"观测盲区"（`src/runtime/worker-process-runtime.ts`）
- `worker-main.ts` 把 `console.*` 全部重定向到 stderr 以免污染 stdout 上的 NDJSON IPC，因此 **worker 侧的一切诊断只走 stderr**；而原先 stderr 只保留**最后 50 行在内存里**、仅崩溃时才吐出来。
- 后果：**worker 里到底发生了什么，在正常运行期完全不可见**——8h 长稳里 Pi 压缩静默失效，正是因为这条链路没有任何信号。
- 修法：消费 stderr 时同时 `process.stderr.write("[worker <pid>] <line>")`，转发进 Master 日志。
- 另外把 `compaction_start` / `compaction_end` 从"显式忽略"里提出来，打印 `reason` 与 `token X → Y`（此前这两个事件被适配器直接吞掉）。

### 验证证据
**本地**：`bun test ./tests` → **417 pass / 0 fail**（新增 5 条）；`bun run typecheck` → 已入库源码 0 错误。
- `tests/runtime/pi-compaction-defaults.test.ts`（新增 4 条）**用 Pi 自己导出的 `shouldCompact` / `findCutPoint` 复现根因**：默认参数下、恰好在 `shouldCompact` 返回 `true` 的上下文规模处，`findCutPoint().firstKeptEntryIndex === 0`（无可摘要内容）；换成 Harness 参数后切点落在历史中部、`historyEnd > 0`。第 4 条锁定 `applyOverrides` 生效且**文件字节不变**。
- `tests/app/harness-config.test.ts`（新增 1 条）：锁定默认值与两条不变量。

**真机 · 实验臂 A（决定性设计）**：负载与 N28 复验**同一份** `load-driver.ts`（md5 `218273de…`），单用户 t6、0.15 任务/s、900s。
- **把网关兜底彻底关掉**（`LLM_CONTEXT_BUDGET_TOKENS=0`）——若仍 0 超限，则只可能是 Pi 压缩在起作用，**不存在"兜底替 Pi 背锅"的解释空间**。
- 结果：**1 个会话**跑完 **134 次运行**（94 完成 / 4 失败 / 36 收尾中断）；**21 次 Pi 压缩**，全部落在 `tokensBefore = 20486–21247`，**与配置的触发点 20480 精确吻合**；每次摘要 1.1k–1.6k 字符（真实 LLM 摘要，不是丢弃）。
- 会话共 422 条消息，`stopReason` 分布 `toolUse 97 / stop 94 / 无(用户与工具结果) 231`，**`error` 为 0**；最大 input **21173**，从未接近 32768。
- 4 个失败**全部是 `QUEUE_TIMEOUT`**（0.15/s 灌进 `max_active_runs=4` 的容量产物），**0 个上下文超限**。
- 对照修复前：同族会话在第 ~58 次运行处开始 400、此后 **142 连败**。

**真机 · 观测链路验证（非参数验证）**：临时把 `PI_COMPACTION_RESERVE_TOKENS=26000` / `KEEP_RECENT_TOKENS=3000` 压低触发点，令压缩在 1–2 个 Run 内必然发生。Master 日志出现：
```
[worker 3269447] [pi-adapter] 会话压缩结束：runId=8e8399aa… reason=threshold token 9298 → 3173 aborted=false willRetry=false
```
→ worker stderr 转发与 compaction 事件映射**均已打通**，默认 worker 模式下压缩事实可见。

### 清理（本轮结束状态）
- 实例已停：端口 13031 释放；`agent-harness-*` 容器 **0** 个；共享 22 个 `polar-*` 容器、共享 Harness（13000）、vLLM（18000）**全程未动**。
- 期间**再次复现 N19**：Master 被 SIGTERM 时仍有 1 个正在跑任务的沙箱容器未被回收（mount 指向本实例工作区），按归属确认后手工回收。这是 N19 的第 3 次独立复现，**仍未修**。

### 仍未做（如实标注）
1. N23（预算层重复计数导致 `ceiling=1` 租户恒被拒）、N19（恢复活锁 + 沙箱泄漏）、N18（静默损坏的 Checkpoint）**仍未修**；
2. 压缩阈值是按**本部署** 32768/4096 标定的常量，换模型窗口需重算——依据与不变量已写进代码注释和 `.env.example`，但**没有做成自动推导**；
3. 界面层仍不展示"本会话被压缩过"，用户侧依旧只有服务端日志可查；
4. 24h 耐久档、R07 长任务档等仍在本轮冻结的边界之外（见 `docs/scenario-coverage-consolidated.zh-CN.md` §0.5）。

## §23 第十轮：收尾前清掉 5 条系统侧未修缺陷（2026-09-11）

> 背景：全场景账里 86 个场景的 8 个 FAIL 中，去掉"当场已修"（N7/N8）与"模型能力问题"（C05）后，
> 系统侧还剩 5 条未修：**N22、N25、N23、N18、N19**。本轮把这 5 条全部修掉并各自补了回归测试。
> 环境：实例 `campaign-n23verify-20260911`（端口 13032，container/runsc + `python:3.12-alpine`）。

### 总览

| # | 缺陷 | 级别 | 修复要点 | 验证 |
| --- | --- | --- | --- | --- |
| N23 | `ceiling=1` 的租户**永远启动不了任何 Run** | 高 | 预算层不再有第二个用量来源 | 本地回归 + **真机：3 个 ceiling=1 租户全部 COMPLETED** |
| N18 | 损坏的 Checkpoint 被**静默忽略** | 高 | 恢复前校验会话引用可达，不可达转人工 | 本地回归 + **真机：`SESSION_REF_UNREACHABLE` + 拒绝恢复** |
| N19 | 恢复活锁 + **每次失败泄漏一个沙箱** | 高 | 先占槽后建沙箱 + 启动对账释放残留 + 重试上限 | 本地回归 + **真机：槽位重置为 READY、0 次 RESUME_FAILED、容器回收** |
| N22 | 切对话时**迟到轮询响应覆盖当前页** | 中高 | 响应加「对话 id + 请求序号」双守卫 | 本地回归（含浏览器引擎解析）+ 确认已部署 |
| N25 | 断网期间**轮询错误被静默吞掉** | 中高 | 顶部降级横幅 + 保留已知队列 | 本地回归 + 确认已部署 |

**回归**：`bun test ./tests` → **431 pass / 0 fail**；`bun run typecheck` → 已入库源码 0 错误。

---

### N23（高）：预算层重复计数，`ceiling=1` 租户恒被拒

**根因（比台账原记录更明确）**：用量有**两个来源**。

- `run-queue-coordinator.ts` 在 `claimNext()` 之后，向 base policy 传的是**已扣掉当前 Run** 的计数
  （`capacity.activeTenantRunCount - 1`），`ExecutionPolicyInput.activeTenantRunCount` 就是它；
- 而 `BudgetAwareExecutionPolicy.decide()` 调的是 `usage.availableUnits(tenantId)`，
  `SchedulerCapacityBudgetUsage` 会**回读调度器**、拿到**仍含当前 Run** 的原始计数。

于是同一个 Run 被算两次：`availableUnits = ceiling − 1`，**`ceiling == 1` 时恒为 0**，
任何 Run 都反复 `QUEUE / TENANT_BUDGET_EXCEEDED` 直到 TTL 失败。真机 Q08 证据里三条 Run
都是 `_contractAdmit=true` 却被改判 `admitted=false`（`contract_violation=true`）——
即 base policy 本会放行，被预算层错误拦下。

**修法（`src/resources/budget-aware-policy.ts`）**：用量只保留**一个**来源——
本次准入事实 `input.activeTenantRunCount`。预算解析器退化为"只回答预算上界"
（`fairShareUnits` / `maxUnits`），不再参与用量计算：

```ts
const ceiling = Math.min(
    this.usage.fairShareUnits(input.tenantId),
    this.usage.maxUnits(input.tenantId),
);
const usedUnits = input.activeTenantRunCount;   // 权威口径：已扣掉当前 Run
if (ceiling - usedUnits >= this.unitsPerRun) return baseline;
```

`availableUnits()` 保留但标注为**仅观测/离线核对**，准入路径不得使用——避免同类缺陷复发。

**本地回归**：新增 2 条（`tests/resources/budget-policy-wiring.test.ts`），
分别锁定"无占用时必须 START"与"真占 1 个时才 QUEUE"。原 3 条按账本/调度器读数驱动的用例
已按新契约改写为从准入事实驱动（**契约变更，非放宽标准**）。

**真机复验（通过）**：注册 3 个等权租户（weight 1 / maxUnits 1 → ceiling 全为 1），
并把 GPU 阈值与并发上限全部放宽，使**预算层成为唯一可能拦截任务的约束**。结果：

```
A: status=COMPLETED failureReason=None   decisions=['RESOURCE_NORMAL']
B: status=COMPLETED failureReason=None   decisions=['RESOURCE_NORMAL']
C: status=COMPLETED failureReason=None   decisions=['RESOURCE_NORMAL']
```

对照修复前：全部 `admitted=false` + 反复 `TENANT_BUDGET_EXCEEDED` 直到 TTL 失败。

---

### N18（高）：损坏的 Checkpoint 被静默忽略

**根因**：恢复路径只校验 Checkpoint 归属（`runId` 匹配），**不校验它引用的会话是否真的打得开**。
而 Pi 的 `loadEntriesFromFile` 对**不存在的文件返回空数组**，
`SessionManager.open` 于是给出一个"没有历史的会话"——Run 照常 `COMPLETED`、日志零告警，
用户以为续上了上下文，其实模型对之前做过什么一无所知。

**修法（分三层，纵深防御）**：

1. `recovery-decision.ts`：新增 `SESSION_REF_UNREACHABLE` 理由；`decideRecovery` 接受
   `SessionRefCheck { runtimeSessionRef, isReachable }`。判定放在**未知副作用检查之后**——
   不能让一个打不开的会话引用盖过更强的安全信号；两者都落 MANUAL_REVIEW，但理由可区分。
2. `runtime/session-ref-reachability.ts`（新增）：文件存在、是普通文件、且**非空**才算可达
   （空文件等价于"没有历史"）。之所以必须**显式注入**而不是默认开启：只有真实 Pi 运行时的
   引用才是文件路径，demo/测试替身用的是合成引用（`/tmp/demo-pi-session.jsonl`、
   `demo-session-<runId>`），默认开启会把它们全判成损坏。因此 `create-harness-application`
   仅在**未注入 runtime**（即我们自己装配真实 Pi）时才注入该校验。
3. `pi-adapter.ts` 的 resume 路径加同一校验：**即使决策层漏过也宁可显式失败**，
   绝不让 Pi 用空会话悄悄续跑。

**真机复验（通过）**：停机后植入一条 `runtime_session_ref=/tmp/n18-missing-session-file.jsonl`
的 Checkpoint 并把 Run 置为 RUNNING，重启后：

```
[recovery] N18 恢复点已损坏，拒绝自动恢复：runId=7ca791cf… checkpointId=n18-bogus-checkpoint
           runtimeSessionRef=/tmp/n18-missing-session-file.jsonl

seq 17 RUN_INTERRUPTED {"reason":"MANUAL_REVIEW_REQUIRED","recoveryAction":"MANUAL_REVIEW",
                        "recoveryReason":"SESSION_REF_UNREACHABLE",…}
run.status = INTERRUPTED      # 不是 COMPLETED
```

对照修复前：`r10.json` 记录的是 `httpStatus=202、runStatus=COMPLETED、failureReason=null` —— 静默"成功"。
另注：同一实例上被硬杀、**没有 Checkpoint** 的 Run 走的是 `NO_CHECKPOINT` 分支，
说明该校验不会误伤正常恢复。

---

### N19（高）：恢复活锁 + 每次失败泄漏一个沙箱

**根因比原台账多一层，共三处叠加**：

1. **顺序缺陷（新定位，泄漏的直接原因）**：`managed-agent-runtime.ts` 原先**先建沙箱、后占实例槽位**。
   槽位不可用时 `acquireRun` 抛错，而这次抛错发生在**沙箱已创建之后**，回收沙箱的 `finally`
   （在 `acquireRun` 之后才开始）**覆盖不到这条路径** → 每次失败的 RESUME 都留下一个无人回收的容器。
2. **启动残留**：执行中被**硬杀**（SIGKILL）→ 实例停在 `ACTIVE, active_run_count=1`；
   重启时 `sandbox-startup-reconciler` 找到遗留沙箱并把实例转成 **FAILED，但 `update()`
   不重置 `active_run_count`** → `FAILED + count=1`。
3. **不可服务 + 无界重排**：`acquireRun` 只在 `READY/ACTIVE` 放行，而 `releaseRun` 会把 FAILED 保持住
   → 该实例**永远**拿不到槽位；同时 N2 的 `INSTANCE_NOT_READY` 重排**没有上限** →
   `INTERRUPTED↔QUEUED` 活锁，且每轮都真实创建/销毁一个沙箱。

**修法（三处对应）**：

- **先占槽、后建沙箱**（`managed-agent-runtime.ts`）：拿不到槽位就什么都不创建（fail fast）；
  沙箱创建失败则立刻归还槽位。
- **启动对账**（`harness-instance-store.reconcileStaleSlotsForStartup()` + 接进
  `RecoveryStartupCoordinator`，且**早于**任何恢复执行）：进程刚起来时没有任何 Run 在跑，
  所以 `active_run_count > 0` 必是脏值 → 计数归零；`desired_state='RUNNING'` 的实例回到 READY
  重新参与调度，`STOPPED` 的只清计数、保留停机意图。修正结果**打进启动日志**，不静默改状态。
- **重试上限**（`run-queue-coordinator.ts`，`maxInstanceNotReadyRetries` 默认 5）：
  低于上限仍按 N2 语义重排；超过即**停止重排并转人工**，避免活锁与沙箱 churn。

**真机复验（通过）**：提交长任务 → 等到 RUNNING → `kill -9` Master，残留现场：

```
[{"id":"default-pi-instance:0cd636f7…","actual_state":"ACTIVE","active_run_count":1}]
残留容器: agent-harness-1877be0a-…（1 个）
```

重启后：

```
[startup] N19 修正 1 个实例的槽位残留（上次进程异常退出的遗留），已重置为可服务状态：
          {…,"desiredState":"RUNNING","actualState":"READY","activeRunCount":0,…}
实例状态: 三个实例全部 READY / active_run_count=0 / failure_reason=null
RESUME_FAILED 次数: 0
残留容器: 0（被 sandbox reconciler 回收）
```

对照修复前：`r11-instance-livelock.txt` 记录该实例此后每次恢复都 `RESUME_FAILED: HarnessInstance 无法获取执行槽位`，
并实测留下 2 个 `agent-harness-*` 容器。

---

### N22（中高）：切换对话时迟到的轮询响应覆盖当前页

**根因**：`user-console-client.js` 的 `refreshConversation()` 在调用时读取 `S.conversationId` 拼 URL，
但响应处理里对 `S.conversation` / `S.runs` / `convTitle` 的赋值与 `renderThread()`
**没有任何"响应是否仍属于当前对话"的校验**。轮询每 1600ms 一次、内部还有 `loadOutput`/`loadFacts`
链式请求，窗口可达数百 ms 到数秒；期间用户切了对话，A 的响应就会覆盖 B 的标题与消息，
用户在正文里点"中断/恢复"还可能作用到错误对象。

**修法**：两条判据同时用——

- **调用时快照** `var requestedId = S.conversationId;`
- **请求序号** `var seq = ++S.refreshSeq;`

响应入口与**链式请求之后、渲染之前**都要通过 `requestedId !== S.conversationId || seq !== S.refreshSeq`
的守卫。只比对对话 id 不够：A→B→A 快速切换时，旧 A 的响应迟到会恰好对上 id。
另外 `openConversation` 改为**立刻** `stopPoll()`，而不是等刷新完成后才重排定时器。

**验证**：本地回归测试断言快照早于请求、守卫早于状态写入、链式渲染前二次确认、切对话先停轮询；
并**由既有 N1 用例用浏览器引擎对整段内联脚本做解析断言**（保证改动可被真实浏览器解析）。
另确认 `/app` 已提供修复后的代码（`refreshSeq`、`var requestedId = S.conversationId;` 均命中）。

> **如实标注**：该竞态本身**未在真实浏览器里复现**——它需要受控的网络延迟/乱序响应。
> 当前是"代码级 + 部署级"验证，不是"真实浏览器时序"验证。

---

### N25（中高）：断网期间轮询错误被静默吞掉

**根因**：轮询的 `.catch(function(){})` 把失败完全吞掉，`refreshQueue` 的失败分支还会
**把队列直接清空**。后果有二：断网 30/120s 期间界面既没有错误也没有离线提示，
持续把过期状态当最新状态展示；以及一次网络抖动就会把"排队中"的任务显示成不在队列里
（用错误数据冒充最新状态）。

**修法**：

- 新增顶部降级横幅 `#netBanner`：`api()` 是唯一出口，网络失败经 `isNetworkError()` 识别后
  累计并点亮横幅，文案明确写出"**页面显示的是最后一次成功获取的状态，可能已过期**"；
  恢复后隐藏横幅、补一次刷新（仅当中断持续 ≥3s 才提示，避免抖动刷屏）。
- `api()` 成功时复位失败计数；HTTP 4xx/5xx 带 `status`，不算网络故障，不误报。
- 监听 `offline` / `online` 事件即时反映，不必等下一次轮询超时。
- `refreshQueue` 失败时**保留上一次已知队列**；登出时清掉横幅状态。

**验证**：本地回归测试断言横幅元素与样式存在、`api()` 内接入 `noteNetFail/noteNetOk`、
离线事件监听存在、`refreshQueue` 不再在失败分支清空队列；并确认 `/app` 已提供修复后的代码。

> **如实标注**：同 N22，本轮未在真实浏览器里做断网时序验证，属"代码级 + 部署级"验证。

---

### 随本轮披露的测试资产状态

- 本轮新增/修改的测试**按既定约定只留本地、不入库**（`tests/` 已入库 71 个文件，本地 93 个）。
- 其中 `tests/resources/resource-budget-ledger.test.ts` 是**已入库**文件，因 N23 的契约变更
  （用量改由准入事实驱动）同步改写了 3 条用例。**未入库**，因此新克隆里这 3 条会按旧契约失败。
  这是"测试不入库"约定的已知后果，已在 `docs/scenario-test-index.zh-CN.md` §6 边界里披露。
