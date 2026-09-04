# Module 9: 证据地图、诚实边界与追问弹药库

## Teaching Arc
- **Metaphor:** 登山者的装备检查表。上山前逐项核对：绳索（测试）、冰爪（真机证据）、地图（架构）、应急预案（诚实边界）。面试如登山——每一样都要在出发前确认过，而不是被问到了现找。
- **Opening hook:** 面试的最后 10 分钟往往决定印象分："测试怎么做的？""生产能用吗？""如果流量翻 100 倍呢？"——这个模块是你的应答装备表。
- **Key insight:** 诚实是护城河：主动说出"这不是生产级"比被追问出来好得多；每个"没做"都配上"为什么"和"怎么做"。
- **Why should I care:** 前八个模块让你能讲"做了什么"，本模块让你经得起"做到什么程度"的拷问。

## 测试地图（254 tests / 0 fail 的构成）
| 层 | 代表测试 | 验证什么 |
|---|---|---|
| 单元/组件 | run-state-machine / tool-gateway / resource-classifier / tenant-run-scheduler / effective-policy | 纯逻辑与不变量 |
| 合同测试 | FakeAgentRuntime（start/resume/interrupt/unsubscribe/runId 隔离） | AgentRuntime 接口契约 |
| 应用层 | harness-application / create-harness-application | 组装与启动恢复 |
| HTTP | harness-http-api / tenant-boundary | 路由、鉴权、404 反枚举 |
| 集成/E2E | day7-fake-demo / day7-recovery-resource.e2e / stage1-stage2-control-plane.e2e / harness-process-http | 真实编排链闭环 |
| 真机 smoke | smoke:container / smoke:container:attacks / e2e-gpu-pressure / sandbox-runtime-benchmark | Docker+runsc、T4+vLLM |

测试哲学：状态机、恢复、工具幂等和策略分支主要由 Fake Runtime 确定性验证；真实 vLLM/GPU 只用于集成验证。验收入口：`bun run verify:stage0`（test + typecheck + demo:day7）。

## 真机证据数字卡（必须背）
- **254** tests pass / 0 fail
- **9** 项沙箱攻击真机 PASS（跨租户 Workspace/Secret、宿主路径、穿越、默认无网络、PID 上限、tmpfs noexec、kill→LOST）
- **120 并发 → CRITICAL → QUEUE 落库**（AutoDL T4 16G + vLLM 0.7.3，running=120 kv≈62%）
- **1.22x** runc vs runsc 冷启动开销
- **15** 个 schema migration · **8** 个 HTTP 端点 · v4 CHECK 保证 snapshot null 语义 · v15 删 subject_id
- 端到端真机：Run 事件链 COMPLETED → workspace diff → finalText

## 诚实边界清单（绝对不能吹 vs 正确说法）
| 不能说 | 正确说法 |
|---|---|
| 自研沙箱，安全级别同 Kata/Firecracker | 底层用现成 runsc/gVisor，亮点在上层控制面三环 |
| 生产级高并发分布式 | 单进程服务，学习/面试项目，无多机高可用 |
| 绝对安全 | 9 项攻击冒烟在真机通过；无 KVM 不声称 strict 隔离 |
| GPU 准入完全真实 | T4+vLLM 0.7.3 120 并发验证过；A6000 未二次复验 |
| LLM 网关生产可用 | 第一步完成；Pi 真实调用未接；决策记录未持久化 |

## 高频追问速答（Q&A 弹药库，本模块主体）

**Q1 为什么用 runsc/gVisor 而不是自己写沙箱？**
预算/人力/安全责任都不够自研 runtime；亮点在上层三环：策略边界编译、租户资源管控、可验证证据（evidence triple）。没有 KVM 就不声称 strict VM 隔离通过。

**Q2 资源准入怎么做？背压怎么触发？**
vLLM /metrics + nvidia-smi 双源并行 → ResourceSnapshot → classifyResource 四组阈值分类 → DeterministicExecutionPolicy 决策 START/QUEUE → policy_decisions+resource_snapshots 同事务落库。观测失败=QUEUE(RESOURCE_OBSERVATION_FAILED)，fail-closed。

**Q3 任务崩溃了怎么恢复？**
ToolEffect 三分类；只有 PREPARED+READ_ONLY 自动重放（IDEMPOTENT_WRITE 也 fail-closed：声明≠证据）。RecoveryService.scanInterruptedRuns 建计划（陈旧 RUNNING→INTERRUPTED）→ decideRecovery 出 AUTO_RESUME/MANUAL_REVIEW → RecoveryExecutor 经 coordinator.submitResume 重新入队——恢复也要重新过资源准入。

**Q4 多租户怎么隔离？**
身份层：API Key→digest→Principal{tenantId,scopes}，tenant 不来自请求体；运行层：独立 workspace 目录+runsc 容器（非 root、只读 rootfs、cap drop ALL、无网络）；调度层：Tenant 内 FIFO、租户间 round-robin、双并发上限；数据层：查询按 tenant 收口+404 反枚举+DB 约束兜底。

**Q5 为什么 IDEMPOTENT_WRITE 不自动重放？**
"写入被声明为幂等"不足以证明外部系统使用稳定幂等键；在持久化并校验真实幂等证据前保持 fail-closed。

**Q6 并发更新 Run 会不会互相覆盖？**
乐观锁：`UPDATE ... WHERE id=$id AND status=$previousStatus`，changes!==1 即抛错——过期快照覆盖新状态被挡。事件去重靠 UNIQUE(run_id, dedupe_key) 部分唯一索引。

**Q7 drain 会不会并发跑多个？**
single-flight：drainPromise 复用 + drainRequested 标志位补跑一轮；attemptNext 内部先 claimNext 占 slot，QUEUE 时先 release 再 re-enqueue（顺序错了 enqueue 会拒绝）。

**Q8 如果流量翻 100 倍？**
当前单进程+SQLite 是有意取舍（MVP 证明控制面语义）；演进路径：RunStore 换 Postgres、scheduler 外置（或多 Worker 抢 DB 行锁）、Sandbox Provider 池化、vLLM 多实例+网关路由已预留 RouteDecision 扩展点。诚实回答"现在不行"+给出可信路径。

**Q9 你觉得这个项目最大的技术挑战是什么？**
推荐答：不是某个算法，而是"让安全成为默认值"——fail-closed 贯穿观测失败、副作用未知、能力缺失、runtime 证据不符四条线；以及恢复路径的归属校验（checkpoint.runId/策略快照 runId 绑定），这是最容易漏的防串死角。

**Q10 反问面试官的问题**
"您团队 agent infra 目前最大的痛点是隔离、调度、观测还是模型路由？"——把话题引到自己最强的方向。

## Interactive Elements
- [ ] **Number memory cards（pattern cards 变体）** — 6 张数字卡：254 / 9 / 120并发 / 1.22x / 15 migrations / 8 endpoints，点击翻转显示出处与用法。
- [ ] **Scenario quiz（本模块主视觉，5 题）** — 全部场景题：(1) 面试官质疑"Fake 测试不算数"如何回应；(2) "生产能用吗"标准答案结构；(3) 流量×100 追问的回答框架；(4) 被指出"你这不就是 CRUD 吗"的回应；(5) 反问环节选哪个问题。
- [ ] **Callout ×2** — "诚实是护城河"；"先理解边界→自己实现→测试证明→复盘"的学习协作约定。
- [ ] **Icon rows 或 badge list** — 三条演示命令：`bun run demo:day7`（RESULT: PASS 判定）、`bun run demo:console`（Fake Runtime 同源 Task Console）、`bun run smoke:container:attacks`（Linux+runsc 真机）——并注明各自证明什么、不证明什么。

## Reference Files to Read
- `references/content-philosophy.md` → 全文
- `references/gotchas.md` → 全文
- `references/interactive-elements.md` → Scenario Quiz, Pattern/Feature Cards, Icon-Label Rows, Callout Boxes, Glossary Tooltips

## Connections
- **Previous:** 全部模块的证据在此汇总。
- **Next:** 无（终章）。结尾给一个"面试前一晚 checklist"收束全课程。
