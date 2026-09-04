# VRAM-Aware Harness 面试深度学习实验手册

> 这不是项目摘要，也不是逐文件阅读清单。它是一份可执行的学习工作簿：通过预测、追踪、实验、复述和面试追问，建立对项目核心与细节的控制力。

## 0. 使用方式

### 学习目标

完成本手册后，你应该能做到：

- 不看文档画出一次 Run 的核心调用链、状态变化和持久化事实；
- 解释资源准入、公平调度、故障恢复、Tenant 隔离和 Sandbox 治理的设计理由；
- 面对异常、并发、崩溃和越权场景，预测系统行为并指出代码证据；
- 清楚区分当前实现、测试证明、真机证据和生产化缺口；
- 用 30 秒、5 分钟和 30 分钟三个层次介绍项目；
- 在面试官改变条件时进行推演，而不是背诵固定答案。

### 每一关固定采用 PETER 循环

| 阶段 | 动作 | 产物 |
|---|---|---|
| **P — Predict** | 不看实现，先预测系统行为 | 预测答案 |
| **E — Explore** | 沿一条纵向调用链限时读代码 | 调用链和职责表 |
| **T — Test** | 运行测试、制造失败、验证边界 | 实验记录 |
| **E — Explain** | 不看资料，用自己的话复述 | 证据卡 |
| **R — Review** | 接受递进追问，定位知识缺口 | 验收结论 |

规则：必须先写预测，才能看“源码导航”；必须先完成实验，才能整理面试话术。

### 推荐节奏

- 每次 60–90 分钟，只完成一小节；
- 每关预计 2–4 次学习；
- 卡住超过 20 分钟时记录具体问题，不进行无边界搜索；
- 每次结束只保留一张证据卡，不写大段流水账；
- 学习以当前代码和测试为事实来源，文档只用于导航；
- 不要求一次答对。预测与实际不一致，是最重要的学习材料。

### 三天面试冲刺版（每天 3–4 小时）

完整按十关逐项做到源码级掌握，通常需要 25–40 小时；但若目标是三天后能够可靠参加面试，约 10–12 小时足够建立一条深主线、两条强支线和全部模块的清晰边界。

冲刺目标不是背完每个类，而是做到：能完整讲一次任务的一生；能深入讲资源调度或故障恢复；能清晰说明隔离边界；被问到扩展模块时知道它解决什么、证据在哪里、还没有实现什么。

| 天数 | 时间分配 | 当天主线 | 当天交付物 |
|---|---|---|---|
| Day 1 | 3.5–4 h | 第 1 关任务生命周期（1.5 h）→ 第 2 关公平队列（1 h）→ 第 3 关资源准入（1 h） | 白纸主调用链、状态图、调度/准入证据卡、90 秒介绍 |
| Day 2 | 3.5–4 h | 第 4 关副作用恢复（1.5 h）→ 第 5 关 Tenant 边界（1 h）→ 第 6 关 Sandbox/策略（1 h） | 故障矩阵、隔离纵深图、恢复或隔离深讲稿 |
| Day 3 | 3–4 h | 第 7/8/9/10 关各 30–40 min 浏览定位（2 h）→ 综合实验或最小改动（1 h）→ 模拟面试（1 h） | 模块地图、诚实边界清单、30 秒/5 分钟/深讲版本 |

冲刺期间的取舍：第 1–6 关优先阅读代码与测试；第 7–10 关只追一条入口、一个测试和一个边界，不陷入实现细节。若 Day 1 未完成，不跳到 Day 2；调度、资源和恢复都建立在任务生命周期之上。

#### Day 1 的精确安排

| 时间 | 内容 | 完成标准 |
|---|---|---|
| 0:00–0:45 | 第 1 关 3.2 A：Run、RunEvent、状态机 | 能画状态图，分清 Run/Runtime/RuntimeEvent/RunEvent |
| 0:45–1:35 | 第 1 关 3.2 B–E：只追提交到执行主链 | 能画出 `POST /runs` 到 `Runtime.start` 的 15 节点链路 |
| 1:35–2:00 | 第 1 关实验 1 | 解释 202、QueuePump、Runtime 启动一次的证据 |
| 2:00–3:00 | 第 2 关 | 能解释 round-robin、slot 与 Tenant 上限 |
| 3:00–3:45 | 第 3 关 | 能解释 observer、admission、START/QUEUE、fail-closed |
| 最后 15 分钟 | 无资料复述 | 录一段 90 秒项目介绍并标记卡顿处 |

> 当前你正在 Day 1 的第一个 45 分钟块。先完成第 1 关 3.2 A，再继续 B；不要现在提前阅读调度代码。

### 下周投递版：六天源码冲刺（推荐）

如果本周每天能投入 3–4 小时，则总计约 18–24 小时，足以把**核心执行主链**学到源码级，并为全部扩展模块建立可面试的定位与边界。此模式不再要求每一步先自行预测：先由教练给出源码结论、关键代码和设计原因，再用测试、复述与追问确认掌握。

| 天数 | 源码级目标 | 必须读的核心文件/测试 | 当日面试产物 |
|---|---|---|---|
| Day 1 | Run 状态、HTTP 提交、创建、入队、启动 Runtime | `runs/`、`http/harness-http-api.ts`、`scheduling/run-queue-coordinator.ts`、HTTP 集成测试 | 一次任务的一生（5 分钟） |
| Day 2 | Tenant round-robin、slot、drain、资源准入与背压 | `scheduling/`、`resources/`、对应单测与 E2E | 调度与背压深讲（10 分钟） |
| Day 3 | Tool 执行、副作用分类、Checkpoint、恢复扫描与执行 | `tools/`、`checkpoints/`、对应单测 | 故障恢复深讲（10 分钟） |
| Day 4 | Principal、Tenant-scoped 数据、Workspace、策略与审计 | `auth/`、`workspaces/`、`audit/`、HTTP 边界测试 | Tenant 隔离深讲（8 分钟） |
| Day 5 | ToolGateway、Pi Runtime、Sandbox、结果闭环 | `runtime/`、`sandbox/`、`policies/`、结果相关模块/测试 | 隔离边界深讲（8 分钟） |
| Day 6 | Template/Instance/Capability、Eval、Dashboard、LLM Gateway；综合回顾 | 入口文件 + 每模块一个测试 | 30 秒、5 分钟、30 分钟介绍；压力模拟 |

每天的固定节奏：90 分钟沿调用链读代码并标记不变量；60 分钟读对应测试并运行；45 分钟做一项故障/边界推演；最后 20 分钟不看资料复述。若某天未完成，不压缩核心代码阅读，而是将 Day 6 的扩展模块浏览时间让出。

冲刺模式下的学习命令：

```text
继续六天源码冲刺的 Day N。请直接给我：
1. 本段源码的主结论；2. 必读函数和字段；3. 关键控制流；
4. 测试如何证明；5. 面试怎么讲；6. 三道追问题。
```

### 与 AI 协作协议

每次可以直接对 AI 说：

```text
继续学习实验手册第 X 关第 Y 步。先不要告诉我答案，按手册对我提问；
等我提交预测后，再带我查代码和做实验，最后进行面试验收。
```

AI 在学习过程中承担四种角色：

1. **教练**：一次只给必要提示，不提前总结答案；
2. **导航员**：限制阅读范围，帮助定位入口和证据；
3. **实验搭档**：协助运行测试、补充测试或注入故障；
4. **面试官**：逐层追问，并区分事实错误、表达问题和知识缺口。

---

## 1. 简历倒逼后的项目全景图

### 1.1 项目真正的学习骨架

从简历承诺倒推，本项目不应被记成十个平铺模块，而应理解为**两条纵向主系统 + 三条横向保证**：

```text
纵向主系统 A：完整 Agent Runtime 执行链
用户任务 → Run/Attempt → Runtime → Model/Tool → Sandbox → Result

纵向主系统 B：完整资源调度控制环
提交 → 公平队列 → slot → 资源观察 → 准入 → 执行/重排 → 自动再推进

横向保证 1：可靠性
事务、事件、工具账本、Checkpoint、恢复与启动对账

横向保证 2：多租户安全
Principal、Tenant 数据边界、Effective Policy、ToolGateway、runsc Sandbox

横向保证 3：证据与交付
PolicyDecision、RunEvent、Audit、Output、Workspace Diff、Artifact、Eval
```

面试时先讲两条主系统；面试官追问“一致性、安全性、可观测性”时，再切入三条横向保证。原来的十关仍保留，但只是这张骨架图的逐项展开。

### 1.2 系统全景图

```text
用户提交任务
  ↓
HTTP API
  ├─ 认证 API Key / Session
  ├─ 得到 Principal（Tenant + Scopes）
  └─ 校验 Workspace 属于当前 Tenant
  ↓
创建并持久化 Run（QUEUED）+ RUN_CREATED
  ↓
进入 Tenant 公平队列
  ↓
Scheduler 选择 Run 并预占 slot
  ↓
ResourceAdmission 观察 vLLM / GPU
  ├─ QUEUE：释放 slot，携 reasonCode 重新入队
  └─ START：创建 Attempt，进入 Agent Runtime
                ↓
         编译 Effective Policy
                ↓
         创建 runsc Sandbox
                ↓
         Pi Adapter 驱动 Agent Loop
           ├─ 调用 vLLM 推理
           └─ 工具调用经过 ToolGateway
                    ├─ 先保存 ToolExecution PREPARED
                    ├─ 在 Sandbox 执行文件 / Shell 操作
                    └─ 保存结果与 Checkpoint
                ↓
         RuntimeEvent 转成持久化 RunEvent
                ↓
         Run 完成 / 失败 / 中断
                ↓
         保存 FinalText / Workspace Diff / Artifact
                ↓
         finally 释放 slot
                ↓
用户查询任务过程和最终结果

所有关键事实写入 SQLite：
Run / Attempt / RunEvent / ResourceSnapshot / PolicyDecision
ToolExecution / Checkpoint / Output / Diff / Artifact / Audit
```

读图时只抓住四个控制点：

1. **HTTP 不能决定 Tenant**：Tenant 必须来自认证后的 Principal。
2. **Scheduler 先 claim 并预占 slot**：再由 Admission 判断 START 或 QUEUE。
3. **Pi 负责 Agent Loop，Harness 负责执行边界**：生命周期、策略、资源、工具和恢复不交给模型决定。
4. **所有关键决定都留下持久化证据**：任务、事件、资源快照、策略决策、工具账本、Checkpoint 和用户结果。

### 1.3 主系统 A：Agent Runtime 全景

这里的“完整 Agent Runtime”不是声称重新实现了 Agent Loop，而是指项目围绕 Pi 形成了一条完整、受控、可恢复的任务执行链。

```text
RunService.executeQueuedRun(runId)
  ↓
确认 Run.status == QUEUED
  ↓
执行前保存 Workspace 快照
  ↓
Run 更新为 RUNNING，同时追加 RUN_STARTED
  ↓
订阅当前 runId 的 RuntimeEvent
  ↓
ManagedAgentRuntime.start(...)
  ├─ 创建并固定 RunAttempt
  ├─ 校验 Runtime Capability
  ├─ 编译并固定 Effective Policy
  ├─ 创建当前 Attempt 的 Sandbox
  └─ 调用 PiAdapter.start(...)
        ↓
      Pi 驱动模型—工具循环
        ├─ 模型请求 → vLLM
        ├─ 文本输出 → RuntimeEvent(text_delta)
        └─ 工具请求 → PiToolGateway
                         ↓
                       ToolGateway
                         ├─ 策略检查
                         ├─ 保存 PREPARED
                         ├─ Sandbox 内执行
                         └─ 保存结果 + Checkpoint
        ↓
      Pi 发出完成 / 失败 / 中断事件
  ↓
RunService + RuntimeEventBridge
  ├─ 更新 Run 当前状态
  ├─ 保存模型与工具边界 RunEvent
  └─ 保存最终文本输出
  ↓
finally：取消事件订阅 + 保存执行后 Workspace 快照
  ↓
终态时保存 Artifact
```

学习这条链时必须分清：

| 概念 | 含义 | 生命周期 |
|---|---|---|
| Run | 用户的一次持久化逻辑任务 | 可经历中断、恢复和多次 Attempt |
| Attempt | Run 的一次实际执行 | 绑定版本、策略、Runtime 和 Sandbox |
| Runtime | Harness 调用的 Agent 执行接口/实现 | 如 Managed Runtime、Pi Adapter |
| RuntimeEvent | Runtime 执行期间的即时信号 | 经 Bridge 转为部分持久化 RunEvent |
| Sandbox | Attempt 的隔离执行环境 | 承载文件与 Shell 等真实副作用 |

### 1.4 主系统 B：资源调度全景

```text
持久化 QUEUED Run
  ↓
TenantRunScheduler.enqueue
  ├─ Tenant 内 FIFO
  ├─ Tenant 间 Round-Robin
  └─ 同一 Conversation 保持串行
  ↓
QueuePump.tick / 新任务立即触发
  ↓
RunQueueCoordinator.drain（single-flight）
  ↓
attemptNext
  ↓
claimNext
  ├─ 检查全局 slot
  ├─ 检查 Tenant slot
  ├─ 选择一个有资格的 Run
  └─ Run 离开队列并立即预占 slot
  ↓
ResourceAdmissionService.evaluate
  ├─ ResourceObserver：读取 vLLM Metrics + NVIDIA GPU
  ├─ ResourceClassifier：NORMAL / BUSY / CRITICAL / UNKNOWN
  ├─ ExecutionPolicy：START / QUEUE + reasonCode
  └─ 保存 ResourceSnapshot + PolicyDecision
  ↓
  ├─ START
  │    ├─ executeQueuedRun / executeQueuedResume
  │    └─ finally release slot
  │
  └─ QUEUE 或 Admission 异常
       ├─ release slot
       ├─ 保留原 enqueuedAt
       └─ 携 reasonCode 重新 enqueue

资源恢复或下一次 tick
  ↓
再次 drain，重新评估排队 Run
```

这条控制环的职责边界：

| 层 | 负责 | 不负责 |
|---|---|---|
| TenantRunScheduler | Tenant 内 FIFO、Tenant 间轮转、全局/租户 slot、同会话串行 | GPU 压力分类、模型 token 调度 |
| ResourceObserver | 收集 vLLM Metrics 与 NVIDIA GPU 事实 | 决定任务是否启动 |
| ResourceClassifier | 把资源事实归类 | 调度顺序和执行 Run |
| ExecutionPolicy | 根据分类与并发上下文给出 START/QUEUE | 维护内存队列 |
| ResourceAdmissionService | 串联观察、分类、策略并保存证据 | vLLM 内部 KV/cache 调度 |
| QueuePump/Coordinator | 推进队列、处理异常、释放/重排和 single-flight | 形成资源指标本身 |

### 1.5 简历四点与学习主线的映射

| 简历承诺 | 主学习系统 | 横向保证 | 原手册关卡 |
|---|---|---|---|
| 任务生命周期与结果闭环 | Agent Runtime | 证据与交付 | 第 1、7、8、9 关 |
| 公平调度与 GPU 背压 | 资源调度 | 决策证据 | 第 2、3 关 |
| 工具副作用与故障恢复 | Agent Runtime | 可靠性 | 第 4 关 |
| 身份、策略与 runsc 隔离 | Agent Runtime 入口/执行边界 | 多租户安全 | 第 5、6 关 |

### 1.6 学习模式：每次只闭合一个简历承诺

后续每次学习固定输出六项：

1. **全景定位**：当前代码在上图哪个节点；
2. **源码控制流**：入口、核心方法、状态变化和退出路径；
3. **不变量**：无论成功、异常还是重启都必须成立什么；
4. **测试证据**：哪个测试证明正常路径和失败路径；
5. **简历表达**：这段代码支撑简历中的哪句话；
6. **面试追问**：替代方案、边界和生产演进。

一段学习只有同时满足下面条件才算通过：

- 能不看代码画出控制流；
- 能指出至少三个具体方法或字段；
- 能解释一个异常路径；
- 能说出测试证明了什么、没证明什么；
- 能用 60–90 秒讲成简历上的能力，而不是逐行复述代码。

### 1.7 当前学习位置

当前正在闭合简历 Bullet 1“任务模型、生命周期与结果闭环”：

```text
已经完成：
Run/RunEvent/状态机
→ HTTP Principal/Tenant/Workspace
→ Run + RUN_CREATED 事务持久化
→ 内存入队
→ claim + slot
→ Admission START/QUEUE

下一步：
executeQueuedRun
→ Attempt / Managed Runtime / Pi Adapter
→ RuntimeEventBridge
→ Output / Workspace Diff / Artifact
```

完成这条链后，再进入主系统 B“资源调度全景”的源码级拆解；不会同时在两条主线之间来回跳。

---

## 2. 原十关详细学习地图

### 核心主干：必须掌握

| 关卡 | 核心案件 | 要建立的能力 |
|---|---|---|
| 1 | 一次任务如何从 HTTP 请求走到最终结果 | 掌握主调用链、Run 状态与持久化边界 |
| 2 | 多个 Tenant 如何公平共享有限并发 | 掌握 FIFO、round-robin、slot 与 single-flight drain |
| 3 | GPU/vLLM 压力如何真正改变执行 | 掌握观察、分类、准入、背压和自动续跑 |
| 4 | 工具调用中途崩溃后如何安全恢复 | 掌握副作用、Checkpoint、恢复决策与重放边界 |
| 5 | Tenant A 为什么读不到 Tenant B 的数据 | 掌握可信身份、服务端派生 Tenant 和数据作用域 |
| 6 | Agent 的文件与 Shell 操作如何被约束 | 掌握策略编译、ToolGateway、Sandbox 和 fail-closed |

### 完整闭环：第二阶段掌握

| 关卡 | 主题 | 定位 |
|---|---|---|
| 7 | Workspace、Diff、Artifact 与最终回答 | 用户结果闭环 |
| 8 | Pi Runtime、Harness 与 vLLM 的边界 | 依赖倒置和系统边界 |
| 9 | Template、Instance、Capability、Effective Policy | 版本化控制面 |
| 10 | Eval、Dashboard、LLM Gateway | 差异化能力及其诚实边界 |

### 三条最终面试主线

完成前六关后，从下面三条中选两条作为主攻方向，第三条达到能应答追问的程度：

1. 副作用感知的可靠执行与故障恢复；
2. GPU 资源准入、背压与多租户公平调度；
3. 身份、策略、ToolGateway 和 Sandbox 的纵深隔离。

---

### 2.1 学习记录模板

每关复制并填写一份，建议直接追加在该关末尾。

```markdown
#### 第 X 关学习记录

日期：
用时：

#### 我的初始预测

1.
2.
3.

#### 实际调用链

入口 → ... → 终点

#### 职责与契约

| 组件 | 输入 | 保证/输出 | 修改的状态 | 失败后由谁处理 |
|---|---|---|---|---|
| | | | | |

#### 预测与实际的差异

-

#### 实验记录

- 实验：
- 实验前预测：
- 实际结果：
- 代码/测试证据：
- 原因：

#### 证据卡

- 主题：
- 系统问题：
- 核心不变量：
- 强制执行点：
- 关键失败路径：
- 测试证据：
- 设计取舍：
- 当前边界：

#### 仍然不确定的问题

-

#### 面试验收

- [ ] 能在 90 秒内讲清本关
- [ ] 能不看资料画出调用链
- [ ] 能指出至少三个代码证据
- [ ] 能解释一个替代方案为什么没有采用
- [ ] 能处理至少两个条件变化题
```

---

## 3. 第一关：一次任务的一生

### 本关目标

不看资料时，能够从 `POST /runs` 开始，解释 Run 如何进入持久化队列、如何被公平调度、如何经过资源准入、如何调用 Runtime，以及最终结果如何成为可查询事实。

本关先建立“骨架”，暂时不深入公平算法、资源指标、Checkpoint 和 Sandbox 内部；这些分别在后续关卡拆解。

### 3.1 P — 第一轮预测（现在从这里开始）

在阅读下面的“源码导航”之前，先回答：

1. 收到 `POST /runs` 后，系统应该先检查资源，还是先持久化 Run？为什么？
2. HTTP 接口返回 `202` 时，Run 最可能处于什么状态？`202` 是否代表已经执行？
3. 数据库中的 `QUEUED` 和内存调度队列分别解决什么问题？只保留其中一个可不可以？
4. 调度器选出 Run 时，应该在 Runtime 启动前还是启动后占用 slot？为什么？
5. ResourceObserver 或 Admission 自身抛异常时，这个 Run 应该消失、失败、直接执行，还是重新排队？
6. Runtime 启动抛异常时，Run 和 slot 各自应该如何收敛？
7. 为什么需要同时存在 `RuntimeEvent` 和 `RunEvent`？
8. 如果同一时刻有两个地方要求推进队列，系统应该启动两个 drain 循环吗？
9. 任务完成后，最终回答、事件、Workspace Diff 和 Artifact 可能分别保存在哪里？
10. 画出你预测的调用链，不超过 15 个节点。

完成标准：每题都必须写答案；允许写“不确定，但我猜……”。

### 3.2 E — 限定源码导航

完成预测后，严格按顺序阅读。第一遍只回答“这个组件负责什么”，不要深入每个辅助方法。

#### A. 领域对象与状态机

1. `src/runs/agent-run.ts`
2. `src/runs/run-state-machine.ts`

需要找出的证据：

- Run 与一次 Runtime 调用为什么不是同一个概念；
- 所有合法状态；
- 哪些状态是终态；
- `INTERRUPTED` 为什么可以回到 `QUEUED`；
- `WAITING_TOOL` 为什么不能直接到 `COMPLETED`。

#### B. HTTP 入口

1. `src/http/harness-http-api.ts`
2. 搜索 `submitRun`，只追它直接调用的方法；
3. 暂时跳过 Dashboard、Eval 和 LLM Gateway 路由。

需要找出的证据：

- Principal 在哪里产生或被要求；
- Tenant 是否来自客户端请求体；
- Workspace 归属在哪里验证；
- 为什么返回 `202`；
- HTTP 请求是否同步等待 Runtime 完成。

#### C. 创建与入队

1. `src/scheduling/run-queue-coordinator.ts` 中的 `submit`；
2. `src/runs/run-service.ts` 中的 `createQueuedRun`；
3. `src/runs/runstore.ts` 中与 `create` 相关的方法；
4. `src/scheduling/tenant-run-scheduler.ts` 中的 `enqueue`。

需要找出的证据：

- Run 与第一个 Event 是否在同一个持久化边界中创建；
- 持久化和内存入队的先后顺序；
- 进程在两者之间崩溃会发生什么；
- 启动时由哪个机制重建内存队列。

#### D. 推进与准入

1. `src/scheduling/run-queue-pump.ts`；
2. `src/scheduling/run-queue-coordinator.ts` 中的 `drain`、`drainOnce`、`attemptNext`；
3. `src/scheduling/tenant-run-scheduler.ts` 中的 `claimNext`、`release`；
4. `src/resources/resource-admission-service.ts`。

需要找出的证据：

- `claimNext` 返回时 Run 是否已经占用 slot；
- 为什么 Admission 收到的 active count 要减一；
- `QUEUE` 后 release 与 enqueue 的顺序为什么不能互换；
- Admission 抛异常后 Run 为什么不会从内存中丢失；
- `drainPromise` 与 `drainRequested` 共同解决什么并发问题。

#### E. 执行与结果

1. `src/runs/run-service.ts` 中的 `executeQueuedRun`；
2. `src/events/runtime-event-bridge.ts`；
3. `src/runs/run-output-store.ts`；
4. `src/workspaces/run-workspace-result-store.ts`；
5. 回到 `src/http/harness-http-api.ts` 查看 Run、events、output、diff、artifacts 查询入口。

需要找出的证据：

- Run 在调用 Runtime 之前如何变为 `RUNNING`；
- Runtime 事件如何变成长期保存的业务事件；
- Runtime 抛异常时 Run 如何处理；
- 为什么 `captureAfter` 位于 `finally`；
- Artifact 为什么只在特定终态抓取。

### 3.3 第一关基准调用链

只有在自己完成调用链后再展开核对：

```text
POST /runs
  → HarnessHttpApi.submitRun
  → 身份与 Workspace 归属校验
  → HarnessApplication.submitRun
  → RunQueueCoordinator.submit
  → RunService.createQueuedRun
  → RunStore.create(Run + RUN_CREATED)
  → TenantRunScheduler.enqueue
  → QueuePump.tick / Coordinator.drain
  → TenantRunScheduler.claimNext（选择 Run + 占 slot）
  → ResourceAdmissionService.evaluate
      ├─ QUEUE：release → 重新入队
      └─ START：RunService.executeQueuedRun
          → captureBefore
          → Run 变为 RUNNING + RUN_STARTED
          → Runtime.start
          → RuntimeEventBridge 持久化过程事实
          → captureAfter / Artifact
          → release slot
```

注意：这只是骨架。每个箭头是否同步、是否事务化、失败后如何补偿，才是本关真正的学习内容。

### 3.4 T — 动手实验

#### 实验 1：先用测试观察正常生命周期

```bash
bun test tests/integration/harness-process-http.test.ts
```

回答：

- 测试中的 `POST /runs` 为什么先得到 `202`？
- 为什么之后还要显式调用 `queuePump.tick()`？
- 最后用什么证据证明 Runtime 确实只启动了一次？

#### 实验 2：验证非法状态转换

```bash
bun test tests/runs/run-state-machine.test.ts
```

先预测至少三个非法转换，再与测试对照。然后回答：状态机只是文档，还是所有状态更新的统一强制点？如果不是，风险是什么？

#### 实验 3：验证 Run 与事件的原子创建

```bash
bun test tests/runs/runstore.test.ts
```

找到证明以下不变量的测试或实现：

> 不能出现数据库中有 Run、却没有初始 `RUN_CREATED` 事件的半完成状态。

#### 实验 4：设计但暂不实现故障注入

为下面三个故障点分别写出“注入方式、预期 Run 状态、预期队列状态、预期 slot 状态”：

1. `RunStore.create` 成功后，`scheduler.enqueue` 之前进程退出；
2. `claimNext` 成功后，`admission.evaluate` 抛异常；
3. Run 变为 `RUNNING` 后，`runtime.start` 抛异常。

在教练确认设计后，再决定是复用已有测试还是补充最小测试。不要一开始就修改生产代码。

### 3.5 E — 第一关证据卡

完成实验后，用自己的话填写：

```text
主题：一次任务的一生

系统问题：

核心不变量：
1.
2.
3.

持久化事实：

内存协调状态：

最危险的三个故障窗口：
1.
2.
3.

对应恢复/补偿机制：

当前实现的局限：
```

### 3.6 R — 第一关面试验收题

#### 第一层：准确复述

1. `POST /runs` 为什么返回 202 而不是 200？
2. Run、Attempt 和 Runtime invocation 有什么区别？
3. 为什么 Run 同时存在快照状态和追加式事件？

#### 第二层：设计理由

4. 为什么先持久化 `QUEUED`，再进入内存队列？
5. 为什么调度器 claim 时就占 slot？
6. 为什么 `QUEUE` 分支必须先 release 再 enqueue？

#### 第三层：故障与并发

7. 数据库写成功但进程入队前崩溃，会不会永久丢任务？
8. 两个 HTTP 请求同时触发 drain，会不会重复执行同一个 Run？
9. Runtime 已经产生副作用但进程没来得及保存终态，该怎么办？本关只能讲边界，第四关再完整回答。

#### 第四层：演进与取舍

10. 如果从单进程 SQLite 演进到多 Worker，哪些内存机制首先失效？
11. 如何用数据库 claim、lease 或消息队列替换当前进程内协调？
12. 追加式事件已经存在，为什么当前实现仍不等于完整 Event Sourcing？

本关通过条件：

- [ ] 能在白纸上画出主调用链；
- [ ] 能解释持久化队列与内存队列的不同职责；
- [ ] 能说清 slot 的获取和释放路径；
- [ ] 能分析三个故障窗口；
- [ ] 能指出当前单进程设计迁移到多 Worker 时的断点。

---

## 4. 第二关：公平调度与并发控制

### 4.1 本关目标与边界

能够手工推演任意一组 Run 的调度顺序，解释 Tenant 内 FIFO、Tenant 间 round-robin、全局/租户 slot、同 Session 串行和 single-flight drain 如何协作。本关研究进程内调度正确性，不把它误称为分布式公平调度。

### 4.2 P — 预测题

1. 全局 FIFO 在 Tenant A 先提交 100 个任务、Tenant B 后提交 1 个任务时会怎样？
2. `maxActiveRuns=2`、`maxActiveRunsPerTenant=1` 时，A1、A2、B1、B2 的理想启动顺序是什么？
3. `claimNext()` 应只“选择”Run，还是同时登记 active slot？两步分开有什么竞态？
4. 队首 Tenant 已达上限时，应阻塞、丢弃，还是轮转到下一个 Tenant？
5. 同一 Session 的后续 Run 为什么不能越过前一个 active Run？不同 Session 呢？
6. `release(runId)` 被重复调用时，应该报错还是幂等？各有什么取舍？
7. 一个 Run 被资源准入拒绝并重新入队后，原始 `enqueuedAt` 是否应该保留？
8. 多个调用者同时调用 `drain()`，如何避免同一队列被多个循环重复推进？
9. round-robin 保证的是任务数公平、启动机会公平、运行时间公平，还是 GPU token 公平？
10. 画出 Scheduler 与 Coordinator 的职责边界。

### 4.3 E — 分阶段源码导航

#### A. 队列数据结构

阅读 `src/scheduling/tenant-run-scheduler.ts` 的类型、构造器、`enqueue` 和内部字段。

找出：

- 为什么同时需要 `queuesByTenant`、`tenantOrder` 和 `activeTenantByRunId`；
- 重复 Run 如何被识别；
- 一个 Tenant 第一次入队和后续入队有何差异；
- 队列中保存了哪些解释性信息。

#### B. claim 与 release

继续阅读 `claimNext`、`release`、`getCapacity`、`listQueue`。

找出：

- 全局上限和 Tenant 上限的检查顺序；
- 达到 Tenant 上限后 Tenant 如何回到轮转队尾；
- 同 Session active 检查如何避免消息乱序；
- 返回 Run 前在哪里登记 slot；
- `listQueue` 的 position 和 reason 如何形成。

#### C. 调度与执行的连接层

阅读 `src/scheduling/run-queue-coordinator.ts` 的 `attemptNext`、`drainOnce`、`runDrainLoop`、`drain`。

找出：

- Scheduler 为什么不直接调用 Runtime；
- 一轮 drain 最多检查多少个候选；
- `Promise.allSettled` 为什么用于故障隔离；
- `drainPromise` 与 `drainRequested` 分别解决什么；
- 所有 slot 释放路径是否都进入 `finally`。

#### D. 周期推进与启动恢复

阅读：

- `src/scheduling/run-queue-pump.ts`
- `src/scheduling/queued-run-recovery-service.ts`
- `src/app/harness-application.ts`

找出：定时 tick、立即 tick、资源状态变化和进程重启分别如何让队列再次被检查。

### 4.4 基准心智模型

```text
submit
  → 持久化 QUEUED
  → tenantQueue.enqueue

drain（single-flight）
  → claimNext
      → 检查 global slot
      → round-robin 找可运行 Tenant
      → 检查 tenant slot / session ordering
      → 移出等待队列并占 slot
  → admission
      ├─ QUEUE / 异常：release → 保留原时间重新入队
      └─ START：execute → finally release
```

不要把公平性说成绝对承诺：当前实现主要保证“有资格 Tenant 的启动机会轮转”，不保证按 GPU 时间或 token 消耗实现加权公平。

### 4.5 T — 动手实验

#### 实验 1：调度器确定性测试

```bash
bun test tests/scheduling/tenant-run-scheduler.test.ts
```

运行前手工写出 A1、A2、A3、B1、B2 的 claim/release 序列；运行后标记差异。

#### 实验 2：Coordinator 故障和并发

```bash
bun test tests/scheduling/run-queue-coordinator.test.ts
bun test tests/scheduling/run-queue-pump.test.ts
```

定位证明以下行为的测试：Admission 异常后不丢 Run、执行失败仍释放 slot、并发 drain 复用同一循环、一个候选失败不阻塞其他候选。

#### 实验 3：自己设计一张状态表

对 `maxActiveRuns=2`、`maxActiveRunsPerTenant=1` 的 A1、A2、B1、C1，逐步记录：

| 步骤 | tenantOrder | 等待队列 | active map | 返回值 |
|---|---|---|---|---|
| 初始入队 | | | | |
| claim #1 | | | | |
| claim #2 | | | | |
| claim #3 | | | | |
| release | | | | |

#### 实验 4：最小改动挑战

先只设计一个测试：证明同 Session 的 A2 不会在 A1 active 时启动，但另一 Session 的 B1 可以启动。说明测试需要观察的最小公开行为，不直接访问私有字段。

### 4.6 E — 证据卡

填写：公平对象、核心不变量、claim 的原子边界、slot 释放保证、会话顺序保证、饥饿风险、当前公平度量、迁移多 Worker 后首先失效的机制。

### 4.7 R — 面试验收

1. 为什么不能只用一个全局 FIFO？
2. 为什么 claim 时必须占 slot？
3. 为什么 admission 请求中的 active count 会减一？
4. 一个资源持续不足的 Run 会不会影响其他 Tenant？
5. 长任务与短任务混合时 round-robin 还公平吗？
6. 如何演进到 weighted fair queue、DRR 或基于 GPU 时间的配额？
7. 多 Worker 下如何用数据库 lease 或消息队列替代进程内 active map？

通过条件：能手工推演队列；能区分公平、并发限制和资源准入；能准确说出当前公平性没有保证什么。

---

## 5. 第三关：资源观察、准入与背压

### 5.1 本关目标与边界

能够解释“外部事实 → 资源快照 → 压力分类 → 策略决策 → 持久化理由 → 队列动作”的完整闭环，并明确 Harness 只控制 Run 级启动，不接管 vLLM 的 token scheduler 和物理 KV cache。

### 5.2 P — 预测题

1. 只看空闲显存能否可靠判断新 Agent Run 可以启动？还缺哪些信号？
2. Observer 超时、指标格式变化或数据陈旧时应该 START 还是 QUEUE？
3. NORMAL、WARNING、CRITICAL 是否必然一一对应 START、QUEUE、QUEUE？
4. 为什么准入决策要持久化，而不能只返回布尔值？
5. 逻辑 slot 已有空位，GPU 压力仍是 CRITICAL 时应该怎样？
6. GPU 恢复后，由谁重新触发等待 Run 的评估？
7. 一个 Run 被 QUEUE 后，下次是否应复用旧快照？
8. Harness 的 admission 与 vLLM 内部请求排队有什么本质区别？
9. 如果外部模型没有本地 GPU 指标，应该伪造“健康”快照吗？
10. 固定阈值策略的优点和局限分别是什么？

### 5.3 E — 分阶段源码导航

#### A. 资源事实契约

阅读：

- `src/resources/resource-observer.ts`
- `src/resources/vllm-resource-observer.ts`
- `tests/resources/vllm-metrics-parser.test.ts`
- `tests/resources/vllm-resource-observer.test.ts`

找出：快照字段、数据来源、观测时间、解析失败表达、vLLM 和 GPU 信息如何汇合。

#### B. 分类与策略

阅读：

- `src/resources/resource-classifier.ts`
- `src/resources/execution-policy.ts`
- `src/resources/budget-aware-policy.ts`
- `tests/resources/resource-classifier.test.ts`
- `tests/resources/execution-policy.test.ts`

找出：压力等级、硬约束、reason code、确定性 fallback，以及 budget-aware 策略与默认策略的替换边界。

#### C. 准入事务与解释证据

阅读：

- `src/resources/resource-admission-service.ts`
- `src/resources/policy-decision-store.ts`
- `tests/resources/resource-admission-service.test.ts`
- `tests/resources/policy-decision-store.test.ts`

找出：一次 evaluate 的输入、Observer/Policy/Recorder 调用顺序、决策保存内容、失败传播方式。

#### D. 回到调度闭环

重读 `RunQueueCoordinator.attemptNext` 和 `RunQueuePump`，把 `START`、`QUEUE`、Observer 异常三条路径分别画出。

### 5.4 基准心智模型

```text
Run 已获得候选 slot
  → Observer 读取实时资源事实
  → Classifier 形成压力状态
  → ExecutionPolicy 产生 START / QUEUE + reason
  → PolicyDecisionStore 保存输入、结论和理由
  → Coordinator
      ├─ START：执行 Run
      └─ QUEUE：释放 slot，重新入队
  → 后续 tick 使用新快照重新评估
```

### 5.5 T — 动手实验

```bash
bun test tests/resources
bun test tests/integration/day7-recovery-resource.e2e.test.ts
```

分四次完成：

1. 在运行前为 NORMAL/WARNING/CRITICAL 各写一个预期决策和 reason；
2. 找到 Observer 抛错或不可用时的行为，判断是否真正 fail-closed；
3. 在 E2E 测试中定位“资源不足先排队、资源恢复后完成”的证据；
4. 从 SQLite Store 视角说明一次决策事后能回答哪些问题。

可选真机实验（仅环境具备 vLLM/GPU 时）：阅读并执行对应 runbook 或 `scripts/e2e-gpu-pressure.ts`。必须把 mock 结果和真机结果分开记录。

### 5.6 证据卡

必须包含：控制对象、观测来源、压力分类、硬安全默认值、决策证据、重评机制、指标陈旧风险、与 vLLM scheduler 的边界、当前阈值策略的演进方向。

### 5.7 R — 面试验收

1. 为什么逻辑 slot 和 GPU 指标缺一不可？
2. 为什么不直接把所有请求发给 vLLM 让它排队？
3. 观测失败为什么选择 QUEUE，它会带来什么可用性代价？
4. 固定阈值如何升级成成本预测或 SLO 策略，同时保留硬 guardrail？
5. 如何避免指标抖动造成 Run 反复 START/QUEUE？
6. 测试中的 Fake Observer 证明了什么，真机压力测试又额外证明了什么？

通过条件：能从资源事实一路讲到队列动作；不把 Run 级准入夸大成 GPU 内核调度。

---

## 6. 第四关：工具副作用与安全恢复

### 6.1 本关目标与边界

能够分析任意崩溃窗口，基于 ToolEffect、ToolExecution 状态和 Checkpoint 决定自动恢复、复用结果或停止处理；理解“数据库一致”不等于“外部世界一致”。

### 6.2 P — 预测题

1. 工具调用为什么要先记录 PREPARED，再真正执行？
2. 外部写操作已经成功，但进程没记录 COMPLETED，此时数据库看到了什么？
3. READ_ONLY、IDEMPOTENT_WRITE、UNKNOWN 分别意味着什么？
4. READ_ONLY 停在 PREPARED 是否一定可以安全重放？它依赖什么前提？
5. IDEMPOTENT_WRITE 的“幂等”由谁证明，幂等键保存在哪里？
6. UNKNOWN 操作设置“最多重试一次”能否解决安全问题？
7. Checkpoint 为什么不保存完整进程内存？
8. Runtime 重复发送同一事件时，RunEvent 如何避免重复？
9. 重启扫描和实际执行恢复为什么应该分成计划与执行两步？
10. 恢复 Run 是否可以绕过资源准入和 slot？

### 6.3 E — 分阶段源码导航

#### A. 副作用账本

阅读：

- `src/tools/tool-execution.ts`
- `src/tools/tool-execution-store.ts`
- `src/tools/tool-gateway.ts`
- `tests/tools/tool-execution.test.ts`
- `tests/tools/tool-execution-store.test.ts`
- `tests/tools/tool-gateway.test.ts`

找出：effect 分类、执行状态、稳定 ID/幂等信息、prepare/complete/fail 顺序，以及 ToolGateway 在调用外部执行器前后保存什么。

#### B. Checkpoint 契约

阅读 `src/checkpoints/checkpoint.ts`、`checkpoint-store.ts`，找出 Checkpoint 保存的稳定引用、与 Run 的归属关系和持久化时点。

#### C. 纯恢复决策

阅读：

- `src/checkpoints/recovery-decision.ts`
- `tests/checkpoints/recovery-decision.test.ts`

为每个测试先遮住 expected，再根据输入自行判定。将“事实收集”和“政策判断”分开记录。

#### D. 扫描、计划和执行

阅读：

- `src/checkpoints/recovery-service.ts`
- `src/checkpoints/recovery-executor.ts`
- `src/checkpoints/recovery-startup-coordinator.ts`
- 对应三个测试文件

找出：启动时扫描哪些 Run、如何形成 plan、谁提交 resume、为什么恢复重新进入队列、重复启动协调如何收敛。

#### E. 事件去重

阅读 `src/events/runtime-event-bridge.ts` 与 `tests/events/runtime-event-bridge.test.ts`，解释 `dedupeKey` 解决的是哪一种 at-least-once 问题，以及它没有解决哪种外部副作用问题。

### 6.4 故障窗口矩阵

先自行填写，再用测试和实现核对：

| 崩溃点 | 本地事实 | 外部事实 | 自动动作 | 理由 |
|---|---|---|---|---|
| PREPARED 前 | | | | |
| PREPARED 后、外部调用前 | | | | |
| 外部成功后、COMPLETED 前 | | | | |
| COMPLETED 后、Checkpoint 前 | | | | |
| Checkpoint 后、Run 终态前 | | | | |

### 6.5 T — 动手实验

```bash
bun test tests/tools
bun test tests/checkpoints
bun test tests/events/runtime-event-bridge.test.ts
```

必做：

1. 为三类 effect × 两个关键执行状态制作决策表；
2. 找出 UNKNOWN 停在不确定窗口时拒绝自动重放的测试；
3. 找出恢复计划不会直接调用 Runtime、而是重新经过 Coordinator 的证据；
4. 找出重复 RuntimeEvent 被去重的证据；
5. 设计一个支持外部幂等键后可安全恢复的新增测试，但先不实现。

### 6.6 证据卡

必须包含：最危险故障窗口、安全不变量、ToolExecution 账本、Checkpoint 含义、自动恢复条件、人工处理条件、事件去重边界、资源重新准入、数据库事务无法覆盖的外部世界。

### 6.7 R — 面试验收

1. 为什么 exactly-once 通常不是这里的诚实承诺？
2. PREPARED 状态解决了什么，又制造了什么不确定窗口？
3. 幂等写和去重事件有什么区别？
4. 数据库 outbox 能解决哪部分，不能解决哪部分？
5. 如果接入支付 API、Git push 和本地文件写入，三者的恢复策略为何不同？
6. 多 Worker 同时扫描恢复任务时还缺什么协调？

通过条件：能独立分析未知工具的恢复安全性，不背固定分支。

---

## 7. 第五关：可信身份与 Tenant 数据边界

### 7.1 本关目标与边界

能够沿“Credential → Principal → scope → Tenant-scoped service/store → 审计”追踪身份，解释服务端如何防止客户端自报 Tenant、IDOR、路径越权和存在性泄漏。本关不把 API Key 基线夸大成完整企业 IAM。

### 7.2 P — 预测题

1. 为什么请求体里的 `tenantId` 不是可信身份？
2. Authentication 和 Authorization 分别在哪一步发生？
3. 凭证合法但缺少 `tasks:write` 应返回 401 还是 403？
4. Tenant A 请求 Tenant B 的真实 Run ID，应返回 403 还是 404？取舍是什么？
5. Store 提供 `get(id)`，只在 HTTP 层检查 Tenant 是否足够？
6. Workspace 为什么只能提交 `workspaceId`，不能提交宿主机绝对路径？
7. 日志和审计中能否原样保存 API Key？
8. “没有 accessControl 时使用 legacy Principal”只能用于哪里？
9. API Key 被撤销后，已运行 Run 和新请求分别如何处理？
10. 如果未来增加网页登录，哪些下游组件不应该变化？

### 7.3 E — 分阶段源码导航

#### A. 身份契约

阅读：

- `src/auth/request-principal.ts`
- `src/auth/api-credential-store.ts`
- `src/storage/migrations.ts` 中 credential 相关 schema

找出：Principal 字段、scope 表达、credential 存储/校验/撤销方式，以及哪些敏感数据不会回传。

#### B. HTTP 强制点

在 `src/http/harness-http-api.ts` 搜索 `requirePrincipal`、`submitRun`、`getRun`、`createWorkspace`。

为每条 Run 路由记录：所需 scope、Tenant 来源、资源归属验证、未授权/越权响应。

#### C. Tenant-scoped 数据访问

阅读 `src/workspaces/workspace-service.ts`、`workspace-store.ts`、`src/runs/runstore.ts` 及应用层调用。检查约束是在 API、Service、Store 哪几层出现，是否存在只按裸 ID 查询后忘记二次校验的路径。

#### D. 审计

阅读：

- `src/audit/access-audit-store.ts`
- `tests/audit/access-audit-store.test.ts`

找出审计记录的主体、动作、目标、结果和敏感信息边界。

### 7.4 基准信任链

```text
Authorization credential
  → CredentialStore 验证/撤销状态
  → RequestPrincipal(tenantId, subject, scopes)
  → requirePrincipal(requiredScope)
  → tenant-scoped application/service/store
  → 统一 404 防止跨 Tenant 枚举
  → AccessAudit 记录安全事实
```

### 7.5 T — 动手实验

```bash
bun test tests/http/tenant-boundary.test.ts
bun test tests/http/harness-http-api.test.ts
bun test tests/audit/access-audit-store.test.ts
bun test tests/workspaces/workspace-service.test.ts
```

建立结果矩阵：

| 场景 | 预期状态码 | 是否进入业务层 | 是否泄漏资源存在性 | 是否审计 |
|---|---:|---:|---:|---:|
| 无凭证 | | | | |
| 无效凭证 | | | | |
| 缺 scope | | | | |
| A 访问 B | | | | |
| 合法同租户 | | | | |

然后设计两个攻击用例：伪造 body.tenantId；提交任意 workspacePath。先指出预期被哪一层拒绝，再看现有测试是否覆盖。

### 7.6 证据卡

包含：信任根、Tenant 派生点、scope 强制点、跨租户查询边界、404 策略、Workspace 路径治理、审计内容、API Key 基线的局限和未来 SessionAuthenticator 接入点。

### 7.7 R — 面试验收

1. 为什么前端隐藏 tenantId 不构成安全措施？
2. 为什么仅在 Controller 校验一次仍然容易出错？
3. 403 与 404 在 IDOR 防护中的取舍是什么？
4. API Key 模式目前缺少哪些浏览器安全和账号生命周期能力？
5. 如何支持管理员跨 Tenant 观测而不破坏普通租户边界？
6. 如何防止审计系统自己成为敏感信息泄漏源？

通过条件：能从一条请求追到 Store，并能主动发现“裸 ID 查询”风险。

---

## 8. 第六关：策略、工具与 Sandbox 纵深隔离

### 8.1 本关目标与边界

能够追踪策略如何被编译成执行约束，并在 Runtime、ToolGateway 和 Sandbox 多层强制；能区分应用级权限、容器隔离、runsc 用户态内核和 VM 级隔离的保证范围。

### 8.2 P — 预测题

1. 多层策略合并时，“允许”应该取并集还是交集？为什么？
2. ToolGateway 已拒绝危险工具后，为什么仍需要 Sandbox？
3. Sandbox 已禁止网络后，为什么还需要应用层 ToolPolicyGuard？
4. 执行环境不支持要求的硬隔离时，能否自动降级到本地进程？
5. Workspace bind mount 应该只读还是可写？由什么业务需求决定？
6. 容器内 root 和宿主机 root 是否等价？为什么仍应使用非 root？
7. `cap drop`、只读 RootFS、PID/CPU/内存限制分别防什么？
8. 创建了容器是否等于 Pi 的所有文件/Shell 工具都通过容器执行？
9. 如何证明“期望策略”和“实际 Sandbox spec”一致？
10. 没有 KVM 时为什么不能声称达到 Firecracker/Kata 的隔离级别？

### 8.3 E — 分阶段源码导航

#### A. 策略模型与编译

阅读：

- `src/policies/effective-policy.ts`
- `src/policies/policy-compilation.ts`
- `src/policies/policy-registry.ts`
- `tests/policies/effective-policy.test.ts`
- `tests/policies/policy-compilation.test.ts`

找出：策略来源、交集规则、deny 优先级、硬要求与可选能力、版本/指纹证据。

#### B. 工具强制点

阅读：

- `src/policies/tool-policy-guard.ts`
- `src/runtime/pi-tool-gateway.ts`
- `src/tools/tool-gateway.ts`
- 对应测试

画出 Pi 工具请求到实际执行器的路径，标记策略拒绝、副作用记账、超时和 Sandbox 命令边界。

#### C. Sandbox 抽象与路由

阅读：

- `src/sandbox/sandbox-profile.ts`
- `src/sandbox/sandbox-provider.ts`
- `src/sandbox/sandbox-provider-router.ts`
- `src/sandbox/managed-local-sandbox.ts`

找出 capability 声明、Provider 选择、local fallback 条件以及硬能力不足时的行为。

#### D. 容器实现

阅读：

- `src/sandbox/oci-sandbox-spec.ts`
- `src/sandbox/container-runtime-adapter.ts`
- `src/sandbox/container-sandbox-provider.ts`
- `src/sandbox/sandbox-store.ts`

从代码找出 user、rootfs、capabilities、network、mount、PID、CPU、memory 和 runtime profile 的实际配置。

#### E. 启动收敛与证据

阅读：

- `src/sandbox/sandbox-startup-reconciler.ts`
- `src/evidence/isolation-evidence.ts`
- `src/evidence/isolation-triple.ts`
- `tests/sandbox/sandbox-startup-reconciler.test.ts`
- `tests/evidence/`

解释 desired policy、runtime inspect 与行为测试三类证据为什么不能互相替代。

### 8.4 纵深隔离模型

```text
Effective Policy（允许做什么）
  → ToolPolicyGuard（请求级拒绝）
  → PiToolGateway / ToolGateway（统一执行与副作用治理）
  → Sandbox Provider（选择满足能力的环境）
  → OCI spec / runtime（OS 级强制）
  → Evidence（策略、spec、inspect、攻击测试）
```

### 8.5 T — 动手实验

```bash
bun test tests/policies
bun test tests/runtime/pi-tool-gateway.test.ts
bun test tests/sandbox
bun test tests/evidence
```

必做：

1. 构造上层允许、下层拒绝的策略交集，预测结果；
2. 找到硬隔离能力不满足时 fail-closed 的测试；
3. 从 OCI spec 测试逐项核对非 root、只读 rootfs、cap drop、网络和资源限制；
4. 找到 Sandbox 重启后的 reconcile 行为；
5. 为“工具策略允许，但 Sandbox 执行失败”写出状态与审计预期。

可选环境实验：

```bash
bun run smoke:container
bun run smoke:container:attacks
```

只有 Docker/runtime 环境具备时执行；结果必须记录 runtime 类型，不能把 runc 测试写成 runsc 证据。

### 8.6 证据卡

包含：策略来源、交集不变量、应用层与 OS 层分工、Provider 选择、fail-closed、OCI 限制、证据三角、攻击模型和未证明的隔离边界。

### 8.7 R — 面试验收

1. 为什么应用级 allowlist 不能代替 Sandbox？
2. 为什么容器不等于绝对安全？runsc 额外提供什么？
3. 策略与真实 runtime 配置发生漂移时如何发现？
4. 如何安全注入 Secret 且避免进入镜像、日志和 Diff？
5. 如果新增网络代理白名单，应该落在哪些层？
6. 当前攻击测试证明了什么，没有证明什么？

通过条件：能对一条工具请求做纵向威胁分析，并保持诚实边界。

---

## 9. 第七关：Workspace、Diff、Artifact 与用户结果闭环

### 9.1 本关目标与边界

能够解释“Run 到达终态”和“用户拿到可用结果”不是一回事；掌握受管 Workspace、执行前后快照、Diff、输出块和 Artifact 的生成、归属及查询路径。

### 9.2 P — 预测题

1. 为什么不能让客户端直接指定任意宿主机路径？
2. Workspace 应属于 Tenant、Session、Run 还是 Attempt？
3. 为什么执行前要抓 before snapshot，执行后要在 `finally` 抓 after？
4. FAILED/INTERRUPTED Run 的文件修改是否应该保留？
5. Diff 与 Artifact 有什么区别？同一个文件能否同时出现？
6. 最终回答应只保存在 Run 表中，还是采用追加输出块？
7. 二进制文件、大文件、符号链接和路径穿越如何影响快照？
8. 用户下载 Artifact 时还需要重新检查 Tenant 吗？
9. captureAfter 失败是否应覆盖原本的 Runtime 错误？
10. Workspace 清理应该何时发生，如何避免破坏恢复和审计？

### 9.3 E — 分阶段源码导航

#### A. Workspace 归属与路径

阅读 `src/workspaces/workspace-service.ts`、`workspace-store.ts` 和对应测试。找出 Tenant root、服务端路径派生、名称/ID 校验、跨 Tenant 查询行为。

#### B. 快照与 Diff

阅读：

- `src/workspaces/workspace-snapshot.ts`
- `src/workspaces/run-workspace-result.ts`
- `src/workspaces/run-workspace-result-store.ts`
- 对应测试

找出文件枚举、hash/内容记录、added/modified/deleted 判定和持久化结构。

#### C. 输出与 Artifact

阅读：

- `src/runs/run-output-store.ts`
- `src/workspaces/run-artifact-store.ts`
- `tests/runs/run-output-store.test.ts`
- `tests/workspaces/run-workspace-result.test.ts`

区分流式过程输出、final text、Workspace Diff 和显式 Artifact。

#### D. 生命周期连接

重读 `RunService.executeQueuedRun` 中 `captureBefore`、`captureAfter`、`captureArtifacts` 的位置，再回到 HTTP API 的 output/diff/artifacts 路由验证 Tenant 边界。

### 9.4 基准结果链

```text
受管 Workspace
  → captureBefore
  → Runtime / Tool 修改文件并产生输出
  → finally captureAfter
  → 计算并保存 added/modified/deleted
  → 终态抓取 Artifact
  → Tenant-scoped API 返回 finalText、diff、artifact
```

### 9.5 T — 动手实验

```bash
bun test tests/workspaces
bun test tests/runs/run-output-store.test.ts
bun test tests/integration/harness-process-http.test.ts
```

必做：创建临时 Workspace，分别新增、修改、删除文件，先预测 Diff，再运行现有测试核对；确认 Runtime 失败后的 `finally` 是否仍保留修改证据；设计路径穿越和跨 Tenant Artifact 下载测试。

### 9.6 证据卡与面试验收

证据卡必须包含用户交付物、内部证据、快照时点、失败任务结果、路径信任边界、Artifact 生命周期和大仓库性能风险。

面试题：为什么终态不等于结果？为什么不直接 `git diff`？如何处理非 Git Workspace？大仓库如何做增量快照？恶意符号链接如何防护？Artifact 如何做配额、保留期和内容扫描？

通过条件：能追踪一个修改文件从 Sandbox 到用户下载的全过程。

---

## 10. 第八关：Agent Runtime、Harness 与 vLLM 的系统边界

### 10.1 本关目标与边界

理解依赖倒置：Pi 负责模型—工具循环，Harness 负责受控生命周期，vLLM 负责推理服务；能够解释 Fake、PiAdapter、Managed 和 Supervised Runtime 各自存在的原因。

### 10.2 P — 预测题

1. 为什么不在 Harness 中重新实现 Agent Loop？
2. `AgentRuntime` 最小接口应该包含哪些能力？
3. `start()` 返回是否代表 Run 必然 COMPLETED？
4. Runtime 的瞬时事件为什么需要 Bridge？
5. Fake Runtime 能证明哪些控制面性质，不能证明哪些 Pi 集成性质？
6. Managed Runtime 与 Supervised Runtime 分别可能增加什么职责？
7. Runtime interrupt 与 OS 进程 kill 有什么差别？
8. 模型 ID、parser、chat template 为什么不应硬编码进业务域？
9. Harness 为什么不能从 vLLM 请求成功推断 Agent 任务成功？
10. 将来增加第二 Runtime，哪些核心模块应保持不变？

### 10.3 E — 分阶段源码导航

#### A. 稳定接口与测试替身

阅读 `src/runtime/agent-runtime.ts`、`tests/fakes/fake-agent-runtime.ts`、`tests/runtime/agent-runtime.test.ts`。列出 start/resume/interrupt/subscribe 的契约和 runId 隔离要求。

#### B. Pi 适配

阅读 `src/runtime/pi-adapter.ts` 和 `src/control-plane/default-pi-control-plane.ts`。只标记协议转换、事件订阅、模型配置和工具接入，不深入第三方 SDK 内部。

#### C. 受管与监督执行

阅读：

- `src/runtime/managed-agent-runtime.ts`
- `src/runtime/supervised-agent-runtime.ts`
- `tests/runtime/supervised-agent-runtime.test.ts`

找出策略、Sandbox、Attempt 生命周期、清理和错误转换分别在哪一层发生。

#### D. 能力声明

阅读 `src/runtime/runtime-capability.ts`、`runtime-capability-store.ts` 和测试，解释启动前能力门与运行时失败的区别。

#### E. 事件边界

重读 `RuntimeEventBridge`，为 MODEL_STARTED、TOOL_REQUESTED、COMPLETED 等事件标记从 Runtime 语义到业务语义的转换。

### 10.4 基准边界图

```text
Harness：身份、策略、Run/Attempt、调度、恢复、结果
    ↓ AgentRuntime 稳定接口
Managed/Supervised Runtime：执行环境、能力门、生命周期监督
    ↓ PiAdapter
Pi：Agent loop、上下文、模型/工具交互
    ↓ OpenAI-compatible API
vLLM：模型推理、token batching、KV/cache/底层指标
```

### 10.5 T — 动手实验

```bash
bun test tests/runtime
bun test tests/events/runtime-event-bridge.test.ts
bun test tests/integration/stage1-stage2-control-plane.e2e.test.ts
```

必做：用 Fake Runtime 验证 start/resume/interrupt 和事件隔离；找出 Supervised Runtime 对异常/清理的保证；列出至少三项必须真 Pi/vLLM 集成才能证明的行为。

### 10.6 证据卡与面试验收

证据卡包含：依赖方向、四层职责、接口契约、Fake 价值、Pi 适配风险、能力门、事件翻译和第二 Runtime 扩展点。

面试题：为什么 Runtime 抽象不是过度设计？第三方 SDK 升级时风险集中在哪里？如何做契约测试？流式事件丢失怎么办？如果接云模型，资源准入哪些部分适用、哪些不适用？

通过条件：不会把 Pi、Harness、vLLM 的能力混为一谈。

---

## 11. 第九关：Template、Instance、Capability 与 Effective Policy

### 11.1 本关目标与边界

掌握“期望配置版本化 → 实例绑定 → Runtime 能力验证 → 多层策略编译 → Run 固化证据”的控制面链路，理解为什么历史 Run 不能依赖一份随时变化的全局配置。

### 11.2 P — 预测题

1. 为什么 Run 只保存 `templateId` 不够，还要固定 version？
2. Template 和 HarnessInstance 分别表达期望状态与实际状态吗？
3. 已有 Run 是否应自动继承 Template 的新版本？
4. Runtime 声明支持某能力，是否等于 Sandbox 实际具备该能力？
5. 平台、Tenant、Template、Workspace、Run 五层策略冲突时谁优先？
6. 策略交集为空时应降级还是拒绝？
7. 为什么 policy fingerprint 对事后解释重要？
8. Instance 是永久进程、逻辑执行环境还是用户会话？
9. 能力验证应该发生在创建 Run 前、排队后还是执行前？
10. 配置版本被删除后，历史 Run 如何解释？

### 11.3 E — 分阶段源码导航

#### A. Template 与版本政策

阅读：

- `src/templates/harness-template.ts`
- `src/templates/harness-template-store.ts`
- `src/templates/template-version-policy.ts`
- `tests/templates/`

找出不可变版本、默认版本、更新规则和 Store 约束。

#### B. Instance

阅读 `src/instances/harness-instance.ts`、`harness-instance-store.ts` 和测试。解释 Instance 与 TemplateVersion、Runtime、生命周期状态的关系。

#### C. Capability

阅读 `src/runtime/runtime-capability.ts`、`runtime-capability-store.ts` 和测试。区分声明能力、探测证据和硬要求匹配。

#### D. Effective Policy

阅读 `src/policies/effective-policy.ts`、`policy-compilation.ts`、`effective-policy-store.ts`。画出五层输入到最终 PolicyConstraints 的合并过程。

#### E. Composition Root 与 Run 固化

阅读 `src/app/create-harness-application.ts` 以及 `tests/integration/stage1-stage2-control-plane.e2e.test.ts`，追踪 TemplateVersion/Instance/Policy 如何进入 Run、Attempt、Runtime 和 Sandbox。

### 11.4 基准控制链

```text
Template → immutable TemplateVersion
  → HarnessInstance 绑定 Runtime/环境
  → Capability 校验硬要求
  → 编译 platform ∩ tenant ∩ template ∩ workspace ∩ run policy
  → 新 Run 固化 templateVersionId / instanceId / policy evidence
  → Attempt 按固化期望执行
```

### 11.5 T — 动手实验

```bash
bun test tests/templates
bun test tests/instances
bun test tests/runtime/runtime-capability.test.ts
bun test tests/policies
bun test tests/integration/stage1-stage2-control-plane.e2e.test.ts
```

必做：创建 v1 后再发布 v2，预测旧 Run 绑定是否变化；构造 Runtime 缺硬能力；构造两层策略冲突；从 E2E 测试找到 Policy 最终进入 Runtime/Sandbox 的证据。

### 11.6 证据卡与面试验收

证据卡包含：期望/实际状态、版本不变量、Instance 含义、能力门、五层策略、Run 固化、历史可解释性和配置垃圾回收问题。

面试题：为什么不只用一份 YAML？配置热更新如何影响排队 Run？如何做渐进发布和回滚？能力声明造假怎么办？多 Worker 下 Instance 生命周期由谁协调？

通过条件：能解释版本化不是“多一张表”，而是可靠执行证据。

---

## 12. 第十关：Eval、可观测界面与 LLM Gateway

### 12.1 本关目标与边界

能够分别说明 A 执行质量评测、B 观测驾驶舱、C 模型路由网关解决的问题、数据来源和当前完成度，不把三个方向包装成已经闭合的生产平台。

### 12.2 P — 预测题

1. Run 完成率高是否代表 Agent 执行质量高？
2. 控制面应记录哪些指标才能区分模型失败、工具失败、资源排队和用户中断？
3. Dashboard 是事实来源还是 Store 的只读投影？
4. 管理员跨 Tenant 观测与普通 Tenant 观测如何隔离？
5. LLM 主备回退在哪些错误上触发，哪些错误不应触发？
6. 熔断器需要哪些状态和时间语义？
7. 模型请求已产生副作用吗？路由重试会带来哪些重复风险？
8. 网关 routing decision 是否应该持久化到 Run 证据？
9. Gateway 能否根据 GPU 压力自动选择模型？当前实现是否真的做到了？
10. UI 显示的指标如何避免与当前 Store 状态不一致？

### 12.3 E — 分阶段源码导航

#### A. Eval

阅读：

- `src/eval/execution-metrics.ts`
- `src/eval/evaluation-aggregator.ts`
- `tests/eval/evaluation-aggregator.test.ts`
- `scripts/eval-report.ts`

找出指标输入、聚合维度、缺失数据处理和指标无法代表的质量维度。

#### B. Dashboard/API 投影

阅读 `src/http/harness-platform-dashboard.ts` 和 `harness-http-api.ts` 中 queue/resources/eval/audit 路由。记录每个 UI 数字的 Store/API 来源及 Tenant scope。

#### C. LLM Gateway

阅读：

- `src/llm-gateway/model-router.ts`
- `src/llm-gateway/llm-gateway.ts`
- `tests/llm-gateway/llm-gateway.test.ts`

找出 backend 选择、fallback、failure tracking、circuit 状态、recent decisions 和 OpenAI-compatible 转发边界。

#### D. 接入真实性检查

回到 `create-harness-application.ts`、config 和 HTTP API，回答：Pi 的真实主路径是否已经经过 Gateway？路由决策是否进入持久化业务证据？GPU 压力是否驱动路由？必须以当前代码为准。

### 12.4 三条差异化链路

```text
A Eval：业务事件/结果 → metrics → tenant/system aggregate → report
B Observe：Stores/Observer → tenant/admin API → dashboard projection
C Gateway：OpenAI request → ModelRouter → backend/fallback/circuit → response + recent decision
```

### 12.5 T — 动手实验

```bash
bun test tests/eval
bun test tests/llm-gateway
bun test tests/http/harness-http-api.test.ts
```

必做：构造“Run 完成但质量差”的反例；为一个 Dashboard 指标追到原始 Store；手工推演主后端失败、备用成功、连续失败熔断、恢复探测；列出 Gateway 当前完成和未完成各至少三项。

### 12.6 证据卡与面试验收

分别为 A/B/C 写迷你证据卡：问题、数据源、决策/聚合、可验证测试、当前边界、下一步。最后回答：三项中哪一个最贴合目标岗位，为什么？

面试题：指标会不会被刷？观测面如何避免高基数？回退是否掩盖模型质量退化？熔断状态多实例如何共享？如何把 route decision 与 Run/trace 关联？

通过条件：能用代码事实纠正文档中可能过时的完成度描述。

---

## 13. 每关统一的复习与验收节奏

每完成一关执行以下间隔复习：

- 当天：完成证据卡和 90 秒复述；
- 第 3 天：不看资料重画调用链，回答两个变化题；
- 第 7 天：与前一关组合推演一个跨模块故障；
- 第 14 天：进行 10 分钟随机压力面试。

跨关组合题示例：

- 资源准入 START 后 Sandbox 创建失败，Run、slot、Attempt、审计如何收敛？
- Runtime 工具执行成功后进程崩溃，重启恢复时资源处于 CRITICAL，会发生什么？
- Tenant API Key 在 Run 排队期间被撤销，已持久化 Run 是否继续执行？策略依据是什么？
- Template 发布新版本时，旧 Run 正在恢复，使用哪个 Policy 和 Sandbox profile？
- Artifact 已生成，但用户凭证被撤销，下载接口如何处理？

---

## 14. 最终综合实战

### 实战 A：白纸架构恢复

在 20 分钟内，不看项目画出：

- 产品对象关系；
- 一次 Run 的主链；
- 三个控制回路：调度、恢复、隔离；
- 持久化状态与内存状态的边界；
- Pi、Harness、Sandbox、vLLM 的责任边界。

### 实战 B：小型安全改动

选择一个不改变项目架构的小需求，先完成影响分析，再实现：

- 新增一个准入 reason；
- 新增一个公平调度边界；
- 新增一个恢复决策分支；
- 新增一个 Tenant 越权测试；
- 新增一条 Sandbox 拒绝审计。

实施前必须写：调用链、影响模块、预期失败测试、兼容性风险和回滚方式。

### 实战 C：三档项目介绍

- 30 秒：定位、问题、三个亮点、证据；
- 5 分钟：一次任务的一生 + 一个重点机制；
- 30 分钟：一个机制深入到不变量、失败路径、测试、取舍和演进。

### 实战 D：压力面试

必须覆盖：

- “这不就是一个队列吗？”
- “SQLite 怎么能叫多租户系统？”
- “为什么不用 Kubernetes？”
- “为什么不直接让 vLLM 调度？”
- “容器不等于安全，你证明了什么？”
- “崩溃后怎么保证外部操作不重复？”
- “你的测试证明了什么，又没有证明什么？”
- “如果明天要支持多 Worker，你先改哪里？”

---

## 15. 进度看板

| 关卡 | 预测 | 调用链 | 实验 | 证据卡 | 面试验收 | 状态 |
|---|---:|---:|---:|---:|---:|---|
| 1. 一次任务的一生 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 未开始 |
| 2. 公平调度 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 未开始 |
| 3. 资源准入 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 未开始 |
| 4. 故障恢复 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 未开始 |
| 5. Tenant 边界 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 未开始 |
| 6. 策略与 Sandbox | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 未开始 |
| 7. 结果闭环 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 未开始 |
| 8. Runtime 边界 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 未开始 |
| 9. 版本化控制面 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 未开始 |
| 10. 差异化能力 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 未开始 |

每完成一步，就更新本表；每完成一关，间隔 3 天和 7 天各做一次无资料复述。
