# ADR 0004：将多租户作为一等控制面边界

## 状态

已接受，并由 ADR 0009 扩展为当前产品的用户、数据与执行安全边界。它必须贯穿
身份、Workspace、Policy、Sandbox、Secret、资源、结果和审计，但不意味着建设
通用企业 SaaS 平台。

## 背景

当本项目运行在共享模式时，不是一名用户独占一个 Agent Runtime 和一组 GPU，
而是多个用户、多个 Session 和多个 AgentRun 共享自托管 vLLM、工具接口与有限
GPU 资源。

如果先按单租户实现，再在 API 或数据库表上补一个 `tenant_id`，以下问题仍然
没有答案：

- 一个 Tenant 能否读取另一个 Tenant 的 Run、事件、Checkpoint 或工具结果；
- Workspace、Secret 和外部工具凭证由谁拥有；
- 某个 Tenant 持续提交长任务时，其他 Tenant 是否会饥饿；
- 并发、Token、费用、显存与排队时间应按什么主体统计和限制；
- 日志、指标、事件和恢复操作如何保持 Tenant 归属；
- 资源调度如何同时考虑全局安全线与 Tenant 公平性。

因此，在共享部署场景中，多租户不是 Day 6 才加入的队列功能，而是数据归属、
权限和公平性的架构边界。它不意味着 MVP 要建设完整的多租户 SaaS 平台。

## 决策

项目从第一版数据模型和接口开始，将 `Tenant` 作为身份、权限、配额、公平性
与审计的主体。

必须遵守以下原则：

1. `HarnessSession` 必须属于一个 Tenant，`AgentRun` 必须同时带有稳定的
   `tenantId` 和 `harnessSessionId`。
2. RunEvent、ToolExecution、Checkpoint、Workspace 引用、资源决策和 usage
   都必须能够追溯到 Tenant，不能依赖进程内的隐式当前用户。
3. 所有读取和写入接口最终都必须支持 Tenant-scoped 查询；仅凭全局 `runId`
   找对象只能作为内部 MVP 过渡，不能成为外部授权边界。
   RuntimeEventBridge 等内部组件接收事件时，也必须同时接收可信的
   `TenantRunContext`，不能把 Runtime 自报的 `runId` 当作授权证明。
4. 调度先保证全局资源安全，再保证 Tenant 之间的公平与硬配额，最后才处理
   同一 Tenant 内的 Session/Run 顺序。
5. Workspace、Secret 和工具权限必须通过显式引用和策略接口隔离；模型输出
   不能扩大调用者原本拥有的权限。
6. 至少使用两个 Tenant 的确定性测试证明无跨租户读取、单 Tenant 并发上限
   和受限资源下的非饥饿行为。
7. 任何 Agentic Scheduling 建议都不能绕过 Tenant 硬配额、权限和资源安全线。

第一周 MVP 只承诺：

- 数据模型显式携带 Tenant；
- 组件接口保留 Tenant 边界；
- SQLite 查询和 Fake 测试能够证明逻辑隔离；
- 公平队列能够证明两个 Tenant 在受限并发下都有进展。

第一周 MVP 不宣称已经具备完整认证、RBAC、网络隔离、容器级 Workspace 隔离
或生产级计费。

## 不选择的方案

### 先做单租户，未来再补 tenant_id

不选择。Tenant 会影响主键查找、唯一约束、队列、公平性、缓存、Secret、
Workspace 和审计。后加字段无法自动修复这些边界，反而容易留下跨租户读取
和资源垄断问题。

### 每个 Tenant 独占一套 Harness 和 vLLM

第一周不选择。它简化了隔离，但失去了共享昂贵 GPU、研究公平调度和提高资源
利用率的项目价值，也会带来更高部署与运维成本。

生产环境可以根据安全等级采用混合模式：逻辑共享、独立 Workspace、专用
Worker，或为高敏感 Tenant 使用独立控制面和推理资源。

## 后果

好处：

- 共享部署不会因为单租户隐式假设破坏核心恢复和资源准入语义；
- Tenant 公平性、资源调度、审计和成本归因拥有统一主体；
- 若未来确有需要，接入认证、配额或 Workspace 隔离时不需要重写核心对象；
- 可以用多 Tenant 测试暴露单用户 Demo 永远不会出现的饥饿和越权问题。

限制：

- 所有 Store、Service、Queue 和 Policy 接口都需要考虑 Tenant 上下文；
- 测试矩阵和故障场景明显增加；
- SQLite 单进程 MVP 只能证明逻辑语义，不能代表生产级安全隔离；
- 共享资源提高利用率的同时，也引入 noisy-neighbor 和更大的故障影响范围。
