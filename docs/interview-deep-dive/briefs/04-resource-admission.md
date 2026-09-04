# Module 4: 资源准入与背压（深挖②）

## Teaching Arc
- **Metaphor:** 高速公路入口的红绿灯（匝道控制）。高速主路（GPU/vLLM）已经堵死时，匝道灯变红让新车排队——不是不让走，是现在上去谁都快不了。传感器坏了怎么办？灯默认常红（fail-closed），绝不猜"应该没事"。
- **Opening hook:** 120 个并发请求打进 T4 上的 vLLM，KV cache 打满、running=120——这时新任务该 START 还是 QUEUE？这个项目的回答是：先看仪表盘，再下决策，并且把每次决策写进数据库。
- **Key insight:** 准入是三段式管线：观测（observe）→ 分类（classify）→ 决策（decide），每段可独立失败、独立测试；任何一段失灵，输出都是 QUEUE 而不是 START。
- **Why should I care:** "显存高就排队"人人会做；面试官想听的是：观测什么指标、怎么解析、怎么分类、决策依据什么、失败了怎么办、证据怎么留。

## 三段式管线与关键细节

### 观测层 VllmResourceObserver
- **双源并行**：`Promise.all([readVllmMetrics(), readNvidiaGpu()])` ——避免最坏情况串行等两次 timeout。
- **降级语义**：单源失败不整体失败；双源都失败才返回 `ok:false`。快照字段允许 null——只有所有压力信号都不可用才算 UNKNOWN。
- **Prometheus 解析规则**（面试细节）：同一指标可能因 model_name 标签多行——请求数和 Token Counter 代表总工作量→**求和**；KV Cache 代表压力→**取最大值**，避免平均值掩盖高压实例。兼容 vLLM ≥0.7 把 `kv_cache_usage_perc` 改名 `gpu_cache_usage_perc`。
- **Token 速率**：Counter 型指标要两次观测算差值；vLLM 重启后 Counter 归零（current < previous）→ 返回 null 不给假速率。
- **nvidia-smi CSV**：多 GPU 显存求和、利用率取最大值。

### 分类层 classifyResource
四组阈值（busy/critical × gpuMemoryPercent/kvCachePercent/runningRequests/waitingRequests）；任一指标够到临界即升级；reasons 数组保留完整证据链（为什么 BUSY → KV_CACHE_BUSY）；无任何可用信号才是 UNKNOWN(INSUFFICIENT_DATA)。

### 决策层 DeterministicExecutionPolicy

### Snippet A — 决策矩阵（src/resources/execution-policy.ts decide 核心）
```typescript
        const pressure = input.classification.pressure;
        switch(pressure){
            case "CRITICAL":
                return this.createDecision(
                    input,
                    "QUEUE",
                    "RESOURCE_CRITICAL",
                );
            case "UNKNOWN":
                return this.createDecision(
                    input,
                    "QUEUE",
                    "RESOURCE_UNKNOWN",
                );
            case "BUSY":
                if (
                    input.activeRunCount >=
                    this.config.maxActiveRuns
                ) {
                    return this.createDecision(
                        input,
                        "QUEUE",
                        "GLOBAL_CONCURRENCY_LIMIT",
                    );
                }

                if (input.activeTenantRunCount > 0) {
                    return this.createDecision(
                        input,
                        "QUEUE",
                        "RESOURCE_BUSY_TENANT_LIMIT",
                    );
                }

                return this.createDecision(
                    input,
                    "START",
                    "RESOURCE_BUSY_TENANT_AVAILABLE",
                );

            case "NORMAL":
                if (
                    input.activeRunCount >=
                    this.config.maxActiveRuns
                ) {
                    return this.createDecision(
                        input,
                        "QUEUE",
                        "GLOBAL_CONCURRENCY_LIMIT",
                    );
                }

                return this.createDecision(
                    input,
                    "START",
                    "RESOURCE_NORMAL",
                );
        }
```
讲解点：BUSY 时"每租户最多 1 个在跑"（activeTenantRunCount > 0 就 QUEUE）——压力越大越保守的公平性保护。

### Snippet B — fail-closed：观测失败直接 QUEUE（src/resources/resource-admission-service.ts evaluate 节选）
```typescript
        const observation = await this.observer.observe();
        // 观测失败的情况下
        if (!observation.ok){
            const decision : PolicyDecision = {
                decisionId:crypto.randomUUID(),
                runId:request.runId,
                action:"QUEUE",
                reasonCode:"RESOURCE_OBSERVATION_FAILED",
                resourceSnapshotId:null,
                pressure:"UNKNOWN",
                observationFailureReason:observation.reason,
                decidedAt:new Date().toISOString(),
            };

            this.decisionRecorder.save(decision, null);

            return {
                observation,
                classification:null,
                decision,
            }
        }
```
讲解点：不伪造 Snapshot；snapshot 为 null + 失败原因由 migration v4 的 CHECK 约束双重保证；决策照样落库——"看不见"本身也是被审计的事实。

### Snippet C — 每次准入都落库（同事务）
`ResourceAdmissionService.evaluate` 成功路径最后：`this.decisionRecorder.save(decision, observation.snapshot)` —— policy_decisions + resource_snapshots 同事务落库；一个 run 反复被 defer 会保留多次决策历史（可解释决策的证据）。

### Snippet D — 预算装饰器（差异化加分项，src/resources/budget-aware-policy.ts 思想）
BudgetAwarePolicy 是 ExecutionPolicy 的装饰器：原策略说 START 后，再查租户账本（ResourceLedger commit/settle 模型）+ 公平份额 `computeFairShareUnits = floor(capacity × weight / totalWeight)`，超了就降级 QUEUE + TENANT_BUDGET_EXCEEDED。"调度尊重的是'这个租户已经消耗了多少'，不只是'它有几个 run 在跑'"。

## 真机证据（必须引用）
AutoDL Tesla T4 16G + vLLM 0.7.3：120 并发压测 → running=120、kv≈62% → CRITICAL → 新任务 QUEUE 落库（`scripts/e2e-gpu-pressure.ts`）。诚实边界：准入走 running/kv-cache 压力路径（真实），块调度与超大并发下的绝对公平份额仍属估算。

## Interactive Elements
- [ ] **Message flow animation** — actors: Coordinator / Observer(vLLM+GPU) / Classifier / Policy / policy_decisions(SQLite)。剧本：①claimNext 取出 Run ②并行观测两源 ③分类 BUSY(reasons=[KV_CACHE_BUSY]) ④策略判定 ⑤QUEUE→落库→release+重新入队；再来一轮 NORMAL→START。
- [ ] **Code↔English translation ×2** — Snippet B（fail-closed）、Snippet A 的 BUSY 分支。
- [ ] **Interactive threshold slider 或 pattern cards** — 四类指标卡（显存%/KV cache/running/waiting）各标 busy/critical 双阈值示例值，说明"任一达标即升级"。
- [ ] **Quiz** — 3 题：(1) 场景：vLLM /metrics 返回 504、nvidia-smi 正常——决策是什么？（答：单源降级可用，用 GPU 信号分类；若两者都挂才 RESOURCE_OBSERVATION_FAILED→QUEUE）；(2) 为什么 KV cache 用 max 而 token counter 用 sum；(3) 为什么 Counter 归零后第一次速率是 null。
- [ ] **Callout** — "fail-closed vs fail-open"：资源不可观测=QUEUE 是把不确定性当成危险而不是当成机会；安全系统从"不允许"起步逐条放行。

## Reference Files to Read
- `references/content-philosophy.md` → 全文
- `references/gotchas.md` → 全文
- `references/interactive-elements.md` → Message Flow Animation, Code↔English, Pattern/Feature Cards, Multiple-Choice Quizzes, Callout Boxes, Glossary Tooltips

## Connections
- **Previous:** Module 3 的恢复要重新入队——入队之后由本模块的准入决定何时真正开跑。
- **Next:** Module 5 讲队列本身：公平轮转怎么实现、slot 怎么占放、drain 怎么并发安全。
