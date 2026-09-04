# Module 8: 差异化深化 A/B/C（深挖⑥）

## Teaching Arc
- **Metaphor:** 车队管理三件套。A 是行车记录仪+油耗报表（评测：任务跑完了，但跑得好不好？）；B 是车队调度大屏（观测驾驶舱）；C 是备用路线导航（LLM 网关：主路堵了自动换备路，连续堵路就先不推荐这条路）。
- **Opening hook:** 任务能跑通只是及格线。面试官问"你的项目有什么别人没有的"——A/B/C 是为 agent infra 岗位准备的三个差异化记忆点。
- **Key insight:** 三个方向的共同设计哲学：**零侵入**。A 只读已有落库数据（零新增采集）；B 是独立只读页；C 只改 models.json 的 baseUrl 指向网关——Agent、控制面、沙箱都不变。
- **Why should I care:** 这三个方向分别对应岗位 JD 里的 eval、observability、inference gateway 关键词。

## A · 执行质量评测闭环（src/eval/evaluation-aggregator.ts）

### 数据来源映射（零新增采集的证据）
| 表 | 提供什么指标 |
|---|---|
| agent_runs | 终态/租户/排队耗时(created→started)/执行耗时(started→finished)/checkpoint |
| run_attempts | 尝试次数 |
| tool_executions | 工具副作用画像 + 被拦危险副作用数 |
| run_events(MODEL_COMPLETED) | LLM token/cost 用量（聚合 payload.usage） |
| run_workspace_diffs / run_artifacts / run_output_chunks | 完成度（diff 率/artifact 率/finalText 率） |
| policy_decisions | 资源准入评测（背压触发率、观测失败率） |

### 两类指标
- 行业标配：成功率、平均尝试次数、queueWaitMs/runDurationMs 的 avg+p95、token 总量与成本。
- 控制面护城河：**背压触发率**（pressuredRate）、**无人值守率**（unattendedRate = 没有"被拦危险副作用"的任务占比）、**cache 命中率**（cacheRead/(input+cacheRead)）、危险拦截率（blockedDangerousToolCount）。

### Snippet A — 无人值守率的定义（src/eval/evaluation-aggregator.ts）
```typescript
            // 无人值守率：没有「被拦下的危险副作用」的任务占比。
            unattendedRate: rate(
                runs.filter((r) => r.blockedDangerousToolCount === 0).length,
            ),
```
配合 Snippet A2：
```typescript
            // 仍处于 PREPARED 且不可自动重放 = 被拦下的危险副作用。
            if (
                row.status === "PREPARED"
                && !canAutomaticallyReplay(row.status, row.effect)
            ) {
                blockedDangerousToolCount += 1;
            }
```
讲解点：复用 Module 3 的 canAutomaticallyReplay——评测层和控制面共享同一套安全语义，不是两套标准。输出：`scripts/eval-report.ts` 文本报表 + `GET /eval` JSON。

## B · 观测驾驶舱（src/http/harness-observe-page.ts）
- 独立只读页 `/observe`，与任务操作台 `/` 解耦；数据来自 `GET /eval`。
- 可视化：状态环形图、完成度渐变条、租户对比条形、资源背压堆叠条、任务明细表。
- 多租户切换；无认证演示模式支持 ?tenant= 过滤，有认证时按 principal.tenantId 隔离。

## C · LLM 路由网关（src/llm-gateway/）

### 回退语义（面试可讲的原话）
> 429 / 5xx / 网络错误 / 超时 → 认为是后端问题，回退到下一个后端；其余 4xx（如参数/鉴权错误）→ 认为是请求本身问题，回退无意义，直接透传。

### Snippet B — 熔断器状态机（src/llm-gateway/model-router.ts candidatesFor 节选）
```typescript
    candidatesFor(logicalModel: string): LlmBackend[] {
        const list = this.backendsByModel.get(logicalModel) ?? [];
        const now = this.now();
        return list.filter((b) => {
            const state = this.states.get(b.id);
            if (!state) return true;
            if (state.circuitOpenUntil === 0) return true;
            if (now >= state.circuitOpenUntil) {
                // 冷却结束：半开，允许一次尝试
                state.circuitOpenUntil = 0;
                return true;
            }
            return false;
        });
    }
```
配合 recordFailure：连续失败 ≥3 次（threshold）→ circuitOpenUntil = now + 30s（cooldown）；recordSuccess 清零。经典三态：Closed → Open → Half-Open。

### Snippet C — 回退主循环骨架（src/llm-gateway/llm-gateway.ts handleChatCompletions 节选）
```typescript
        for (const backend of candidates) {
            attempted.push(backend.id);
            const outcome = await this.tryBackend(backend, body);
            if (outcome.kind === "success") {
                this.router.recordSuccess(backend.id);
                this.router.recordDecision({
                    ...base,
                    chosenBackendId: backend.id,
                    status: "SUCCESS",
                    httpStatus: outcome.response.status,
                    fallback: attempted.length > 1,
                    latencyMs: this.now() - startedAt,
                    error: null,
                });
                return outcome.response;
            }
            if (outcome.kind === "client-error") {
                // 请求本身问题：不回退，直接透传上游 4xx。
                this.router.recordDecision({
                    ...base,
                    chosenBackendId: backend.id,
                    status: "FAILED",
                    httpStatus: outcome.response.status,
                    fallback: attempted.length > 1,
                    latencyMs: this.now() - startedAt,
                    error: `上游返回客户端错误 ${outcome.response.status}`,
                });
                return outcome.response;
            }
            // retryable：记录失败并回退下一个后端
            this.router.recordFailure(backend.id);
        }
```
讲解点：每次选择记录 RouteDecision（选谁、试了谁、是否回退、延迟、成败）——与 policy_decisions"决策台账"同一思路；stream:true 时透传上游 SSE 流 body；转发时把逻辑模型名替换为后端真实模型名。

### 诚实边界（必须主动讲）
C 第一步完成（网关逻辑 + mock 测试 10 个 + 端到端冒烟）；第二步（Pi 真实调用经网关）未完成；RouteDecision 是内存环形缓冲（200 条），未持久化。网关入口已接统一身份主干：POST /v1/chat/completions 要 models:generate scope，GET /llm-gateway/stats 要 models:observe。

## Interactive Elements
- [ ] **Pattern cards ×3 大卡** — A/B/C 各一张大卡：一句话价值 + 关键文件 + 当前边界。
- [ ] **Code↔English translation ×2** — Snippet A2（危险拦截计数）、Snippet B（熔断三态）。
- [ ] **Message flow animation** — LLM Gateway 回退剧本：Pi 请求 model=qwen-dev → 网关查 candidates → 后端 vllm-local 超时(retryable) → recordFailure → 试 opencode-cloud 成功 → RouteDecision{fallback:true} 落环形缓冲。
- [ ] **Quiz** — 3 题：(1) 场景：上游返回 401 鉴权错——网关会回退吗？为什么；(2) unattendedRate 高说明什么？它和成功率有什么区别；(3) 为什么说 Eval 层"零新增采集"是设计优点而不是妥协。
- [ ] **Callout** — "可观测性三支柱"在 Agent 场景的落地：logs=RunEvent 时间线、metrics=Eval 聚合、traces=MODEL_STARTED/COMPLETED 带 usage 与 durationMs。

## Reference Files to Read
- `references/content-philosophy.md` → 全文
- `references/gotchas.md` → 全文
- `references/interactive-elements.md` → Pattern/Feature Cards, Code↔English, Message Flow Animation, Multiple-Choice Quizzes, Callout Boxes, Glossary Tooltips

## Connections
- **Previous:** Module 3-7 是基础闭环；本模块是闭环之上的增值层。
- **Next:** Module 9 把全部证据、数字、诚实边界和追问 Q&A 打包成弹药库。
