# Module 2: 一次任务的一生（数据对象链与状态机）

## Teaching Arc
- **Metaphor:** 医院手术系统。Tenant 是医院，Workspace 是独立病房，Run 是一台手术，Attempt 是一次实际开刀（手术可能因故重开），Sandbox 是无菌手术室，ToolExecution 是手术记录单（每动一刀都记），Result/Diff 是术后报告。病历（RunEvent 时间线）永远追加、不可涂改。
- **Opening hook:** 用户在 UI 点下"提交任务"的那一瞬间，一个 Run 开始了它的一生——从 QUEUED 到 COMPLETED，每一步都被持久化、可回放。
- **Key insight:** Runtime 是即时的，Run 是持久的。RuntimeEvent 存在于底层 SDK 执行瞬间，RunEvent 是 harness 长期保存的业务事实——这个"双轨制"是整个可解释性的地基。
- **Why should I care:** 面试官最爱问"讲一下端到端流程"。这一条链讲清楚，等于证明了你真的写过这个系统。

## 数据对象链（必须精确）
```
Tenant → Workspace → Session → Run → Attempt → Sandbox → ToolExecution → Result / Diff / Artifact
```
| 对象 | 一句话定义 | 关键辨析 |
|---|---|---|
| Tenant | 身份/数据/策略/资源/审计的一等边界 | 来自认证，非客户端自报 |
| Workspace | 租户下受管工作区，服务端生成目录 | 客户端不能提交宿主机路径 |
| Session | 对话关系（Pi AgentSession 的持久句柄） | Session ≠ Run |
| Run | 一次受控任务 | 状态机管理 |
| Attempt | Run 的一次实际执行 | 每次真实执行独立 Attempt |
| Sandbox | 每 Attempt 的隔离环境（runsc 容器） | 不跨 Attempt 复用 |
| ToolExecution | 一次工具调用及副作用记账 | PREPARED/SUCCEEDED/FAILED |

## Code Snippets (pre-extracted)

### Snippet A — Run 状态机（src/runs/run-state-machine.ts 全部核心）
```typescript
const allowedTransitions : Record<AgentRunStatus,readonly AgentRunStatus[]>={
    QUEUED: ["RUNNING","INTERRUPTED"],
    RUNNING : [
        "WAITING_TOOL",
        "INTERRUPTED",
        "FAILED",
        "COMPLETED",
    ],
    WAITING_TOOL:[
        "RUNNING",
        "INTERRUPTED",
        "FAILED",
    ],
    INTERRUPTED:[
        "QUEUED"
    ],
    COMPLETED:[],
    FAILED:[]
}

export function assertValidTransition(
    from : AgentRunStatus,
    to : AgentRunStatus,
): void {
    if (!canTransition(from,to)){
        throw new Error(
            `非法的 AgentRun 状态转换：${from} -> ${to}`
        )
    }
}
```
讲解点：COMPLETED/FAILED 是终态（空数组）；INTERRUPTED 只能回到 QUEUED（重新走准入）；应用层状态机 + SQLite CHECK 约束 = 双保险。

### Snippet B — 双轨制注释（src/runs/agent-run.ts 开头注释，体现设计思想）
```typescript
 * Runtime 和 Run的最大区别就是 Runtime 是即时的，而 Run 是持久的
 * 那么从这个角度看，RuntimeEvent和RunEvent也是同样的区别
 * RuntimeEvent是即时的，而 RunEvent 是harness 长期保存的
```

### Snippet C — createQueuedRun：Run 与首个事件同事务诞生（src/runs/run-service.ts）
```typescript
    createQueuedRun(input : StartRunInput) : AgentRun {
        const runId = crypto.randomUUID(); 
        const timestamp = new Date().toISOString();
        const controlBinding = this.controlBindingResolver?.resolve(input);

        const run : AgentRun = {
            id:runId,
            tenantId:input.tenantId,
            harnessSessionId:input.harnessSessionId,
            status : "QUEUED",
            userInput:input.userInput,
            workspacePath:input.workspacePath,
            createdAt:timestamp,
            updatedAt:timestamp,
            startedAt:null,
            finishedAt:null,
            checkpointId:null,
            failureReason:null,
            ...(input.runPolicy === undefined
                ? {}
                : { runPolicy: input.runPolicy }),
            ...(controlBinding ?? {}),
        };

        const createdEvent : RunEvent = {
            eventId:crypto.randomUUID(),
            runId,
            sequence:1,
            type:"RUN_CREATED",
            timestamp,
            payloadVersion:1,
            payload:{},
        };

        this.store.create(run,createdEvent);

        return run;
    }
```
讲解点：sequence 从 1 开始；run 快照 + RUN_CREATED 在同一个 SQLite 事务里写入（避免"状态变了但历史没记"）。

### Snippet D — executeQueuedRun 的 finally 兜底（src/runs/run-service.ts 节选）
```typescript
        } catch (error) {
            this.markRuntimeInvocationFailureInterrupted(
                runId,
                error,
                "START_FAILED",
            );
            throw error;
        } 
        finally {
            unsubscribe();
            // Even an interrupted/failed attempt can leave user files behind; preserve that evidence.
            await this.workspaceResults?.captureAfter(runId, run.workspacePath);
            const current = this.store.get(runId);
            if (current?.status === "COMPLETED" || current?.status === "FAILED") {
                await this.workspaceResults?.captureArtifacts(runId, run.workspacePath);
            }
        }
```
讲解点：即使失败也要 captureAfter——中断的执行也会留下用户文件，证据必须保留；只有终态才固化 Artifact。

### Snippet E — RuntimeEventBridge 去重键（src/events/runtime-event-bridge.ts 节选）
```typescript
            case "tool_completed":
                return {
                    runId: event.runId,
                    type: event.isError
                        ? "TOOL_FAILED"
                        : "TOOL_COMPLETED",
                    timestamp: event.timestamp,
                    payloadVersion: 1,

                    // 一个工具调用只能拥有一个最终结果。
                    // 即使 Runtime 错误地先发成功、后发失败，也使用同一个去重键。
                    dedupeKey: `tool:${event.toolCallId}:finished`,
                    payload: {
                        toolCallId:event.toolCallId,
                        toolName:event.toolName,
                        result: event.result,
                        isError: event.isError,
                    },
                };
```
配合说明：数据库层 `UNIQUE(run_id, dedupe_key)` 部分唯一索引（dedupe_key IS NOT NULL）让 at-least-once 投递变幂等；text_delta 只用于实时展示不落库。

## 端到端流程（flow animation 用）
```
用户提交 workspaceId + userInput
→ HTTP 层验 API Key，解出 Principal（Tenant 不可伪造）
→ 任务持久化为 QUEUED（+RUN_CREATED 同事务）
→ 资源准入决策：START 或 QUEUE（policy_decisions 落库）
→ 调度器 claim + 占 slot（Tenant 内 FIFO、Tenant 间 round-robin）
→ 创建 Attempt + Sandbox（runsc 容器，只挂 workspace）
→ Pi 在沙箱里思考、调模型、用工具
→ 每个工具调用：先记账(PREPARED)→授权决策→执行→SUCCEEDED(+Checkpoint)
→ 完成后返回最终回答 + Diff + Artifact
```

## Interactive Elements
- [ ] **Message flow animation（本模块主视觉）** — actors: 用户 / HTTP API / RunQueueCoordinator / ResourceAdmission / Scheduler / Sandbox+Pi / SQLite。步骤按上面端到端流程 8-10 步，packet 从一方流向另一方。
- [ ] **Interactive state machine** — 六状态卡片 + 合法迁移箭头；点击状态显示"谁能进、谁能出"。可用 arch-diagram 或自绘卡片组实现（用 pattern-card + flow-steps 组合即可，不要写自定义 JS 引擎）。
- [ ] **Code↔English translation** — Snippet C（createQueuedRun）逐行白话；Snippet E（去重键）。
- [ ] **Quiz** — 3 题：(1) 场景：Run 处于 WAITING_TOOL，用户请求中断，合法目标状态有哪些；(2) 为什么 INTERRUPTED 只能回到 QUEUED 而不能直接 RUNNING（答：恢复也必须重新过资源准入和 slot 占用）；(3) 追踪题：text_delta 事件为什么不落库、它去了哪里（outputStore 实时拼接 finalText）。
- [ ] **Callout** — "事件溯源思想"：agent_runs 表存'现在是什么状态'，run_events 存'过去发生过什么'——查询快照、审计靠事件流。

## Reference Files to Read
- `references/content-philosophy.md` → 全文
- `references/gotchas.md` → 全文
- `references/interactive-elements.md` → Message Flow Animation, Code↔English, Multiple-Choice Quizzes, Flow Diagrams, Numbered Step Cards, Callout Boxes, Glossary Tooltips

## Connections
- **Previous:** Module 1 给了静态地图；本模块让数据流起来。
- **Next:** Module 3 深挖链路中最危险的一段——工具副作用与崩溃恢复。
- **Tone/style notes:** actor 配色沿用 Module 1 约定；SQLite/持久化相关统一用 actor-3 plum 表示。
