# Module 5: 公平调度与队列推进（深挖③）

## Teaching Arc
- **Metaphor:** 幼儿园分苹果。两个班（Tenant）的孩子排队领苹果，老师不按"先来后到"全局排，而是两个班轮流各发一个——A 班第一个、B 班第一个、A 班第二个……这样 A 班就算有 100 个孩子也不会把 B 班饿死。每个班还有自己的上限（maxActiveRunsPerTenant），防止一个班占光整个果篮。
- **Opening hook:** Tenant A 一口气提交 50 个任务，Tenant B 只提交 1 个——如果用全局 FIFO，B 的任务要排在第 51 位。这个系统里 B 排第 2。
- **Key insight:** 公平 = Tenant 内 FIFO + Tenant 间 round-robin + 全局/单租户双并发上限；而 slot 占用与释放的时序正确性（先 release 再 re-enqueue）比算法本身更容易出 bug。
- **Why should I care:** "怎么避免租户饥饿"是多租户系统面试的经典题，这模块给你从数据结构到时序图的完整答案。

## Code Snippets (pre-extracted)

### Snippet A — 轮转选择 claimNext 核心（src/scheduling/tenant-run-scheduler.ts）
```typescript
    claimNext() : QueuedRun | null {
        if (this.activeTenantByRunId.size >= this.config.maxActiveRuns){
            return null;
        }

        const tenantsToInspect = this.tenantOrder.length;

        for (
            let inspected = 0;
            inspected < tenantsToInspect;
            inspected += 1
        ) {
            const tenantId = this.tenantOrder.shift();

            if (tenantId === undefined) {
                return null;
            }

            const tenantQueue = this.queuesByTenant.get(tenantId);

            if (
                tenantQueue === undefined || tenantQueue.length === 0
            )   {
                this.queuesByTenant.delete(tenantId);
                continue;
            }

            const activeTenantByRunCount = this.getActiveTenantRunCount(tenantId);

            // 当前 tenant 已经达到并发上限，它仍有等待任务，所以放回轮转队尾.
            if (activeTenantByRunCount >= this.config.maxActiveRunsPerTenant){
                this.tenantOrder.push(tenantId);
                continue;
            }

            const run = tenantQueue.shift();

            if (run === undefined){
                this.queuesByTenant.delete(tenantId);
                continue;
            }

            if (tenantQueue.length > 0){
                this.tenantOrder.push(tenantId);
            }   else {
                this.queuesByTenant.delete(tenantId);
            }
            
            this.activeTenantByRunId.set(
                run.runId,
                run.tenantId
            );
            return run;
        }
     
        return null;
    }
```
讲解点：数据结构是 `Map<tenantId, QueuedRun[]>` + `tenantOrder[]` 轮转数组 + `activeTenantByRunId` slot 表。选中即占 slot——claim 语义是"离开队列并占用一个并发名额"。公平顺序示例（代码注释原文）：Tenant A: A1,A2,A3 / Tenant B: B1,B2 → A1→B1→A2。

### Snippet B — attemptNext 的准入时序（src/scheduling/run-queue-coordinator.ts 节选）
```typescript
        const queuedRun = this.scheduler.claimNext();

        if (queuedRun === null) {
            return {
                kind : "EMPTY",
            };
        }

        // 选出 run 的时候，run 已经离开队列并占用了 slot，所以需要更新资源情况
        const capacity = this.scheduler.getCapacity(queuedRun.tenantId);

        const admissionRequest = {
            runId : queuedRun.runId,
            tenantId : queuedRun.tenantId,
            activeRunCount : capacity.activeRunCount - 1,
            activeTenantRunCount : capacity.activeTenantRunCount - 1,
        }
```
讲解点（面试金句）：**槽位双保险**——scheduler claimNext 是硬上限；admissionRequest 把自己刚占的 slot 减掉再给策略做软判断，算术自洽，不会自己把自己挤下去。

### Snippet C — QUEUE 分支的 release/re-enqueue 顺序（同文件）
```typescript
        if (decision.action === "QUEUE") {
            const reasonCode = toQueueReasonCode(decision);

            this.scheduler.release(queuedRun.runId);
            // 顺序一定要是先release再 run，否则enqueue会认为 run 仍在执行并拒绝入队
            this.scheduler.enqueue({
                runId:queuedRun.runId,
                tenantId:queuedRun.tenantId,
                reasonCode,
                enqueuedAt:queuedRun.enqueuedAt,
            });

            return {
                kind:"DEFERRED",
                runId:queuedRun.runId,
                decision,
            }
        }
```
讲解点：`enqueuedAt` 原样带回——被 defer 的 Run 不丢自己的排队时间（FIFO 公平不被惩罚）；注释原文解释了为什么必须先 release。

### Snippet D — drain 单飞模式（single-flight，同文件）
```typescript
    drain() : Promise<CoordinatorResult[]> {
        // 每次调用都代表系统状态可能发生了变化
        // 因此至少请求进行一轮队列检查
        this.drainRequested = true;

        // 已经有drain在执行，重复用同一个Promise
        if (this.drainPromise !== null){
            return this.drainPromise;
        }

        // 没有 drain 执行，就启动新的推进循环
        this.drainPromise = this.runDrainLoop();
        return this.drainPromise;
    }
```
配合 runDrainLoop 讲解：`while(this.drainRequested){ this.drainRequested=false; await drainOnce(); }` ——drain 执行期间又有人调 drain()，标志位重新变 true，循环继续下一轮；不会并发跑两个 drain。finally 里清空 drainPromise。

### Snippet E — Pump 与启动重建
- `RunQueuePump`：setInterval 定时 tick → target.drain()；构造后立即 tick 一次不等首个间隔；stop 只清定时器不打断进行中的 drain。
- `HarnessApplication.submitRun`：`void this.queuePump.tick()` ——提交后立即触发一轮调度，不必等轮询周期。
- 启动重建：进程重启后从持久化 QUEUED 行重建内存队列（restoreQueuedRun）；listActiveRuns 把陈旧 RUNNING 转 INTERRUPTED 再走恢复扫描。

### 已知设计缺口（诚实边界，面试主动讲反而加分）
| # | 缺口 | 影响 |
|---|---|---|
| ① | harnessSessionId 客户端可自报 | 会话固定/抢注 DoS；结论倾向：服务端签发 |
| ② | 队列 reasonCode 仅存内存 | 重启后 GET /queue 排队原因不可复现 |
| ③ | 缺 RUN_DEFERRED 事件类型 | 反复 defer 的过程在事件链上是空白 |
| ④ | TOCTOU 归档窗口：claimNext 与 release+re-enqueue 之间崩溃 | run 从内存队列消失但 DB 仍 QUEUED，需等重启 recovery 回队 |
| ⑤ | 准入是 point-in-time | 决策 t0、派发 t1 中间资源可变；定位为"去耦的准入点" |

## Interactive Elements
- [ ] **Interactive round-robin 可视化（本模块主视觉）** — 两列卡片（Tenant A: A1-A3，Tenant B: B1-B2），"下一步"按钮逐个高亮 A1→B1→A2→B2→A3，旁边显示 slot 计数器变化。用 flow-animation 或 step-cards 实现。
- [ ] **Code↔English translation ×2** — Snippet C（release/re-enqueue 时序）、Snippet D（single-flight）。
- [ ] **Quiz** — 3 题：(1) 场景：maxActiveRuns=4 已满，Tenant B 提交新任务，claimNext 返回什么？B 的任务会丢吗；(2) 为什么被 defer 的 Run 要保留原 enqueuedAt；(3) 场景：drain 正在执行时用户又提交了任务，会发生什么（答：drainRequested=true，当前循环结束后再来一轮，不会起第二个并发 drain）。
- [ ] **Callout** — "single-flight 模式"：把'多次并发请求合并为一次执行+补跑一轮'，是去抖与并发控制的通用手法（Go 的 singleflight 库同理）。

## Reference Files to Read
- `references/content-philosophy.md` → 全文
- `references/gotchas.md` → 全文
- `references/interactive-elements.md` → Message Flow Animation, Code↔English, Multiple-Choice Quizzes, Numbered Step Cards, Callout Boxes, Glossary Tooltips

## Connections
- **Previous:** Module 4 决定 START/QUEUE；本模块讲 QUEUE 之后谁先被叫到号。
- **Next:** Module 6——被叫到号的 Run 凭什么身份执行？多租户防串六道防线。
