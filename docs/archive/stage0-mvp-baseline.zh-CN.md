# Stage 0：Day 1–7 MVP 基线与核心契约

> 基线日期：2026-08-06  
> 状态：本地语义基线已验证；Git 基线提交和 A6000 实测分别待完成  
> 适用范围：所有后续改动不得静默破坏本文列出的合同

## 1. 基线目的

本文冻结 Day 1–7 MVP 的真实行为，而不是为未来对象预先设计接口。Stage 1–2 已
引入 HarnessTemplate、HarnessInstance、CapabilityProfile、Attempt 与 Sandbox；
当前多租户 Agent 任务服务继续保留这些合同。任何改变都必须有明确 migration、
事件版本和 ADR；新增认证、Workspace 与容器 Sandbox 时，不能绕过原有恢复语义。

真实 A6000 上的直接 Pi / Harness 对照实验仍按照
[`day7-a6000-baseline-runbook.zh-CN.md`](day7-a6000-baseline-runbook.zh-CN.md)
独立执行。按照 ADR 0009，真实数据和跨租户隔离攻击测试都是产品完成条件；缺少
数据时不允许声明性能、资源收益或生产级隔离。

## 2. 可复现入口

当前本地工具版本：

- Bun `1.3.13`；
- TypeScript `5.9.3`；
- `@earendil-works/pi-coding-agent` `0.80.10`。

统一验收命令：

```bash
bun run verify:stage0
```

它依次执行：

```text
bun run test
→ bun run typecheck
→ bun run demo:day7
```

基线结果为根项目 `tests/` 中 153 项测试通过、严格 TypeScript 检查通过，且 Day 7
Fake 演示输出 `RESULT: PASS`。进程级 HTTP 测试需要允许在 `127.0.0.1` 监听临时
端口；受限执行环境必须显式开放 loopback，不能把 `EPERM` 误判为业务测试失败。

## 3. SQLite schema v4

`src/storage/migrations.ts` 当前定义四个单调递增 migration：

| 版本 | 主要内容 |
| --- | --- |
| v1 | `agent_runs`、`run_events`、Tenant/Session 查询索引 |
| v2 | `run_events.dedupe_key` 和 Run 内部分唯一索引 |
| v3 | `tool_executions`、`checkpoints` 及工具结果/恢复边界约束 |
| v4 | `resource_snapshots`、`policy_decisions` 及审计一致性约束 |

包含 migration 账本在内，当前数据库共有七张表：

```text
schema_migrations
agent_runs
run_events
tool_executions
checkpoints
resource_snapshots
policy_decisions
```

不可破坏的存储合同：

- Run 当前快照与导致状态变化的 RunEvent 在同一事务内提交；
- 同一 Run 的事件 `sequence` 唯一且单调递增；
- Runtime 业务事件使用 `(run_id, dedupe_key)` 去重；
- 工具成功结果、Checkpoint 和 `agent_runs.checkpoint_id` 原子提交；
- PolicyDecision 是追加事实，并引用真实 ResourceSnapshot；
- 资源观测失败不伪造 Snapshot，准入采用 fail closed。

## 4. Run 状态与实际事件语义

当前允许的状态转换：

```text
QUEUED → RUNNING | INTERRUPTED
RUNNING → WAITING_TOOL | INTERRUPTED | FAILED | COMPLETED
WAITING_TOOL → RUNNING | INTERRUPTED | FAILED
INTERRUPTED → QUEUED
COMPLETED / FAILED → 无后续状态
```

当前 Pi 主路径在工具执行期间仍保持 `RUNNING`，尚未实际写入 `WAITING_TOOL`。
`WAITING_TOOL` 是保留状态，不得把“枚举已存在”描述成“执行路径已完成”。同理，
`TOOL_REQUESTED` 和 `CHECKPOINT_SAVED` 已存在于事件类型中，但当前真实时间线主要由
`TOOL_STARTED`、`TOOL_COMPLETED/TOOL_FAILED` 和独立 Checkpoint 表表达这些事实。

Stage 1 迁移不得改变以下行为：

- 创建 Run 时原子产生 sequence 1 的 `RUN_CREATED`；
- 只有 `QUEUED` Run 可以 start 或执行已排队的 resume；
- Runtime 启动抛错后 Run 不得遗留在 `RUNNING`；
- 生命周期终态由 RunService 持久化，RuntimeEventBridge 不重复写入；
- 模型和工具持久事件必须去重，流式 token 不进入 SQLite。

## 5. 工具与恢复合同

ToolGateway 在真实执行前保存 `PREPARED` ToolExecution：

- `SUCCEEDED`：复用已持久化结果，不再次执行；
- `FAILED`：返回确定失败，不静默重试；
- `PREPARED + READ_ONLY`：允许自动重放；
- `PREPARED + IDEMPOTENT_WRITE`：在没有持久化并校验真实外部幂等证据前 fail closed；
- `PREPARED + UNKNOWN_EFFECT`：fail closed。

`tool_call_id` 只能去重 Harness 内同一 Run 的调用记录，不能自动证明外部 API、文件
或进程副作用使用了稳定幂等键。未来开放 `IDEMPOTENT_WRITE` 自动恢复时，必须让
工具级幂等契约进入真实调用路径，并新增故障注入证据。

启动恢复流程：

```text
恢复已有 QUEUED Run
→ 扫描遗留 RUNNING / WAITING_TOOL
→ 持久化为 INTERRUPTED
→ Checkpoint + PREPARED ToolExecution 生成恢复决定
→ AUTO_RESUME 入统一队列，或保留 MANUAL_REVIEW
→ 重新经过 ResourceAdmission 和 slot
→ Runtime.resume
```

恢复成功不能只证明任务最终完成；测试必须同时证明已成功的工具结果不会重复执行，
不确定副作用不会被自动重放。

## 6. 资源和调度合同

- ResourceObserver 只产生资源事实，ExecutionPolicy 负责决策；
- `CRITICAL`、`UNKNOWN` 和观测失败都让新 Run 排队；
- `BUSY` 保留全局上限，并限制同 Tenant 并发；
- Tenant 内 FIFO，Tenant 间 round-robin；
- `claimNext` 选择 Run 时同步登记 Run 级 slot；
- Run 在工具执行期间仍占用 slot，直到完成、失败、中断或启动失败；
- slot 释放幂等，单个 Run 失败不能阻塞后续 Run；
- drain 是 single-flight，并能消费执行期间到达的新推进请求；
- QueuePump 在资源恢复后自动重检，用户无需重新提交；
- 控制面重启后从 SQLite 重建普通 QUEUED Run 和带 Checkpoint 的恢复 Run。

## 7. 核心契约测试清单

| 合同 | 主要测试文件 |
| --- | --- |
| AgentRuntime start/resume/interrupt/事件隔离 | `tests/runtime/agent-runtime.test.ts` |
| Run 状态、事务、事件顺序与去重 | `tests/runs/run-state-machine.test.ts`、`tests/runs/runstore.test.ts`、`tests/runs/run-service.test.ts` |
| RuntimeEvent 映射、usage 和持久化边界 | `tests/events/runtime-event-bridge.test.ts`、`tests/events/run-event-timeline.test.ts` |
| 工具执行前持久化、结果复用和 fail closed | `tests/tools/tool-execution.test.ts`、`tests/tools/tool-execution-store.test.ts`、`tests/tools/tool-gateway.test.ts` |
| Checkpoint、恢复决定和恢复任务隔离 | `tests/checkpoints/recovery-decision.test.ts`、`tests/checkpoints/recovery-service.test.ts`、`tests/checkpoints/recovery-executor.test.ts` |
| 资源观测、分类、准入和决策证据 | `tests/resources/*.test.ts` |
| Tenant 公平性、slot、drain 和资源恢复推进 | `tests/scheduling/*.test.ts` |
| 应用组装、启动恢复、HTTP 与进程生命周期 | `tests/app/*.test.ts`、`tests/http/*.test.ts`、`tests/integration/*.test.ts` |

Stage 1 的新测试应继续复用这些合同，并新增 Template version、Instance、Session、
Attempt 和 Capability 的追溯性与拒绝测试，不能用替换旧测试的方式隐藏回归。

## 8. Git 冻结边界

Stage 0 的最后一步是把本地已验证的 Harness MVP 固定到一个明确 commit。提交前必须：

1. 审查当前已修改、已删除和未跟踪文件；
2. 纳入 Day 1–7 Harness 源码、测试、脚本、ADR 和本基线文档；
3. 排除 `output/`、本机配置、生成物和独立研究项目，除非用户明确决定一并版本化；
4. 在拟提交内容上重新执行 `bun run verify:stage0`；
5. 记录 commit，并从该点开始 Stage 1。

未经用户确认，不自动暂存或提交当前工作区。
