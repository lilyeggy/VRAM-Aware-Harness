# 面试准备指南：如何读这个项目文档

> 目标：用 30 分钟 / 2 小时 / 半天三种时间预算，把项目文档变成你能讲出来的面试素材。

---

## 一、文档地图（先收藏这张表）

| 类别 | 主要文档 | 用途 | 面试引用方式 |
|---|---|---|---|
| **✅ 唯一技术主文档** | `docs/project-handbook.zh-CN.md` | 项目定位、数据对象链、四个系统难题、真机证据、A/B/C、诚实边界 | **主要从这里深挖** |
| **✅ 项目门面** | `README.md` | 一句话定位 + 分层能力表 + 关键数字 | 30 秒自我介绍从这里来 |
| **✅ 课程网站** | `docs/course/index.html` | 把系统讲给外行/HR/非技术面试官听 | 可发链接，或照着它的结构讲 |
| **✅ 完成状态** | `docs/completion-status.zh-CN.md` | 哪些做了、哪些没做、诚实边界 | 被问"项目做到什么程度"时引用 |
| 深挖版（archive，可选） | `docs/archive/complete-project-detail-course.zh-CN.md` | 主文档的超详版：逐方法/事务/失败矩阵 | 需要非常细的源码级追问时才翻 |
| 架构决策（archive） | `docs/archive/adr/0009-*.md` | 为什么做多租户 Agent 任务服务、为什么选 runsc | 被问"为什么"时引用 |
| 真机验证（archive） | `docs/archive/gpu-completion-runbook.zh-CN.md` 等 | GPU T4 + vLLM 120 并发、runsc 攻击冒烟 | 量化数字来源 |
| 实施日志（archive） | `docs/archive/implementation-log/2026-08-*.md` | 每天推进记录、关键 commit | 证明持续投入时有需要再查 |

---

## 二、三种准备路线

### 路线 A：30 分钟急救版（面试前临时抱佛脚）

目标：能讲清楚"这是什么"、"我为什么做"、"亮点在哪"。

1. **读 `README.md` 的前 30%**（5 分钟）
   - 只看：项目定位、分层能力表、roadmap 表、测试数字。
   - 背下来三句话：
     - "这是一个多租户 Agent 任务控制面。"
     - "核心解决四个问题：副作用可靠执行、资源准入背压、工具治理、可解释决策。"
     - "用 runsc 做用户态沙箱隔离，238/244 测试全绿，T4 真机 120 并发验证通过。"

2. **翻 `docs/course/index.html` 的 module-1 到 module-3**（10 分钟）
   - 只看图和标题，不用读每一行。
   - 记住"一次任务的一生"：Tenant → Workspace → Session → Run → Attempt → Sandbox → ToolExecution → Result/Diff/Artifact。

3. **看 `docs/archive/interview-demo-runbook.zh-CN.md`**（10 分钟）
   - 这是现成的面试话术，直接照搬或改编。

4. **看 `docs/completion-status.zh-CN.md` 的诚实边界部分**（5 分钟）
   - 防止面试时说大话。

### 路线 B：2 小时标准版（推荐）

目标：能应对一般技术面试官的追问。

1. **读 `README.md` 全文**（15 分钟）
   - 理解系统边界：控制面做什么、不做什么；Pi 做什么；沙箱做什么。

2. **读 `docs/archive/complete-project-detail-course.zh-CN.md` 的"一次任务的一生"和"四个系统难题"**（20 分钟）
   - 这是项目最精华的讲解稿。
   - 重点看：副作用治理、资源准入、工具治理、可解释决策。

3. **选一个你最想聊的方向深挖（三选一）**（30 分钟）
   - **方向 1 副作用治理/恢复**：看 `src/checkpoints/` 源码 + `docs/course/module-6.html`。
   - **方向 2 资源准入/背压**：看 `src/resources/` + `docs/course/module-5.html`。
   - **方向 3 沙箱隔离**：看 `docs/archive/sandbox-isolation-evaluation.zh-CN.md` + `docs/archive/sandbox-runtime-benchmark-runbook.zh-CN.md`。

4. **看 A/B/C 差异化方向**（20 分钟）
   - A：`src/eval/` + `scripts/eval-report.ts`
   - B：`src/http/harness-observe-page.ts` + 课程 `docs/course/modules/07-beyond-basics.html`
   - C：`src/llm-gateway/` + `.env.example` 中 `LLM_BACKENDS` 配置

5. **看 `docs/archive/interview-demo-runbook.zh-CN.md` 整理自己的话术**（15 分钟）
   - 用自己的话复述一遍，不要背原文。

### 路线 C：半天深挖版（目标大厂/核心岗位）

目标：面试官问到哪一层都能答，且能主动引导话题。

1. **按路线 B 走一遍**（2 小时）
2. **加读 ADR**：`docs/archive/adr/0009-*.md`（20 分钟）
   - 重点看"决策"和"替代方案"，学习如何回答"你为什么这样设计"。
3. **加读真机验证 runbook**（30 分钟）
   - `docs/archive/gpu-completion-runbook.zh-CN.md`
   - `docs/archive/sandbox-runtime-benchmark-runbook.zh-CN.md`
   - 记住具体数字：9 项攻击、1.22x、120 并发、CRITICAL→QUEUE。
4. **加读源码一个完整链路**（1 小时）
   - 推荐链路：HTTP 提交任务 → 资源准入 → 调度 → 沙箱执行 → 工具副作用记账 → recovery。
   - 对照 `docs/archive/complete-project-detail-course.zh-CN.md` 看源码。
5. **做模拟面试**：自己录 5 分钟视频讲项目，然后回看哪里卡壳。

---

## 三、按面试问题的文档索引

### 问题 1："介绍一下你的项目"（必问）
- **直接引用**：`README.md` 开头 + `docs/archive/interview-demo-runbook.zh-CN.md`
- **推荐结构**：
  1. 一句话定位（多租户 Agent 任务控制面）
  2. 解决什么问题（四个系统难题）
  3. 技术栈（Bun + TypeScript + SQLite + runsc/gVisor + vLLM）
  4. 量化结果（254 tests、真机验证）
  5. 差异化（A/B/C 三个方向）

### 问题 2："为什么用 runsc/gVisor，而不是自己写沙箱？"
- **引用**：`docs/archive/adr/0009-*.md` + `docs/archive/sandbox-isolation-evaluation.zh-CN.md`
- **回答要点**：
  - 不做自研 runtime（预算/人力/安全责任都不够）。
  - 亮点在上层三环：策略边界编译、租户资源管控、可验证证据。
  - 诚实边界：没有 KVM 就不能声称 strict VM 隔离通过。

### 问题 3："资源准入怎么做？背压怎么触发？"
- **引用**：`docs/archive/complete-project-detail-course.zh-CN.md` 资源准入部分 + `src/resources/resource-admission-service.ts`
- **回答要点**：
  - vLLM metrics → ResourceSnapshot → 分类（NORMAL/WARNING/CRITICAL）→ policy_decisions（START/QUEUE）。
  - fail-closed：观测失败默认 QUEUE，不盲跑。

### 问题 4："任务崩溃了怎么恢复？"
- **引用**：`docs/archive/complete-project-detail-course.zh-CN.md` 恢复部分 + `src/checkpoints/recovery-decision.ts`
- **回答要点**：
  - ToolEffect 三分类：READ_ONLY / IDEMPOTENT_WRITE / UNKNOWN。
  - 只有 PREPARED + READ_ONLY 才能自动重放。
  - Checkpoint 是稳定引用，不是内存 dump。

### 问题 5："多租户怎么隔离？"
- **引用**：`docs/archive/multi-tenant-agent-management-research.zh-CN.md` + `src/auth/` + `src/scheduling/tenant-run-scheduler.ts`
- **回答要点**：
  - API Key → principal → tenant 作用域。
  - 运行隔离：workspace 独立、沙箱独立、预算独立。
  - 调度公平性：`maxActiveRunsPerTenant`。

### 问题 6："这个项目有什么亮点/差异化？"
- **引用**：`docs/course/modules/07-beyond-basics.html`
- **回答要点**：
  - A：执行质量评测闭环（行业标配 + 护城河指标）。
  - B：观测驾驶舱（图表化、多租户）。
  - C：LLM 网关（主备回退 + 熔断 + 决策记录）。

### 问题 7："做到什么程度了？生产能用吗？"
- **引用**：`docs/completion-status.zh-CN.md`
- **回答要点**：
  - P0.5 已完成并通过真机验证。
  - 这是面试/学习项目，不是生产级：单进程、单数据库、没有多机高可用。
  - 诚实地讲清楚边界，反而加分。

---

## 四、面试话术模板

### Elevator Pitch（30 秒）
> 我做了一个多租户 Agent 任务控制面。Agent 负责"动脑"，我的系统负责"安排与安保"：多租户身份、GPU 资源准入与背压、runsc 沙箱隔离、工具副作用记账与崩溃恢复，以及最近的执行评测、观测驾驶舱和 LLM 路由网关。254 个测试全绿，并在 T4 GPU 上做了 120 并发的真机验证。

### 3 分钟项目介绍
> 这个项目起源于一个观察：让 AI 跑真实任务时，不能只靠 Agent 自己，需要一层控制面来保证"谁能在什么资源下、安全地做什么、失败后怎么办"。我把它拆成四个问题：副作用可靠执行、资源准入背压、工具治理、可解释决策。
>
> 技术上用 Bun + TypeScript + SQLite 做控制面，用 Pi 做 Agent Runtime，用 runsc/gVisor 做沙箱，用 vLLM 做模型服务。关键设计是 fail-closed：资源看不清就排队，工具副作用不确定就人工确认，checkpoint 是稳定引用不是内存 dump。
>
> 最近三个方向是在为 agent infra 岗位加深度：A 做执行质量评测，B 做观测驾驶舱，C 做 LLM 网关主备回退与熔断。这些都是只读/代理/配置接入，没有动核心控制面。

### 10 分钟深挖（选一个点）
> 面试官如果说"展开讲讲恢复"，你就从 `ToolEffect` 三分类开始，讲到 `canAutomaticallyReplay`，再讲到 `RecoveryService.scanInterruptedRuns` 建计划，`RecoveryExecutor.submitResume` 执行。最后落到`docs/course/module-6.html` 或源码。

---

## 五、诚实边界清单（绝对不能吹）

| 不能说的话 | 正确说法 |
|---|---|
| "自研沙箱，安全级别和 Kata/Firecracker 一样" | "底层用现成 runsc/gVisor，亮点在上层控制面" |
| "生产级高并发分布式" | "单进程服务，面试/学习项目，没有多机高可用" |
| "绝对安全" | "9 项攻击冒烟在 ECS 真机上通过；没有 KVM 不声称 strict 隔离" |
| "自研 LLM 模型/协议" | "OpenAI 兼容代理，做路由和可靠性" |
| "GPU 资源准入已完全真实" | "T4 + vLLM 0.7.3 120 并发验证；ECS 当前不可用，未二次复验" |

---

## 六、面试可引用的量化数字

| 数字 | 来源文档 | 用法 |
|---|---|---|
| 254 tests pass / 0 fail | `bun test` 输出 | 证明基础功能稳定 |
| 9 项攻击冒烟 PASS | `docs/archive/sandbox-runtime-benchmark-runbook.zh-CN.md` | 证明沙箱隔离有效 |
| 120 并发 → CRITICAL → QUEUE | `docs/archive/gpu-completion-runbook.zh-CN.md` | 证明资源背压真实有效 |
| runsc 1.22x 开销 | `docs/archive/sandbox-runtime-benchmark-runbook.zh-CN.md` | 证明隔离开销可接受 |
| vLLM 0.7.3 | `docs/archive/gpu-completion-runbook.zh-CN.md` | 真实技术栈 |

---

## 七、最后建议

1. **不要试图把整本书讲完**。面试官只关心你能讲清楚 1-2 个点。
2. **优先讲"我为什么这样设计"，而不是"我实现了什么功能"**。
3. **诚实是护城河**。主动说出"这不是生产级"比被追问出来要好得多。
4. **把 `docs/archive/interview-demo-runbook.zh-CN.md` 读三遍**，它是现成的话术库。
5. **准备一个问题反问**："您团队里的 agent infra 目前最大的痛点是隔离、调度、观测还是模型路由？"——把面试官的兴趣点引导到你最强的方向。
