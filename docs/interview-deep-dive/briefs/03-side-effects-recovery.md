# Module 3: 副作用记账与崩溃恢复（深挖①）

## Teaching Arc
- **Metaphor:** 支票双联存根。出纳每动一笔钱，先写好"我准备转 500 元"的存根（PREPARED）压在玻璃板下，转账成功后盖"已完成"章（SUCCEEDED）。银行倒闭重启后，看到只有存根没有章的交易：查一下是纯查询（READ_ONLY）就重做，是说不清影响的（UNKNOWN）就冻结等人工——绝不盲目重转。
- **Opening hook:** Agent 不是聊天机器人——它的 `bash` 会真删文件、真发网络请求。进程在工具执行到一半时崩溃，重启后这个工具该重放吗？
- **Key insight:** 恢复安全性的核心不是 Checkpoint 本身，而是**副作用分类**：只有 `PREPARED + READ_ONLY` 才能自动重放；连 IDEMPOTENT_WRITE 都 fail-closed。
- **Why should I care:** "任务崩了怎么办"是 agent infra 面试必问题。这模块给你从数据结构到决策函数的完整弹药。

## Code Snippets (pre-extracted)

### Snippet A — ToolEffect 三分类与 canAutomaticallyReplay（src/tools/tool-execution.ts 核心全部）
```typescript
export type ToolEffect = 
    | "READ_ONLY"
    | "IDEMPOTENT_WRITE"
    | "UNKNOWN_EFFECT";

export type ToolExecutionStatus = 
    | "PREPARED"
    | "SUCCEEDED"
    | "FAILED";

export function canAutomaticallyReplay(
    status:ToolExecutionStatus,
    effect:ToolEffect,
):boolean{
    if (status !== "PREPARED"){
        return false;
    }

    switch(effect){
        case "READ_ONLY":
            return true;
        case "IDEMPOTENT_WRITE":
            // “写入被声明为幂等”本身不足以证明外部系统会使用稳定幂等键。
            // 在 ToolExecution 持久化并校验真实幂等证据前保持 fail closed。
            return false;
        case "UNKNOWN_EFFECT":
            return false;
    }
}
```
讲解点（面试金句）："'写入被声明为幂等'本身不足以证明外部系统会使用稳定幂等键"——声明不等于证据，fail-closed。

### Snippet B — ToolGateway.execute 主流程（src/tools/tool-gateway.ts 节选）
```typescript
    async execute(
        input:ExecuteToolInput,
        invokeTool:() => Promise<unknown>,
    ) : Promise<unknown>{
        // 策略检查必须发生在 PREPARED 写入和真实副作用之前。
        this.policyGuard?.assertAllowed(input);

        const history = this.store.getByToolCall(runId,toolCallId);
        let preparedExecution : ToolExecution;

        if (history === null){
            preparedExecution = {
                id : crypto.randomUUID(),
                runId,
                toolCallId,
                toolName:input.toolName,
                arguments:input.arguments,
                effect:input.effect,
                status:"PREPARED",
                result:null,
                errorMessage:null,
                createdAt:new Date().toISOString(),
                finishedAt:null,
            }
            this.store.prepare(preparedExecution);
        } else {
            switch(history.status){
                case "SUCCEEDED":
                    return history.result;
                case "FAILED":
                    throw new Error(`工具执行失败:${history.errorMessage}`);
                case "PREPARED":
                    if (
                        !canAutomaticallyReplay(
                            history.status,
                            history.effect,
                        ))
                        {
                            throw new Error(
                                `不允许自动重放：${history.effect}`,
                            );
                        }
                    // 允许重放时复用原来的执行记录，
                    // 不能再次调用 store.prepare()，否则会违反唯一约束。
                    preparedExecution = history;
                    break;                    
            }
        }
```
讲解点：顺序铁律——策略检查 → 查历史 → PREPARED 落库 → 才 invokeTool。SUCCEEDED 直接返回缓存结果（天然幂等）；PREPARED+READ_ONLY 复用原记录重放（不能重复 prepare，唯一约束会炸）。

### Snippet C — completeWithCheckpoint：结果与检查点同事务（src/tools/tool-gateway.ts 节选）
```typescript
        const checkpoint:Checkpoint = {
            id:crypto.randomUUID(),
            runId:input.runId,
            toolExecutionId:preparedExecution.id,
            runtimeSessionRef:input.runtimeSessionRef,
            lastEventSequence:input.lastEventSequence,
            createdAt:finishedAt,
        }

        this.store.completeWithCheckpoint(succeededExecution,checkpoint);

        return result;
```
讲解点：Checkpoint 是稳定引用（runtimeSessionRef + lastEventSequence），不是内存 dump。工具结果与 checkpoint 同事务写入，不会出现"结果记了但恢复点丢了"。

### Snippet D — decideRecovery 决策函数（src/checkpoints/recovery-decision.ts 核心）
```typescript
export function decideRecovery (
    checkpointId:string|null,
    preparedExecution:readonly ToolExecution[],
):RecoveryDecision{
    if (checkpointId === null){
        const action : RecoveryAction = "MANUAL_REVIEW";
        const recoveryReason : RecoveryReason= "NO_CHECKPOINT";
        const execution : RecoveryDecision = {
            action:action,
            reason:recoveryReason,
            blockingToolExecutionId:null,
        }
        return execution;
    };
    const unsafeExecution = preparedExecution.find(
        (execution) => !canAutomaticallyReplay(
            execution.status,
            execution.effect,
        )
    );

    if (unsafeExecution !== undefined){
        return {
            action:"MANUAL_REVIEW",
            reason:"UNSAFE_TOOL_EFFECT",
            blockingToolExecutionId:unsafeExecution.id,
        }
    }

    return {
        action:"AUTO_RESUME",
        reason:"SAFE_CHECKPOINT",
        blockingToolExecutionId:null,
    }
}
```

### Snippet E — RecoveryService 分层注释（src/checkpoints/recovery-service.ts）
```typescript
 * 这一层只建立恢复计划，不直接调用 AgentRuntime：
 * - 扫描和状态修正是同步、确定性的数据库工作；
 * - Runtime resume 是可能失败的外部执行，应由下一层逐个消费计划。
```
配合流程：`scanInterruptedRuns()` 把陈旧 RUNNING/WAITING_TOOL 修正为 INTERRUPTED（带 PROCESS_RESTART 事件）→ buildPlan（取 preparedExecutions + 有效 checkpoint + decision）→ RecoveryExecutor 对 AUTO_RESUME 的计划调 `coordinator.submitResume`（重新入队走公平调度！）；MANUAL_REVIEW 留给人工。

### Snippet F — 恢复的归属校验（src/runs/run-service.ts queueResume 节选）
```typescript
        if (
            input.checkpoint.runId !== input.runId
            || interruptedRun.checkpointId !== input.checkpoint.id
        ) {
            throw new Error(
                `Checkpoint ${input.checkpoint.id} 不属于当前 Run`,
            );
        }
```
讲解点（面试加分）：恢复是多租户防串的隐蔽死角——不校验 runId 就可能"用 A 的恢复数据驱动 B"。同类绑定还有策略快照 `snapshot.runId === input.runId`。

## Interactive Elements
- [ ] **Code↔English translation ×2** — Snippet A（canAutomaticallyReplay 全函数）、Snippet B（execute 前半段）
- [ ] **Message flow animation** — actors: Pi(模型) / ToolGateway / ToolExecutionStore(SQLite) / 外部世界(文件系统)。剧本：①Pi 要跑 bash rm → ②Gateway 先问策略守卫 → ③写 PREPARED 存根 → ④真正执行 → ⑤成功→ SUCCEEDED+Checkpoint 同事务落库；然后"剧情转折"：⑥进程崩溃！⑦重启后 RecoveryService 读到孤儿 PREPARED → ⑧effect=UNKNOWN → MANUAL_REVIEW。
- [ ] **Drag-and-drop** — 把 {读文件, 幂等写, 发邮件, bash 脚本, SELECT 查询} 等 5 个工具行为拖到 READ_ONLY / IDEMPOTENT_WRITE / UNKNOWN_EFFECT 三个分类框。
- [ ] **Quiz** — 3 题：(1) 场景：一个 IDEMPOTENT_WRITE 工具崩溃时停在 PREPARED，能自动重放吗？为什么（考"声明≠证据"）；(2) 为什么 RecoveryService 不直接调 runtime.resume，而要经过 coordinator.submitResume（答：恢复也要重新过资源准入与公平队列）；(3) Spot-the-bug 变体：如果 execute 里先 invokeTool 再 store.prepare 会发生什么。
- [ ] **Callout** — "双复写（write-ahead intent）"是数据库 WAL、分布式事务 2PC 的共同思想：先持久化意图，再执行，最后确认。

## Reference Files to Read
- `references/content-philosophy.md` → 全文
- `references/gotchas.md` → 全文
- `references/interactive-elements.md` → Code↔English, Group Chat Animation, Drag-and-Drop, Multiple-Choice Quizzes, Callout Boxes, Glossary Tooltips

## Connections
- **Previous:** Module 2 的状态机里 INTERRUPTED→QUEUED 这一跳，本模块讲清它背后的完整决策链。
- **Next:** Module 4 讲另一个 fail-closed 现场——资源观测失败时宁可排队也不盲跑。
