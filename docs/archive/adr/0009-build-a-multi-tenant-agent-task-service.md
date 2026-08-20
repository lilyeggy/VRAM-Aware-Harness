# ADR 0009：建设可供团队使用的多租户 Agent 任务服务

## 状态

已接受；取代 ADR 0008 作为当前产品与实施方向

## 日期

2026-08-12

## 背景

项目已经完成 Pi + 自托管 vLLM 的可靠执行纵向切片：Run/Attempt 状态机、工具
副作用记录、Checkpoint、安全恢复、GPU/vLLM 资源准入、Tenant 公平队列、有效
策略、最小 Sandbox 生命周期和审计事件。ADR 0008 正确收敛了异构 Runtime 和
通用 ResourcePool，但错误地把“用于秋招展示”以及“执行控制面”本身当成产品定义。

③ Environment/Sandbox 和④ Execution/Orchestration 是项目内部最值得深入的
Agent Infra 层，不代表用户要购买或操作一套抽象基础设施。用户真正需要的是一个
可以登录、创建 Workspace、提交 Agent 任务、查看过程、获得修改结果并在失败后
继续的服务。隔离环境、调度、状态机和恢复是实现这段体验的核心机制。

多租户也不能只停留在 `tenantId`、公平队列和策略快照。若服务面向真实团队，身份
必须可信，数据访问必须按 Tenant 收口，Agent 的文件、进程、网络和 Secret 必须在
真实执行环境中隔离。

## 决策

当前产品定位调整为：

> **VRAM-Aware Agent Harness 是一个支持团队共享本地大模型的多租户 Agent 任务
> 服务。用户可以为项目创建独立 Workspace、提交 Agent 任务、查看执行过程和文件
> 修改，并中断或恢复任务；系统在后台为每次执行分配受 Tenant 策略约束的隔离
> 环境，根据 GPU 与 vLLM 状态公平调度，并通过工具副作用和 Checkpoint 保证故障后
> 的安全恢复。**

### 1. 用户产品与内部技术分开表达

对用户，产品提供：

- 身份认证与团队空间；
- 项目 Workspace；
- Agent 任务提交、列表、详情、排队状态和取消；
- 执行输出、工具过程、文件 Diff 和最终结果；
- 中断后的恢复，以及不确定副作用的人工确认；
- Tenant 管理员可配置的并发、模型、工具、环境和 Secret 权限。

对内部实现，项目重点覆盖：

- **③ Environment/Sandbox**：Workspace、文件、进程、网络、Secret 和计算资源隔离；
- **④ Execution/Orchestration**：身份与授权、Run/Attempt、资源准入、公平调度、
  Sandbox 生命周期、interrupt/resume 和恢复决定。

其他 Agent Infra 层只完成产品闭环所需的支撑，不扩张为独立平台。

### 2. 每次执行使用独立 Sandbox

Tenant 拥有版本化 `ExecutionProfile`，描述镜像、工具、网络、Secret 和资源上限；
每个 Run/Attempt 默认获得独立 `SandboxInstance`。Sandbox 销毁不等于删除
Workspace、Checkpoint 或审计证据。

第一版真实隔离至少落实：

- 非 root 进程、只读根文件系统和最小 Linux capabilities；
- 独立 Workspace mount；
- CPU、内存和 PID 限制；
- 默认无网络，模型访问只走受控入口；
- 只注入本次执行被授权的 Secret；
- Sandbox 创建、就绪、退出、丢失和销毁事件；
- Agent 文件与 Shell 工具在 Sandbox 内真实执行。

当前 `ManagedLocalSandboxProvider` 继续用于单元测试和无容器开发，但不再代表产品
隔离能力。无法落实的硬约束继续 fail closed。

### 2.1 OCI 是接口，gVisor 是默认安全运行时，MicroVM 是 strict 后端

当前已落地的 `ContainerSandboxProvider` 使用 Docker/runc 的 OCI 容器并施加硬化参数，
它是可演示的第一条数据面路径，但容器仍共享 Linux 内核，不能被表述为最高等级的
不可信代码隔离。本项目不自研 Firecracker 或虚拟机管理器；下一迭代保留现有
`SandboxProvider` 生命周期合同，把执行运行时选择显式化：

- `development`：仅用于本地开发与测试的 `ManagedLocal`，不得承载多租户执行；
- `default`：OCI 镜像 + gVisor/runsc，每个 Attempt 一个 Sandbox，适用于通常的
  Agent 文件、Shell、Git 与测试工具；
- `strict`：预留给 Kata/Firecracker/托管 microVM Provider。仅路由高风险或需要
  更强内核边界的任务，不在本项目中手写 VMM；
- 不支持 gVisor 的特性（例如嵌套 Docker 或未兼容 syscall）不能静默回退到 runc，
  必须由策略拒绝或明确路由至 `strict`。

这使产品继续使用统一的 Sandbox 生命周期、审计和结果接口，同时能在面试中诚实地区分
“容器硬化”“用户态内核隔离”和“独立 guest kernel”三种边界。

### 3. 身份是多租户隔离的起点

外部请求不再把请求体中的 `tenantId` 当作可信身份。认证成功后生成不可伪造的
`RequestPrincipal`，由服务端派生 Tenant 与权限。Run、Session、Workspace、事件、
Checkpoint、ToolExecution、Template 和 Secret 的外部访问必须 Tenant-scoped。

第一版可以使用高熵 API Key，不建设密码、OAuth 或完整 IAM；但必须区分认证与
授权，支持最小 scope，并记录允许和拒绝决定。

### 4. 模型服务保持外部依赖

Sandbox 不直接挂载 GPU。Pi/Agent 执行通过受控模型入口访问共享 vLLM，Harness
根据 GPU/vLLM 事实决定任务何时启动。vLLM 继续负责 batching、token 调度和物理
KV；本项目不把模型 Serving 变成自身产品范围。

### 5. 用户结果是完成标准

任务最终交付不只是 `COMPLETED` 状态，还应包含用户可以理解和使用的结果：

- 最终回答；
- Workspace 文件变化或 Diff；
- 测试/命令结果；
- 必要 Artifact；
- 执行状态、失败原因和恢复建议。

内部的策略、资源和副作用事件继续作为任务详情中的解释证据，而不是产品首页的
主叙事。

## 当前非目标

- 第二 Agent Runtime 和异构 Adapter 平台；
- 通用 MCP、Memory、RAG、Workflow 或 Eval 平台；
- Kubernetes、多节点调度和跨主机高可用；
- OAuth、企业 SSO、复杂组织层级和计费；
- 自研 Firecracker/MicroVM 控制面与任意域名级网络策略；
- 自研模型 Serving、训练系统或深度重写 vLLM Scheduler；
- 以“覆盖多少 Agent Infra 层”作为产品完成标准。

## 与既有决策的关系

- ADR 0001 仍成立：Pi 提供 Agent Loop；
- ADR 0004 被补全：Tenant 不仅参与公平调度，还必须形成身份、数据和执行隔离；
- ADR 0005 仍成立：vLLM 是外部推理层；
- ADR 0006 仍定义可靠执行与资源准入合同；
- ADR 0007 继续作为异构控制面历史方案；
- ADR 0008 的“保留多租户、暂停异构”继续成立，但其“面试项目/控制面即产品”定义
  和“真实容器 Sandbox 秋招后再做”被本 ADR 取代。

## 后果

好处：

- 用户价值、系统功能和技术亮点形成同一条闭环；
- ③隔离执行环境和④任务编排拥有明确边界，不需要扩张到全部 Agent Infra；
- 鉴权、Workspace、Sandbox、调度和恢复都能通过真实用户场景验收；
- 项目既能实际部署使用，也能在面试中深入讨论安全与系统设计。

代价：

- 需要补齐当前 HTTP API 的可信身份和 Tenant-scoped 访问；
- 需要让工具真正进入隔离环境，而不只是持久化 Sandbox 元数据；
- 需要增加用户可消费的任务结果、Diff/Artifact 和最小交互界面；
- gVisor 运行时与 Linux A6000 环境成为真实集成验证的一部分；严格 microVM 后端
  只保留 Provider 接口与路由策略，不在当前迭代自研。

## 实施入口

当前唯一产品实施顺序和验收条件见
[`multi-tenant-agent-task-service-roadmap.zh-CN.md`](../multi-tenant-agent-task-service-roadmap.zh-CN.md)。
