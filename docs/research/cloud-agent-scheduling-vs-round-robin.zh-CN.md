# 云端 Agent 平台怎么做调度，以及我们的 Round-Robin 还差什么

> 范围：回答两件事——(1) Grok / Manus / Jules / Devin / Cursor / Modal 这类云端 Agent 平台的调度机制长什么样；(2) 本仓库 `src/scheduling` 这套「租户内 FIFO + 租户间 Round-Robin」还有多少改进空间：哪些是 bug、哪些是模型选型问题、哪些只是没配好。
> 对照基线（`src/app/harness-config.ts` 默认值）：`HARNESS_MAX_ACTIVE_RUNS=30`、`HARNESS_MAX_ACTIVE_RUNS_PER_TENANT=10`、`HARNESS_SCHEDULER_AGING_MS=60000`、`HARNESS_QUEUE_TTL_MS=300000`、`HARNESS_PUMP_INTERVAL_MS=1000`、`HARNESS_EXECUTION_TIMEOUT_MS=30min`、`HARNESS_MAX_QUEUED_RUNS=0`（0=关闭背压）。沙箱：每 Run 一台 microVM，热恢复 median 101.3ms / p95 129.6ms（`docs/research/cold-start-standby-pool.md`）。
> **前提（2026-10-21 用户确认）**：本项目**所有租户等权、不考虑优先级**。本文结论以「等权公平」为准：**RR 是等权场景下合适的基础排序算法，不需要引入 WFQ/DRR/权重**；代码里现存的显式优先级链路（`priority`）属于越界功能，建议整条删除。
> 标注约定：**[已验证:代码]** = 本仓库源码/可运行测试直接读到；**[已验证:文档 URL]** = 厂商文档原文；**[未披露]** = 公开资料没有，不编数字；**[推测]** = 基于事实的推断。
> 证据：`.tmp-ops/sched-verify/assertion{1..5}-*.test.ts`（5 个文件 8 pass）、`.tmp-ops/sched-research/industry.md` + `raw/`（40 处带 URL 的一手抓取件）。现有调度回归：`bun test tests/scheduling` = 66 pass / 0 fail。

---

## 0. 结论速览（TL;DR）

1. **RR 算法本身没写错；在"所有租户等权"这个前提下，它还是合适的基础排序算法。** 对称负载下严格 `A,B,C` 轮转、无漂移（已用 `assertion3` 验证），某一方队列耗尽时它多拿份额属于 work-conserving 的正确行为。**问题不在环本身，而在环之外的 5 个缺陷 + 1 个静态配额。** **[已验证:可运行测试]**
2. **业界主流不是"全局 RR"，而是「配额管份额、队列管溢出、租约管执行」三段式；2026 世代的常驻 Agent（Muse / dots / Cue / Grok Bot）更进一步，直接用"每人一台持久电脑 + 用量额度"绕开了共享队列。** Jules 直接按套餐给 3/15/60 并发并把"队列优先级"列为更高档位卖点；Modal 用 plan 级并发上限 + `buffer_containers` 换延迟；Devin Outposts 用「原子 CAS claim + claim_deadline」让 N 台 worker 抢一个队列，官方明说"不需要中心调度器"。**[已验证:文档]**
3. **3 个已复现的公平性缺陷，与 RR 选型无关**：① 队首被会话串行挡住时，同租户后面的可调度 Run 永远轮不到；② 老化只看队首，队首被挡时后面的 Run 拿不到老化补偿；③ **显式优先级整条压过老化**——而在等权定位下，这条功能本身就不该存在。**[已验证:可运行测试]**
4. **还有 2 个设计耦合在吃掉吞吐和正确性**：④ `drainOnce` 的批屏障——slot 要等批内**最长的一条 Run** 跑完才补位；⑤ Queue TTL 把「同会话串行等待」也当饥饿，追问会在前一条跑满 5min 后被 `FAILED(QUEUE_TIMEOUT)` 误杀。**[已验证:代码]**
5. **等权下真正的"份额"问题是静态 per-tenant cap，不是 RR**：只有 2 个活跃租户时，各 10 + 全局 30 → **最多只能跑到 20/30（67%）**，有排队也补不满；4 个以上租户时，任一租户又能拿走 10/30 = 33%。改成 `cap_t = max(1, floor(C / N_active))`（空闲份额可借用）一处同时解决利用率和份额。**[已验证:可运行测试 assertion5]**
6. **我们并不落后，反而有两处行业里少见的差异化**：`agingMs` 老化防饿死、以及结构化的 `QueueReasonCode` + 队首阻塞事件流。公开资料里 **没有一家做 aging**（K8s 用抢占代替），**也没有一家给排队位置/ETA**。这两条要保留并修对，而不是拆掉。**[已验证:文档 + 未披露]**
7. **改造路线**：P0 = 删除优先级 + 修 HOL/老化 + 修 TTL（1~2 天，不动调度模型）；P1 = 动态公平 cap + 派发/完成解耦 + 有界队列 + 租约心跳；P2 = DB 原子 claim 支持多实例。**不需要** WFQ/DRR/权重/档位。**不建议**：LLM 当调度器、抢占在跑的 Run、恢复 VRAM 感知、跨节点放置、按租户预热池。

---

## 1. 先把"调度"拆成三层，否则会讨论串味

云端 Agent 平台的"调度"是三个不同问题，混着谈就会得出"RR 好不好"这种没有答案的问题：

| 层 | 回答的问题 | 业界机制 | 我们的现状 |
|---|---|---|---|
| **L1 准入/配额** | 该不该接收？接收后最多占多少？ | 按 plan/org 的并发槽位 + 日配额；超额 429 或排队 | 全局 30 / 租户 10 静态上限；`maxQueuedRuns` 默认 0=不启用；超额抛 `QueueBackpressureError`（`retryAfterSeconds` 写死 5） |
| **L2 排队/排序** | 空出 slot 给谁？ | FIFO + 优先级 + **配额/权重**；少数用老化 | **RR 环 + 租户内 FIFO + 老化**（显式优先级待删除，见 P0-2） |
| **L3 放置/执行** | 在哪跑？怎么保证不重复跑？ | 预热/快照；**原子 claim + lease + 心跳** | 单机；每 Run 一台 microVM；`leaseManager.reapExpired()` |

**核心判断**：RR 只作用在 L2，且只决定**顺序**。用户感知的公平由 L1（份额）和 L3（时长/租约）决定。我们和云端平台的差距主要在 L1/L3，不在 L2 的轮转写法。**[推测，依据见 §2/§3]**

---

## 2. 业界怎么做

### 2.1 六条共性（几乎人人相同）

1. **份额用配额表达，不用轮转表达**：并发槽位按 plan/org 静态给定，队列只负责溢出。**[已验证:文档]**
2. **调度单位是"任务/会话"，不是"步骤"**；步骤级并行靠应用层扇出（Manus Wide Research 起 N 个 subagent、Devin 起多个 managed session），每个拿一台 VM。**[已验证:文档]**
3. **一任务一沙箱，会话粘性是结构性的**（task ↔ 1 VM / 1 workspace），不是调度策略。**[已验证:文档]**
4. **原子 claim + 租约 + 到期重回队列**，而不是"中心调度器记住谁在跑"。**[已验证:文档]**
5. **不抢占运行中的任务**：中断=烧 token + 丢工作区；只有用户 stop / 执行超时 / 空闲回收。K8s 那种抢占是给无状态 Pod 的。**[已验证:文档]**
6. **队列时间是一等观测指标**（Modal 把 "input 在 pending 等多久" 当首要优化目标），但**位置/ETA 基本没人做**。**[已验证:文档]**

### 2.2 七维度横向对照（只填有证据的；`?` = 公开未披露）

| 维度 | Manus | xAI/Grok | Devin | Codex Cloud | Cursor | Jules |
|---|---|---|---|---|---|---|
| 准入单位 | 每 user API QPS（`task.create` 10/min），不分档 | per-team per-model RPS/TPM，按累计消费分 tier（T0 9 RPS） | 组织/个人 ACU 额度 + outpost 队列 pending | plan usage allowance（5h 窗口） | ?（"并行数不限"，受 spend limit 约束） | **并发 3/15/60 + 日 15/100/300（滚动 24h）** |
| 超额语义 | 429 `rate_limited` | 429 | 排队（pending） | ? | 排队（pool pending） | **硬拒绝**（禁用 New task） |
| 公平性 | ? | 付费档换 RPS | FIFO 竞争 claim（无优先级） | ? | ? | 档位=并发数；"queue prioritization" 列为更高档位 |
| 老化/防饿死 | ? | 无 | 无 | ? | 无 | 无 |
| 会话粘性/串行 | **结构性**：task ↔ 1 Sandbox | 子会话独立 context | session ↔ 1 VM；resume 需同目录+snapshot | task ↔ 1 workspace | **显式**：一 session 一 worker，turn 中拒绝 release | ? |
| 供给 | 按需起 VM + sleep/wake；回收后**选择性恢复** | ? | claim 后自己 provisioning；snapshot 保命 | 预热环境 **5min 未 attach 过期**；共享环境 20min idle 寿命（有 pending/active turn 则不过期） | 预构建 Builds 快照 + 池 | environment snapshots |
| 可观测 | 任务事件流，无位置 | 无 | 企业级 queue_size 阈值（normal/elevated/high）**[未披露:原始抓取件里未找到该页]** | ? | ? | 只告知"到限额了" |

来源：`https://jules.google/docs/usage-limits`、`https://docs.devin.ai/cloud/outposts/orchestration`、`https://modal.com/docs/guide/scale`、`https://cursor.com/docs/background-agent`、`https://manus.im/help`（Sandbox 生命周期）、`https://docs.x.ai/build/features/subagents`、`https://e2b.dev/docs/sandbox/persistence`、`https://www.daytona.io/docs/en/gpu-sandboxes`。逐条原文见 `.tmp-ops/sched-research/industry.md` / `raw/`。

### 2.3 逐家要点（只留与调度有关的）

- **Jules（唯一给全数字）**：并发 3/15/60、日任务 15/100/300，超额**硬拒绝**而非静默排队；"queue prioritization" 是更高档位的差异点。→ **份额=配额；优先级是服务端按档位给的，不是客户端随便填的。**
- **Devin Outposts（机制最透明）**：一个 outpost = 一个命名队列；worker 用**原子 CAS claim** 抢 session，输者 `409` 走开；claim 有 `claim_deadline`，过期自动回队列（"failures self-heal，无需 fleet 健康检查"）；"N 台机器服务 N 个并发 session，其余 pending"。→ **这正是我们 L3 该走的路。**
- **Modal**：`max_containers` / `min_containers`（常热）/ `buffer_containers`（活跃期缓冲）/ `scaledown_window`，单 Function 硬顶 4000 并发；平台级并发按 plan。→ **"预热换延迟"是显式成本旋钮。**
- **E2B**：Hobby 20 并发 / 1 创建/s，Pro 100–1100 / 5 创建/s；超额 **429 + `Retry-After`**；paused 沙箱保留内存+文件系统、无 TTL；`setTimeout` 每次重置本身就是心跳。→ **拒绝优于无限排队；超时续租=心跳。**
- **Daytona**：org 级资源配额（默认 1vCPU/1GB/3GiB，org 上限 4vCPU/8GB/10GB）；spot GPU **可抢占且不占配额**，无容量时 **create 立即失败**（fail-fast，不排队）。→ **配额粒度是资源量；可抢占档位是成本杠杆。**
- **Cursor**：云上隔离 VM，"可以并行跑任意多个 agent"，但要求设 spend limit；一 session 一 worker，turn 期间拒绝 release。→ **无硬顶时用成本上限兜底。**
- **Codex Cloud**：发布快照 + 预热池；未 attach 的预热环境 **5 分钟过期**；共享环境 attach 后 **20 分钟 idle 寿命**，但文档明确写「**pending work 和 active turn 会阻止 idle 过期**」。→ **回收必须豁免「有排队/在跑工作」的会话，不能只看空闲时长。**
- **Manus**：task ↔ 1 Sandbox（有 root、可随意改系统）；inactive 自动 sleep、再次操作自动 wake（文件不变）；连续 sleep 后回收（Free 7 天 / Pro 21 天），回收后只恢复 artifacts、附件、Slides/WebDev 等重要文件，**中间代码与临时文件不恢复**；Wide Research 的并行 subagent 每个都是完整 Manus 实例。→ **会话粘性 + 快照恢复的收益与损失边界要显式告诉用户。**
- **xAI/Grok**：公开文档里**没有云 Agent 队列/VM 池的描述**；多 agent 是**模型侧编排**（subagent = 独立子 session、独立 context、回传摘要），限流是 per-team per-model RPS/TPM。grok-code-fast-1 发布版**不支持并行工具调用**（官方原话：支持并行工具调用的新变体"已在训练中"，[https://x.ai/news/grok-code-fast-1]）。→ **这里缺的不是"更聪明的租户调度"，而是 Run 内部的并行子任务，属于另一条产品线。**
- **基础设施对照组**：Fly Machines = 没有队列只有机器；Ray = 资源 pending + autoscaler，队列语义靠 Kueue/KAI；K8s = ResourceQuota + PriorityClass + **抢占驱逐**（用抢占代替公平）。

> ⚠️ 澄清：公开可检索资料里**没有**署名 "Stuart" 的 Manus 工程复盘，也没有 "Manus cue" / "Grok bot" 的调度机制文档。Manus 的公开架构复盘是 Yichao 'Peak' Ji 的 context engineering 文章（讲压缩，不讲队列）。本文按**公司/平台**层面可验证的机制整理，查不到的一律标未披露。

### 2.4 他们不约而同避开的东西

- **不做全局 RR**：RR 的隐含假设是"调度单元成本相同"。业界用配额/权重吸收成本差异；RR 只出现在**同构单元**之间（如我们 `src/llm-gateway` 的 `round-robin` 策略——那里单元都是 LLM 请求，RR 才是对的）。
- **不做时间片抢占**：改用执行超时 + 挂起 + 快照（我们已有 `SupervisedAgentRuntime` 的 30min 超时 + 优雅中断/强杀两级语义）。
- **不做排队位置/ETA**：多数只告知"到限额了"或"pending"；这是我们可以做得比业界好的地方。

### 2.5 2026 世代：常驻 Agent 产品（Muse / dots / Cue / Grok Bot）——另一条技术路线

这一代产品和上面"按任务排队"的平台（Jules/Devin/E2B）不是同一种东西：**调度单元从"任务"变成了"常驻 Agent + 它那台电脑"**。四家公开文档口径高度一致：

| 产品 | 每个 Agent 的算力载体 | 并发/互斥模型 | 超额语义 | 持久性 |
|---|---|---|---|---|
| **Meta Muse**（2026-09 上线） | **Muse Secure VM**：持久隔离 Linux + 完整浏览器 + 文件系统 + 终端，用户与 agent 共用 | 一个 Muse 一台 VM，后台持续干活 | 免费版有用量上限，到顶后升级或等刷新 | VM 持久，状态不随会话重置 **[已验证:文档 https://ai.meta.com/muse/]** |
| **OpenAI dots**（GPT-6 Astra） | 每个 dot **自己的 cloud computer**（含浏览器），24/7 在线 | 一个 dot 同时推进多个项目；未来可"加更多 dot" | **plan 内 allowance**；未来按"提速"或"每月总工作量"扩容 | dot 有记忆、文件和浏览器会话 **[已验证:文档 https://openai.com/index/introducing-dots/]** |
| **Manus Cue**（Manus 2.0，2026-09-28） | 每个 agent 有**自己的电脑 + 邮箱 + 电话号码 + 钱包** | 多 agent 拉群协作，互相交接任务 | 早期访问免费；钱包按你设的预算花 | 你下线后继续跑 **[已验证:文档 https://cue.im/ + https://manus.im/blog/introducing-manus-2-0]** |
| **Grok Bot**（xAI，跑在 Cursor 云上） | **账号级共享一台**持久云电脑；每个 Bot 一个独立"屏" | **一个 Bot 同一时刻只跑一个 computer-use 任务；多 Bot 并行** | 每周用量池 + on-demand 月上限；**"限额不是跑到一半硬停，已经在跑的可以跑完"** | 关掉 app/合上笔记本不影响后台 turn **[已验证:文档 https://docs.x.ai/grok-bot + /computer-and-apps + cursor.com/help/grok-bot/plans]** |

**这条路线里，"调度"被拆成了四件事，没有一件是 RR：**

1. **槽位 = Agent 数**：并发不是"队列里排多少任务"，而是"你有几个 agent"。Grok Bot 说得最直白：一屏一任务、多屏并行。
2. **互斥在沙箱层**：一个 Bot 一个屏、一个 Muse 一台 VM——串行不是调度器的排队原因，而是**架构不变量**（一把锁）。
3. **准入 = 用量额度**：超额拒下一次启动，**不抢正在跑的**（Grok Bot 明确"限额不是中途硬停"）。排队被隐藏到容量供给层。
4. **人也是调度的一环**：审批/接管（CAPTCHA、2FA、付款）时任务挂起、不占算力。

**对我们的含义（重要）**：

- 我们的系统是**共享 fleet + 任务队列**（全局 30 / 租户 10 / 轮转）；他们是**每人专属电脑 + 额度**。**RR 在他们的架构里没有位置**，因为不存在"多个租户抢同一批任务槽"这件事。比"谁家 RR 更好"没有意义——**先确认我们卖的是哪种模型**。
- 可迁移的两条：
  - **把"会话串行"提升为架构不变量**：per-session 队列 + 一把锁，而不是在租户大队列里扫队首判断（这正是 P0-1/P0-3 的根因）。
  - **超额只拒新、不杀旧**：他们的额度语义与我们的"无界队列 + 5min TTL 熔断"正好相反。P1-7 的"有界队列 + 背压"和 P1-5 的 TTL 修正，实质就是把语义扳回这一侧。
- 他们真正在调度的其实是**供给层**（VM 池/快照/预热/按账号分配），而这正是我们已经做好的部分（热恢复 101ms），不是我们的短板。**[推测]**

---

## 3. 我们的现状（代码事实）

```
submit ──► assertQueueCapacity（backpressure，默认关闭）
        └► TenantRunScheduler.enqueue        // 租户内按 (priority desc, enqueuedAt asc) 排序
pump(1s) / kick() ──► attemptNext
        ├─ claimNext(): 全局 slot → claimPriority() → claimAged() → RR 环轮转
        ├─ admission.evaluate()
        ├─ QUEUE → requeueClaimed()（release + 重入队，enqueuedAt 保留）
        └─ START → await executeQueuedRun()   // 一直等到 Run 结束，finally release()
```

代码位置：`src/scheduling/tenant-run-scheduler.ts:172`（claimNext）、`:254`（claimPriority）、`:325`（claimAged）、`:395`（canClaim）、`:500`（listQueue）、`:563`（listQueueBlockers）；`src/scheduling/run-scheduler.ts:573`（attemptNext）、`:660`（drainOnce）、`:281`（enforceQueueTtl）、`:238`（kick）、`:253`（tick）。

**RR 语义**：`tenantOrder` 是租户环；每成功 claim 一个租户就 push 回环尾；租户队列空则移出环。租户内 FIFO（当前排序键是 `priority desc, enqueuedAt asc`；等权定位下应退化为纯 `enqueuedAt`，见 P0-2）。老化只对"超过 `agingMs` 的队首"生效。**[已验证:代码]**

**RR 本身写对了**：`assertion3-rr-share-drift.test.ts` 证明三方对称补充时严格 `A1 B1 C1 A2 B2 C2 …`，无漂移；某一方队列耗尽时它多拿份额，那是 work-conserving 的正确行为。**[已验证:可运行测试]**

---

## 4. 问题清单（按严重度）

> **前提修正**：用户确认本项目**所有租户等权、无优先级**。这把结论重心从"RR 够不够公平"移开了——等权下 RR 就是合理的等权排序器，**不需要换成 WFQ/DRR**；要修的是 RR 之外的实现缺陷、一个越界功能（显式优先级）、和一个静态配额（per-tenant cap）。下面按此前提重排。

### P0-1 队首阻塞（HOL）：队首被会话串行挡住，同租户后面的 Run 永远轮不到 **[已验证:可运行测试]**

`claimNext` 每轮只取 `tenantQueue[0]`；`canClaim` 失败就 `unshift` 放回、租户进环尾，**从不看第 2 个**。

复现（`assertion1`）：tenant A 有 `A1(session=S1)`、`A2(session=S2)`，另有同 S1 的 active Run；tenant B 有 `B1`。实际序列 `B1 -> null`，A2 一直留队；释放 active 后才 A1、A2。

后果：会话串行把同租户**整条队列**拖住；多租户时表现为 A 被跳过，单租户时 pump 直接空转。

### P0-2 显式优先级：越界功能，且整条压过老化 → **建议整条删除** **[已验证:可运行测试]**

等权定位下，这条链路不该存在，但它已经贯穿全栈：HTTP body 收 `priority`（`src/http/routes/runs.ts:129`）→ 落库 `agent_runs.priority`（`src/storage/migrations.ts:52`）→ 恢复时 `ORDER BY priority DESC`（`src/runs/runstore.ts:287`）→ 调度器 `claimPriority()` 先于 `claimAged()`（`src/scheduling/tenant-run-scheduler.ts:180`）。

两个后果：

1. **等权系统里唯一的不等权来源，是客户端自己填的数字**——任何租户都能靠填大数饿死别人（无上限、无鉴权）。业界（Jules/K8s）的优先级都是**服务端按档位/策略**给的，从不交给调用方。
2. **它把老化整条压死**：复现（`assertion2`）——A 已等 600s（`agingMs=60s`），B 每轮补一个 `priority=1`，12 轮全是 `B1…B12`，A 仍在队列。老化形同虚设。

**建议整条删掉，而不是"改造成服务端档位"**：等权定位下没有档位需求，删掉后 `claimPriority()`（约 70 行）、`compareQueuedRuns` 的优先级分支、5 处 `priority: run.priority ?? 0` 转手、HTTP 字段、`ORDER BY` 全部消失，P0-2 这类 bug 从根上不成立。做法：DB 列保留（`DEFAULT 0`）避免迁移风险但代码不再读取，migration 注释标 deprecated；API 不再接受该字段；删 `tests/scheduling/tenant-run-scheduler-priority.test.ts` 与 HTTP 的 2 条 priority 用例。

> 注意：`docs/platform-boundary.md:290-300` 已把 "队列优先级" 记成 §9.8 v1.4 Phase 2 的**已完成能力**（含 migration v3 与真机证据）。删除它是一次**范围收缩**，需要同步改 `platform-boundary.md`、`README.md:117`、`.env.example` 的说明，并在提交信息里写清理由。

### P0-3 老化只看队首 **[已验证:可运行测试]**

`claimAged` 同样只扫 `tenantQueue[0]`。复现（`assertion4`）：A1 被会话挡住、A2 已等 780s 且可调度，8 轮全给 B；只有 A1 被移除后 A2 才被 claim。即"老化补偿"本身也会被 HOL 挡死。

### P1-4 派发与完成耦合：slot 回收被"批内最慢的 Run"拖住 **[已验证:代码]**

`drainOnce` 一次 `Promise.allSettled(remainingAttempts × attemptNext())`，而 `attemptNext` 里 `await executeQueuedRun(...)` 要**等整条 Run 跑完**才 `release()`。批次 [5s, 10s, 20min] 时，前两个 slot 在 5s/10s 就空了，但要等 20min 批次结束、`drainRequested` 触发下一轮 `drainOnce` 才补位——除非期间有 `submit` 调 `kick()`。

同源问题：`tick()` 会 await 整批 Run，`stopAndDrain()` 因此可能阻塞到最长 Run 的时长；`inFlight` 被重叠的 `tick()` 覆盖，语义不再可靠。**[已验证:代码]**

修复：派发与完成解耦——`attemptNext` 只 claim + 启动（返回 handle），Run 结束的 `finally` 里直接 `kick()`；pump 只做定时兜底。slot 回收延迟从 O(批内最长 Run) 降到 O(ms)。

### P1-5 Queue TTL 把「会话串行等待」误判成饥饿 **[已验证:代码]**

`enforceQueueTtl` 只按 `enqueuedAt` 判定，**不看等待原因**。而默认 `queueTtlMs=300s` < `executionTimeoutMs=30min`：同一会话的追问排在前一条后面，前一条只要跑超 5 分钟，追问就会被 `FAILED(QUEUE_TIMEOUT)` 杀掉。**合法等待被误杀**，用户侧表现为"任务莫名其妙失败"。

修复（建议 ①② 一起）：① TTL 只对资源类阻塞（`GLOBAL_CONCURRENCY_LIMIT`/`TENANT_CONCURRENCY_LIMIT`/`RESOURCE_*`）计时，`SESSION_SERIALIZATION` 不计入；② 加配置校验 `queueTtlMs ≥ executionTimeoutMs` 或按 reason 分级。

### P1-6 静态 per-tenant cap 同时伤利用率与份额（等权下的核心问题） **[已验证:可运行测试]**

等权下"份额"本来就该是 `C/N`，但 `maxActiveRunsPerTenant=10` 是写死的，于是两头都不对：

- **租户少时浪费容量**：只有 2 个活跃租户时，各自最多 10 → **最多只能跑到 20/30（67%）**，剩下 10 个 slot 在明确有人排队的情况下空转；只有 1 个租户时只能跑到 10/30。**这是纯吞吐损失。**（`assertion5` 实测：2 租户 claim 到 20 就返回 null，队列还剩 20 条；1 租户 claim 到 10。）
- **租户多时份额超发**：4 个以上租户同时 backlog 时，任一租户仍能拿 10/30 = 33%，而公平份额只有 25% 不到。

一处改动同时解决两件事：`cap_t = max(1, floor(C / N_active))`，`N_active` = 当前有排队或在跑的租户数；租户进出时重算，空闲份额自动借用（work-conserving）。

**等权下不需要权重、不需要 DRR/WFQ**——RR 环本身就是等权公平排序，只要让 cap 动态化即可。DRR 只有在将来确实要引入"租户权重/档位"时才值得上。

### P1-7 队列无界 + TTL 熔断 = "先收下再失败" **[已验证:代码]**

`maxQueuedRuns` 默认 0 被翻译成 `undefined`（`create-harness-application.ts:440`），即**不启用**排队深度上限；超额时 `QueueBackpressureError` 的 `retryAfterSeconds` 还写死 5。结果是：系统先痛快地 202 接下无限多任务，5 分钟后再把它们批量判死。业界取向相反——E2B 直接 `429 + Retry-After`、Jules 硬拒绝、Daytona fail-fast；Modal 用 buffer 换延迟。

修复：默认开启有界队列（全局 + 租户），`retryAfterSeconds` 由「当前队列深度 ÷ 近期完成速率」估算；`202` 响应带回**排队位置与 ETA**（我们已有 `listQueueBlockers()` 的数据基础）。

### P1-8 RUNNING 槽位缺"心跳续租" **[已验证:代码]**

`leaseManager.reapExpired()` 每个 tick 调一次，能兜住"执行器崩了"的孤儿；但正常运行的 Run 没有**续租心跳**，租约语义只覆盖"过期回收"，没有覆盖"我还活着"。业界（E2B `setTimeout` 每次重置、Devin `claim_deadline`）都是**执行期间持续续租**。否则一个卡住不吐事件的长 Run 会被误回收，或者反过来租约设得很宽导致僵尸占槽。

修复：`RunLease` 加 `deadline` + 每次 step/事件时续租；新增 `LEASE_EXPIRED` 原因码；**回收判定必须豁免「有排队或正在跑」的会话**（OpenAI 预热环境文档同样规定 pending work / active turn 阻止 idle 过期）。

### P2-9 调度状态全在进程内，无法多实例 **[已验证:代码]**

`queuesByTenant` / `tenantOrder` / `activeTenantByRunId` 都是 `Map`。多进程部署时每个进程独立准入，`maxActiveRuns=30` 变 30×N，且同一 Session 可能被两个进程同时放行。现有 `leaseManager` + `reconcileQueuedRuns` 能兜"崩溃后的孤儿"，兜不住"同时放行"。

修复：抄 Devin Outposts——DB 原子 claim（SQLite：`BEGIN IMMEDIATE` + `UPDATE ... WHERE status='QUEUED' AND id=? RETURNING`，或先 `SELECT LIMIT 1` 再 CAS），加 `claim_deadline`；内存调度器退化为"本地缓存 + 排序建议"。

### P2-10 准入在 claim 之后，产生 claim→requeue 抖动 **[已验证:代码]**

`attemptNext` 先 `claimNext()`（占 slot）再 `admission.evaluate()`，QUEUE 就 `release()` + 重新 `enqueue()`，并触发一次 `synchronizeQueueBlockers()`（写事件）。租户多时是纯写放大。修复：先评估后 claim，或同批候选复用一次准入快照。

---

## 5. 改造路线（按投入产出排序）

| 优先级 | 改动 | 做法 | 收益 | 成本/风险 |
|---|---|---|---|---|
| **P0** | 修 HOL | `claimNext`/`claimPriority`/`claimAged` 统一为"租户内从队首向后找第一个 `canClaim` 的 Run" | 消除已复现的 2 类饥饿，不改对外语义 | 低。补测：同租户多 session、队首被并发上限挡住 |
| **P0** | **删除显式优先级** | 删 `claimPriority()`、`priority` 字段/HTTP body/`ORDER BY priority`、5 处转手；`compareQueuedRuns` 只按 `enqueuedAt`；DB 列留作 deprecated | 等权语义回归一致；饿死/滥用面从根上消失；少 ~90 行 | 低。删 1 个测试文件 + 2 条 HTTP 用例；同步改边界文档 |
| **P0** | TTL 语义 | `SESSION_SERIALIZATION` 不计入 TTL；或按 reason 分级；配置校验 TTL ≥ 执行超时 | 消除"追问被误杀" | 低。改 `queue-ttl.test.ts` |
| **P1** | 派发/完成解耦 | `attemptNext` 返回 dispatch 结果不 await Run；Run 结束 `kick()`；`drainOnce` 去掉批屏障 | slot 回收近实时；`stopAndDrain` 不再被 Run 时长支配 | 中。动主循环，回归 `run-scheduler.test.ts`（1540 行） |
| **P1** | 动态公平 cap | `cap_t = max(1, floor(C / N_active))`，租户进出重算，空闲份额可借用；RR 环保留 | 2 租户时利用率 67%→100%；多租户份额不过发 | 低-中。需对称/非对称负载实验 |
| **P1** | 有界队列 + 真 ETA | 默认开启 `maxQueuedRuns`；`retryAfterSeconds` 按吞吐估算；202 返回排队位置/ETA | 与 E2B/Jules 对齐；用户拿到可行动的反馈 | 低-中。改配置默认值 + HTTP 响应 |
| **P1** | RUNNING 租约心跳 | `deadline` + 续租 + `LEASE_EXPIRED`；只按租约到期释放 | 消灭僵尸占槽，防止长 Run 被误收 | 中。状态机 + 迁移 |
| **P2（暂不做）** | 租户档位/权重 | Tenant 加 `weight`/`concurrency`/`dailyBudget` | 只有出现"多团队不同配额"需求时才需要 | 与"等权"定位冲突，先不做 |
| **P2** | DB 原子 claim | `QUEUED → CLAIMED(owner, deadline)` + 续期 + 过期回收 | 支持多实例横向扩展 | 高。状态机/恢复/迁移 |
| **P2** | 调度可观测 | 每租户 `queue_wait_ms` p50/p95、`slot_utilization`、`idle_slot_ms`、`starvation_events`、`claim_to_start_ms` | 能证明改了什么有效；比业界更进一步 | 低-中。`policy-decision-store` 与 `listQueueBlockers` 已有底子 |

### 明确不建议做（沿用本项目的"过度设计"清单）

- **LLM/Agent 当调度器**：ADR 0003 已限定为 shadow mode；调度器与被调 workload 共享后端时，过载会先杀死调度器自己。
- **时间片抢占在跑的 Run**：外部副作用 + checkpoint 恢复成本高；用 `executionTimeoutMs` + 挂起/快照替代（业界同样不做）。
- **恢复 VRAM/GPU 感知调度**：M4 已删除；模型服务在平台外，拿不到可信事实。
- **跨节点放置 / 按租户预热池**：单机 192 vCPU / 251GB，热恢复 101ms，瓶颈不在这里。
- **给排队算精确 ETA 的预测模型**：先用"队列深度 ÷ 近期完成速率"，等有真实时长分布再谈。
- **租户优先级/档位/权重**：本项目定位是所有租户等权；引入任何"谁能插队"的机制都要先推翻这个定位。

---

## 6. 怎么验证改进有效（实验设计）

1. **HOL 回归**：`assertion1`/`assertion4` 直接转成产线测试——断言"队首被挡时同租户后面的 Run 能被 claim"。
2. **饥饿有界性（性质测试）**：任意提交序列下，任意 Run 等待时间 ≤ `agingMs + 一个 Run 时长`（当前会被 P0-1/P0-3 的队首阻塞打破）。
3. **份额收敛**：10 租户持续 backlog、`maxActiveRuns=30`，跑 1000 次 claim/release，统计各租户占用次数，期望偏离 1/10 ≤ 5%。
4. **slot 利用率**：混合时长负载（10min × 1 + 30s × 20），统计 `idle_slot_ms / (slot_count × wall_clock)`；批屏障修复后应显著下降。
5. **TTL 误杀**：构造"长会话 + 追问"，断言追问在 `executionTimeoutMs` 内不被 `QUEUE_TIMEOUT` 杀掉。
6. **端到端**：`scripts/` 现有并发/压测脚本 + `docs/production-full-flow-report.zh-CN.md` 的 36 项断言口径复跑。

---

## 7. 附：复现与来源

```bash
# 4 条断言复现（Bun 1.3.13 对隐藏目录要加 ./ 前缀）
bun test ./.tmp-ops/sched-verify/assertion1-head-of-line-blocking.test.ts \
         ./.tmp-ops/sched-verify/assertion2-priority-over-aging.test.ts \
         ./.tmp-ops/sched-verify/assertion3-rr-share-drift.test.ts \
         ./.tmp-ops/sched-verify/assertion4-aging-head-only.test.ts \
         ./.tmp-ops/sched-verify/assertion5-static-cap-utilization.test.ts

# 现有调度回归基线
bun test tests/scheduling        # 66 pass / 0 fail

# 行业调研（40 处带 URL 的一手抓取件）
sed -n 1,200p .tmp-ops/sched-research/industry.md
ls .tmp-ops/sched-research/raw
```

---

## 8. 实施记录（2026-10-21，按 §9.10 v1.6 边界收敛）

用户确认本项目**所有租户等权、无优先级**，宿主层只保留「准入 / 调度 / 隔离 / 溯源」。据此已落地：

| 本文条目 | 状态 | 落点 |
|---|---|---|
| P0-2 显式优先级（越界 + 压死老化） | **已删除** | HTTP body 字段、`agent_runs.priority` 读取、`claimPriority()`、恢复 `ORDER BY priority` 全链路移除；DB 列留作 deprecated |
| P0-1 队首阻塞 | **已修** | `claimNext` 在租户队列内跳过不可 claim 的队首（session 锁 / 租户并发满），取第一个可 claim 的 Run |
| P0-3 老化只看队首 | **已修** | `claimAged` 同样跳过被锁队首；老化后该租户回到环尾 |
| P1-5 TTL 误杀会话等待 | **已修** | `enforceQueueTtl` 改用 blocker 视图，`SESSION_SERIALIZATION` 不计入 TTL |
| 第二道门禁（观测→分类→策略） | **已删除** | `run-scheduler` 在 `claimNext()` 后直接执行；准入只剩提交时配额 + 排队深度 |
| P1-6 静态 per-tenant cap | **已做** | `cap_t = max(1, floor(C / 有需求租户数))`，空闲份额可借用；`HARNESS_MAX_ACTIVE_RUNS_PER_TENANT=0` 为默认（自动），正数仍作硬上限 |
| P1-4 批屏障（slot 回收延迟） | **已做** | `drainOnce` 改为「谁先结束就先补谁」：`Promise.race` 等单个 attempt，空出 slot 立即再 claim；异常补位有预算且同一 Run 不在同轮立即重试 |
| P1-7 有界队列 + 真 ETA | 待做 | 默认开启 `maxQueuedRuns`，`retryAfter` 按吞吐估算 |
| P1-8 RUNNING 租约心跳 | 待做 | `deadline` 续租 + `LEASE_EXPIRED` |
| P2-9 进程内调度状态 | 待做 | DB 原子 claim（Devin Outposts 模式） |

回归基线：`bun test ./tests` = 643 pass / 10 skip / 0 fail；`bun run typecheck` 保持既有 10 条基线错误（均为 scripts/ 与 firecracker-serial-bridge，与本次改动无关）。新增守卫：`tests/scheduling/session-lock.test.ts`、`tests/scheduling/aging-skip-blocked-head.test.ts`、`tests/scheduling/queue-ttl.test.ts`。

### 8.1 宿主层减法（同日，按「简单但完整」目标）

| 项 | 处置 |
|---|---|
| 死表 `policy_decisions` / `resource_snapshots` | 从 schema.sql 删除（净 −87 行），旧库保留不影响 |
| `agent_runs.priority` | 新库不再创建；旧库列保留但代码不读写 |
| 未使用原因码 `INSTANCE_NOT_READY` | 删除 |
| 推进状态字段 | `drainPromise`/`drainRequested`/`inFlight`/`backgroundAttempts` → `activePass`/`rerunRequested`/`inlineDispatches`；`drain`+`runDrainLoop` → `runPass` |
| 空转 | pump 兜底 1s → 2s；DB 对账 → 5s 低频；提交/完成仍即时推进 |

不做（与"简单"冲突）：有界队列 + ETA、租约心跳改造、DB 原子 claim。
