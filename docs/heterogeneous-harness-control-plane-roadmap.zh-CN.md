# 异构 Agent Harness 控制面：MVP 后实施路线图

> **历史方案，不是当前实施入口。** 本路线图最初由 ADR 0008 暂停，当前由
> [ADR 0009](adr/0009-build-a-multi-tenant-agent-task-service.md) 取代。Template、
> Instance、Policy 和 Sandbox 抽象可作为内部实现继续使用，但不再扩张 Claude、
> 异构 ResourcePool 或大型控制面。当前唯一实施顺序见
> [多租户 Agent 任务服务路线图](multi-tenant-agent-task-service-roadmap.zh-CN.md)。

> 文档版本：v1.0
> 决策日期：2026-08-05
> 文档性质：历史异构控制面演进方案
> 上位决策：[ADR 0007](adr/0007-evolve-to-heterogeneous-harness-control-plane.md)

## 1. 目标与完成定义

后续阶段的目标不是把当前服务扩张成普通多租户后台，而是完成：

> **面向异构 Agent Harness 的资源感知、可恢复执行控制面。**

当系统能够用同一控制面管理 Pi + 本地 vLLM 与 Claude Agent SDK/Claude Code，
并对二者提供可验证的模板版本、能力声明、策略落实、Sandbox 生命周期、资源准入、
分层恢复和统一审计时，第二阶段才算完成。

最终代表性场景：

1. Tenant A 使用 Pi + 本地 Qwen/vLLM，只允许只读 Tool/Skill，受 A6000 资源池约束；
2. Tenant B 使用 Claude，使用另一组 Tool/Skill 和更严格的 Sandbox，受远程模型
   速率与费用预算约束；
3. 本地 GPU 压力只让依赖该资源池的 Pi Run 排队，不错误阻塞 Claude Run；
4. 违反有效策略的工具调用在真实执行前被拒绝，并留下策略版本和理由；
5. 进程或 Instance 故障后，两个 Runtime 根据各自能力、Workspace 和工具副作用
   进入不同但可解释的恢复路径；
6. 操作者能在一条时间线上还原模板、策略、资源、Runtime 事件、工具副作用和恢复
   决定，同时访问必要的 Runtime 原始证据。

## 2. 固定边界

### 2.1 控制面负责

- Tenant 归属和逻辑隔离；
- HarnessTemplate 版本和期望状态；
- HarnessInstance 与 Sandbox 生命周期；
- Runtime Capability 发现和执行保证计算；
- Tool、Skill、模型、文件、网络、Secret 与资源策略；
- Run/Attempt 编排、资源准入、Checkpoint 和恢复；
- 统一审计、资源观测和策略解释。

### 2.2 Runtime 负责

- Agent Loop、上下文管理和模型—工具协议；
- Runtime 原生 Session、Tool、Skill、Hook 和事件能力；
- Runtime 能力范围内的 Session resume/fork；
- Runtime 特有的行为配置和原始执行证据。

### 2.3 Sandbox 和资源后端负责

- Sandbox 落实文件、进程、网络和计算资源隔离；
- vLLM 或远程模型 Provider 执行模型推理；
- 底层容器系统和推理引擎保证自己的物理资源正确性。

控制面只编排和验证这些能力，不复制其内部实现。

## 3. 固定对象词汇

| 对象 | 规范含义 | 明确不等于 |
| --- | --- | --- |
| Tenant | 策略、资源、数据和审计归属边界 | 一个永久进程 |
| HarnessTemplate | 版本化期望配置 | 就地修改的运行实例 |
| HarnessInstance | 绑定 Runtime、Template、Sandbox、策略和资源池的受管执行环境 | Session 或 Run |
| Session | Runtime 可表达的对话与上下文关系 | 一次实际执行 |
| Run | 一次受控制的用户任务 | Runtime 内部单个模型调用 |
| Attempt | Run 的一次实际 start/resume 尝试 | 自动安全重试保证 |
| CapabilityProfile | Runtime 与部署组合真实提供的能力声明 | 营销式功能清单 |
| EffectivePolicySnapshot | 本次 Run 实际强制执行的不可变策略交集 | 仅存数据库的配置 |
| ResourcePool | 一组可观测、可配额和可准入的稀缺资源 | 只有 VRAM |

## 4. 实施原则

1. **先迁移现有 Pi 纵向切片，再接第二个 Runtime。** 新抽象必须被真实代码使用，
   不提前建设空泛框架。
2. **安全能力 fail closed。** 无法落实 Tenant 隔离、Tool 权限或 Sandbox 硬约束时
   拒绝执行，不静默降级。
3. **能力差异显式化。** 统一保证和审计，不假装 Runtime 语义相同。
4. **配置必须进入执行路径。** Template 或 Policy 只有真实改变 Runtime、Gateway
   或 Sandbox 行为后才算完成。
5. **恢复由证据决定。** Runtime resume、Workspace、Checkpoint 和工具副作用分别
   判断，不用“重试成功”代替恢复正确性。
6. **资源观测必须形成闭环。** 指标必须改变准入或预算，状态恢复必须触发自动推进。
7. **每一阶段都有故障注入和对照证据。** 不能只以类、表和 API 数量作为完成标准。

## 5. 阶段路线

### Stage 0：冻结现有 MVP 基线

目标：在深化前保留可比较的可靠基线，避免重构破坏既有能力。

任务：

- 固定当前测试、类型检查和 Day 7 Fake/HTTP 演示结果；
- 将 A6000 的直接 Pi 与经 Harness 对照实验作为独立基线执行；
- 记录当前 SQLite schema、Run 状态机、恢复事件和调度语义；
- 建立后续变更不能破坏的核心契约测试清单。

退出条件：现有 153 项测试、严格 TypeScript 检查和本地闭环继续通过；真实 A6000
数据可以稍后补充，不阻塞 Stage 1 的领域建模，但任何资源收益声明仍须等待实测。

当前本地证据、实际运行语义与核心契约测试映射记录在
[`stage0-mvp-baseline.zh-CN.md`](stage0-mvp-baseline.zh-CN.md)。

### Stage 1：控制面领域基础与 Pi 迁移

目标：引入新方向必需的最小对象，并让现有 Pi 主路径真实使用它们。

任务：

- 建立 HarnessTemplate 及不可变版本引用；
- 建立 HarnessInstance 的期望状态、实际状态和归属；
- 建立 RuntimeCapabilityProfile 及能力校验；
- 将 Session、Run 和新的 Attempt 关系明确化；
- 为现有 PiAdapter 增加能力声明和模板解析边界；
- 保证旧 API 可通过兼容入口创建默认 Template/Instance，避免一次性推翻现有调用方。

退出条件：

- 每个新 Run 可追溯到 Tenant、Template version、Instance、Session 和 Attempt；
- 修改 Template 不影响已经启动 Run 的执行证据；
- Pi 路径不绕过新对象；
- 不支持的强制能力会在执行前得到明确拒绝。

完成证据（2026-08-10）：上述对象已进入默认 Pi 应用组装和真实 Run 路径；版本固定、
能力拒绝与完整引用链均有端到端测试。Stage 1 本地完成。

### Stage 2：有效策略与 Sandbox 强制执行

目标：证明多租户配置不是 CRUD，而是可以在真实执行路径上被强制落实。

任务：

- 建立平台、Tenant、Template、Workspace 和 Run 策略的交集规则；
- 持久化 EffectivePolicySnapshot、编译结果和拒绝原因；
- 将 Pi Tool/Skill/模型配置编译到 Runtime；
- 让 ToolGateway 作为所有受管工具调用的外层强制边界；
- 引入可替换 Sandbox Provider 的最小生命周期；
- 首个 Sandbox 实现只需要证明 Workspace、文件范围、网络/进程策略和资源限制，
  不在本阶段同时支持多种容器技术；
- 建立 Secret 只在授权执行环境中按需注入、日志中不泄漏的边界。

退出条件：

- 同一 Runtime 在两个 Tenant 下产生不同且可验证的 Tool/Skill/模型权限；
- 被拒绝的调用没有发生真实副作用；
- Sandbox 退出或失联能够改变 Instance/Run 状态；
- 所有允许、拒绝和显式降级都可按策略快照解释。

完成证据（2026-08-10）：五层策略、Pi 编译、ToolGateway 前置守卫、可替换 Sandbox、
Secret 边界和 LOST 故障收敛已进入真实应用组装。`ManagedLocal` 对无法落实的
CPU/内存/磁盘硬限制采用 fail closed，不冒充容器隔离。完整本地验收为 184 项测试、
严格 TypeScript 和 Day 7 Fake 闭环通过。Stage 2 最小控制面语义完成。

### Stage 3：Claude Adapter 与异构能力验证

目标：用第二个差异足够大的 Runtime 验证抽象，而不是继续围绕 Pi 自洽。

任务：

- 实现 Claude Runtime Driver 的 start/resume/interrupt/event 映射；
- 映射 Claude 的 Session、permissions、hooks、settings 和 Sandbox 能力；
- 明确本地进程、远程模型和 Session Store 的生命周期边界；
- 用 CapabilityProfile 表达与 Pi 不同的恢复、权限和观测保证；
- 保存统一控制面事件和必要的 Claude 原始证据；
- 建立同任务、同策略意图下 Pi 与 Claude 的对照测试。

退出条件：

- Pi 和 Claude 都通过共同的 Runtime 控制面契约；
- 二者的能力差异会产生不同的执行计划或拒绝结果，而不是被布尔开关掩盖；
- 同一审计查询能解释两个 Runtime 的 Run，但仍可下钻到 Runtime 原始事件；
- 在完成这些条件前不开始第三个 Harness Adapter。

### Stage 4：Instance 调和与分层恢复

目标：从“服务调用 Runtime”进入真正的受管生命周期和故障恢复。

任务：

- 建立 Instance 期望状态与实际状态的 reconciliation loop；
- 支持 ephemeral 与 warm 两种生命周期策略；
- 引入 heartbeat、lease、启动超时、终止和孤儿回收；
- 分别记录对话、Workspace、Run/Attempt 和工具副作用恢复证据；
- 根据 Runtime Capability、Checkpoint、Workspace 和 ToolExecution 生成恢复决定；
- 对进程退出、控制面重启、Sandbox 丢失、Runtime 超时和工具结果已提交等场景做
  故障注入；
- 保证自动恢复后的 Run 重新经过策略和资源准入。

退出条件：

- 控制面重启后能重建 Instance 和等待 Run 的实际状态；
- 不会因重复恢复再次执行已经成功的非幂等副作用；
- 无法安全自动恢复的任务进入明确的 review/unrecoverable 状态；
- Instance 调和和 Run drain 各自职责清楚，不互相递归驱动。

### Stage 5：异构 ResourcePool 与统一调度

目标：把已完成的 GPU 感知准入推广为真实的多资源编排，而不是通用监控面板。

任务：

- 将本地 vLLM GPU/KV/并发封装为第一个 ResourcePool Provider；
- 增加远程模型 token、rate limit、并发和费用预算资源池；
- 增加 Sandbox CPU、内存和实例容量资源池；
- 让 HarnessTemplate 和 Run 声明资源需求与约束；
- 将 Tenant quota、公平性和 ResourcePool capacity 共同纳入 claim；
- 保留原子占位、幂等释放、single-flight drain 和资源恢复自动推进；
- 对估计 token 和实际 usage 分别记录，使用误差区间，不作任务完成保证。

退出条件：

- GPU 压力只阻塞依赖本地 vLLM 池的 Run；
- 远程模型限流或预算能够独立形成可解释背压；
- 多资源 claim 不会部分占用后失败泄漏；
- 两个 Tenant、两个 Runtime、多个资源池下无永久饥饿。

### Stage 6：生产深度与验证

目标：在语义闭环成立后，再解决单进程 SQLite 无法证明的问题。

任务：

- 将持久化迁移到支持并发 claim 和 lease 的数据库；
- 支持多个 Coordinator/Worker 的幂等竞争；
- 建立认证、Tenant 授权和服务身份；
- 接入结构化日志、指标和分布式 trace；
- 建立策略、Template 和 Adapter 版本兼容及迁移规则；
- 压测 noisy neighbor、公平性、恢复时间、审计完整性和策略拒绝；
- 根据真实瓶颈决定是否进入 Scheduling Agent、vLLM priority、KV Event 或
  Residency 研究。

退出条件：不依赖单进程内存正确性，在多 Worker 和故障注入下仍能保持不重复副作用、
不泄漏 slot/lease、无越权执行，并能用审计证据解释结果。

## 6. 优先级与停止规则

### 必须优先

1. Template/Instance/Capability 的最小真实闭环；
2. Policy 编译与强制执行；
3. Pi 和 Claude 双 Runtime 证明；
4. Instance reconciliation 与分层恢复；
5. 异构 ResourcePool。

### 暂缓

- 第三个及更多 Harness Adapter；
- 复杂管理 UI；
- 计费、套餐和组织层级；
- 自研通用工作流 DSL；
- Agentic Scheduling 直接控制生产流量；
- 深度修改 vLLM Scheduler 或物理 KV 管理。

### 停止或回退条件

- 新抽象不能同时被 Pi 和 Claude 使用：回到 Capability/Adapter 边界重新设计，
  不继续堆 Runtime 特例；
- 策略只能保存在数据库、无法在执行路径落实：不进入下一阶段；
- Runtime 缺少关键 hook 且外部 Gateway/Sandbox 也无法补足：明确声明不支持该保证，
  不伪造统一能力；
- 资源策略没有对准入或预算产生可测影响：不宣称资源感知完成；
- 恢复测试只能证明任务最终成功，不能证明副作用未重复：不宣称安全恢复完成。

## 7. 贯穿所有阶段的验收维度

| 维度 | 必须回答的问题 |
| --- | --- |
| 正确性 | 状态、租户归属、策略和资源占用是否原子且可重建？ |
| 安全 | 被拒绝的工具、文件、网络和 Secret 访问是否真的没有发生？ |
| 恢复 | 恢复了哪一层，为什么可以自动恢复，副作用是否重复？ |
| 异构性 | Pi 与 Claude 的差异是否被诚实表达并影响执行？ |
| 资源 | 哪个资源池阻塞了 Run，资源恢复后是否自动推进？ |
| 公平性 | Tenant 和大任务是否会造成永久饥饿？ |
| 审计 | 能否从 Template 一直解释到最终结果，并下钻原始证据？ |
| 可运维 | 控制面重启、Runtime 退出和 Sandbox 丢失后能否收敛？ |

## 8. 文档维护规则

- 本文已经由 ADR 0009 取代，不再是当前主线执行入口；
- `ONE_WEEK_HARNESS_MVP_GUIDE.zh-CN.md` 只维护 Day 1–7 已完成事实；
- `harness-implementation-plan.zh-CN.md` 保留早期 Agent–Inference/KV 研究材料，
  其中的研究阶段不能覆盖本文优先级；
- 每个 Stage 开始前补充该阶段的细化任务和验收测试，结束后记录真实完成证据；
- 任何性能、资源优化和恢复可靠性结论都必须链接到可复现实验结果。
