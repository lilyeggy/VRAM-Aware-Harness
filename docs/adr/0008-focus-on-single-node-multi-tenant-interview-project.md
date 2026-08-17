# ADR 0008：收敛为单机共享 GPU 的多租户 Agent Harness 面试项目

## 状态

已被 ADR 0009 取代为当前产品与实施方向；保留为范围收敛的历史决策

> 2026-08-12 更新：ADR 0008 正确保留了多租户并暂停异构扩张，但错误地把“面试
> 项目”和“执行控制面”当作产品定义，并把真实容器 Sandbox 放到秋招后。当前产品
> 是可供团队使用的多租户 Agent 任务服务，内部重点建设③隔离执行环境和④任务编排。
> 见 [ADR 0009](0009-build-a-multi-tenant-agent-task-service.md)。

## 日期

2026-08-12

## 背景

项目已经完成 Pi + 自托管 vLLM 的单进程纵向切片，并实现 Run/Attempt 状态机、
工具副作用记录、Checkpoint、安全恢复、真实资源观测、Tenant 公平队列、有效策略、
最小 Sandbox 和审计时间线。ADR 0007 曾把下一阶段定义为异构 Harness 控制面，
要求继续接入 Claude、异构 ResourcePool 和 Instance 调和。

当前项目的直接目标不是发表论文或建设完整产品，而是在 2026 年秋招前形成一个
边界清楚、能够真实演示、经得起系统设计追问的 Agent Infra 面试项目。继续沿异构
控制面扩张会增加大量接口和文档，却不能优先补足当前最重要的证据缺口：真实 GPU
实验、真实 Pi 任务、故障注入、量化结果、仓库可复现性和简洁项目叙事。

同时，多租户不能一并删除。没有 Tenant 竞争，资源准入容易退化为单用户阈值过滤；
Tenant 归属、并发上限、Tenant 内 FIFO、Tenant 间公平、策略差异和审计隔离，正是
共享单机 GPU 场景成立的必要条件，也是现有代码的重要工程价值。

## 决策

当前规范定位调整为：

> **面向单机共享 GPU 环境的多租户、资源感知、可恢复 Agent Harness：使用 Pi
> 驱动自托管 vLLM，以持久化 Run/Attempt 管理 Agent 长任务，根据 GPU 与 vLLM
> 资源事实实施公平准入和背压，并通过工具副作用记录、Checkpoint、策略强制和
> 审计时间线保证故障后的安全恢复。**

项目核心不是“检测显存”，而是以下闭环：

```text
多 Tenant 提交任务
  → 持久化 Run 与公平排队
  → GPU/vLLM 资源准入与 slot 占用
  → Tenant 有效策略约束下执行 Pi
  → ToolGateway 记录工具意图、结果和副作用
  → Checkpoint 与追加式事件形成恢复证据
  → 崩溃后重建队列并重新准入
  → 安全任务恢复，不确定副作用进入人工处理
```

### 1. 保留多租户为核心场景

Tenant 继续作为数据、策略、资源、公平性和审计归属边界。当前实现必须继续证明：

- Tenant 内 FIFO、Tenant 间 round-robin；
- 全局和单 Tenant 并发上限；
- 单 Tenant 持续提交任务时其他 Tenant 不永久饥饿；
- 不同 Tenant 可以得到不同的工具、模型和文件策略；
- Run、事件、Checkpoint、ToolExecution 和资源决策可追溯到 Tenant。

当前只承诺单进程内的逻辑隔离和确定性公平，不宣称具备认证、RBAC、计费、容器级
隔离或生产级安全边界。

### 2. 当前只支持一个真实 Runtime 与资源环境

当前真实部署组合固定为：

```text
Pi Agent Runtime → 自托管 vLLM → 单机 NVIDIA GPU
```

`AgentRuntime` 接口、Fake Runtime 和 CapabilityProfile 保留，因为它们分别支撑
依赖倒置、确定性测试和启动前能力验证；但不再将它们宣传为已经完成异构 Runtime
治理。Claude Adapter、第三个 Runtime 和跨 Runtime 统一语义不进入秋招前主线。

### 3. 保留已进入执行路径的控制面对象

HarnessTemplate、HarnessInstance、HarnessSession、Run、Attempt、
EffectivePolicySnapshot 和 Sandbox 不删除。它们已经提供版本固定、执行归属、
策略强制、Secret 边界和审计证据。当前不继续扩张 warm instance、跨主机恢复、
reconciliation loop 或通用 Provider 平台。

### 4. 秋招前以可验证证据作为完成标准

任何新增工作必须直接改善以下至少一项：

- 五分钟内可演示的多租户资源竞争与崩溃恢复闭环；
- A6000 上可复现的真实 Pi/vLLM 结果；
- 延迟、排队、吞吐、资源、恢复和重复副作用等量化指标；
- kill/restart、资源压力、Runtime 失败和危险工具等故障注入；
- README、一键命令、CI、提交历史和面试讲解的可信度。

仅增加抽象类、Adapter 数量、管理 UI 或研究设想，不构成当前阶段进展。

## 当前非目标

- Claude 或其他第二 Runtime；
- 异构 ResourcePool 和多资源联合 claim；
- PostgreSQL 多 Coordinator/Worker、Kubernetes 和跨主机 lease；
- 生产级认证、RBAC、计费、组织管理和管理后台；
- 自研 Agent Loop、RAG、Memory、Multi-Agent 或 Workflow DSL；
- 没有真实数据支撑的 vLLM Scheduler、KV Residency 或 Scheduling Agent 改造；
- 论文式创新声明或生产级 SLA 承诺。

## 与既有决策的关系

- ADR 0001 仍成立：Pi 是当前唯一真实 Runtime；
- ADR 0004 被加强：多租户从“支撑场景”提升为面试项目的核心资源竞争场景；
- ADR 0005 仍成立：模型可替换，vLLM 负责 token 级调度和物理 KV；
- ADR 0006 仍定义可靠执行和资源准入的基础合同；
- ADR 0007 保留为历史演进方案，但其 Claude、异构 ResourcePool 和大型控制面路线
  被本 ADR 暂停，不再是当前实施顺序。

## 后果

好处：

- 不删除现有多租户、策略、恢复和控制面代码；
- 项目叙事与真实完成度一致，避免用单 Runtime 冒充异构平台；
- 资源感知通过 Tenant 公平性、背压和恢复闭环体现，不退化为显存过滤器；
- 有限时间优先投入真实实验、故障证据和可复现交付。

代价：

- 项目暂时不能宣称统一管理多个 Agent Runtime；
- SQLite 和单进程调度只能证明核心语义，不能证明分布式高可用；
- 需要用诚实的限制说明替代宏大的产品路线。

## 实施入口

本 ADR 对应的历史实施顺序见
[`interview-project-roadmap.zh-CN.md`](../interview-project-roadmap.zh-CN.md)。当前路线见
[`multi-tenant-agent-task-service-roadmap.zh-CN.md`](../multi-tenant-agent-task-service-roadmap.zh-CN.md)。
