# 多租户 Agent 任务服务：产品实施路线图

> 决策日期：2026-08-12  
> 上位决策：[ADR 0009](adr/0009-build-a-multi-tenant-agent-task-service.md)  
> 文档性质：当前唯一产品实施入口

## 1. 产品目标

交付一个可由实验室或小型团队实际使用的多租户 Agent 任务服务：团队成员共享本地
Pi + vLLM/GPU，但拥有独立项目 Workspace 和任务；用户能够提交任务、观察执行、
获得文件修改与结果，并在失败后安全恢复。

项目内部以两部分为技术重点：

```text
③ Environment / Sandbox
  +
④ Execution / Orchestration
```

Sandbox 落实隔离，编排层建立身份、策略、调度、生命周期和恢复。它们服务于用户
任务闭环，不作为两个独立基础设施产品对外销售。

## 2. 代表性用户流程

```text
用户使用 API Key 登录团队空间
  → 创建或选择项目 Workspace
  → 选择执行环境并提交 Agent 任务
  → 查看排队位置、资源状态与实时输出
  → Agent 在独立 Sandbox 中读取代码、修改文件并运行测试
  → 用户查看工具过程、文件 Diff 和最终回答
  → 用户下载 Artifact，或中断/恢复任务
```

管理员可以配置 Tenant 并发上限、可用模型、Tool、ExecutionProfile 和 Secret，
并查看全局 GPU 状态及需要人工确认的恢复任务。

## 3. 产品边界

| Agent Infra 层 | 当前项目责任 |
| --- | --- |
| ① Harness/Runtime | 使用 Pi，维护必要 Adapter，不自研 Agent Loop |
| ② Tool/Context | ToolGateway、Session 和 Checkpoint 作为执行支撑 |
| ③ Environment/Sandbox | **核心：Workspace、进程、网络、Secret、资源隔离** |
| ④ Execution/Orchestration | **核心：鉴权、调度、生命周期、恢复** |
| ⑤ Trace/Observability | 为用户任务详情与审计提供证据 |
| ⑥ Evaluation | 只用于回归和产品验收 |
| ⑦ Model Serving | 使用和观测 vLLM，不接管其内部实现 |

## 4. 产品对象

```text
Tenant
  ├── Member / ApiCredential
  ├── ExecutionProfile
  ├── Workspace
  │     └── Session
  │           └── Run
  │                 ├── Attempt
  │                 ├── SandboxInstance
  │                 ├── ToolExecution
  │                 └── Result / Diff / Artifact
  └── TenantPolicy / Quota / SecretReference
```

`ExecutionProfile` 是用户可理解的运行环境模板；`SandboxInstance` 是某次 Attempt
实际获得的隔离环境。Workspace 需要持久，Sandbox 默认随 Attempt 创建和销毁。

## 5. 产品价值、技术亮点与威胁模型

### 5.1 用户价值不是“看资源指标”

用户购买的不是调度器、状态机或 Sandbox Provider，而是下面这段体验：

> 把一个真实代码项目交给 Agent，在不影响其他团队的情况下等待任务完成，看到
> 过程和修改结果；即使资源繁忙、Agent 进程退出或服务重启，也能知道发生了什么，
> 并在不重复危险操作的前提下继续。

GPU/vLLM 资源状态只是决定任务何时可以安全启动的一类输入。若项目只读取显存、
超过阈值就排队，它只是资源过滤器；本项目的完整亮点是把可信身份、执行隔离、
公平准入、Sandbox 生命周期、副作用恢复和结果交付连接在同一个用户任务中。

### 5.2 为什么保留多租户、暂缓异构

- **保留多租户**：它直接来自真实使用方式，并自然产生身份、数据、Workspace、
  Secret、执行环境、资源公平和审计边界；去掉后，第③层隔离和第④层公平编排都会
  退化成缺少真实约束的演示。
- **暂缓异构 Runtime**：Pi 已经能够承担当前 Agent Loop。此时接入第二 Runtime
  主要证明 Adapter 通用性，却不能先解决用户能否安全提交和取得结果的问题；它会
  稀释 Sandbox 与编排深度。
- **保留可替换接口**：暂停异构不等于删除 `AgentRuntime`、Template、Instance 或
  Capability。它们继续用于依赖倒置、版本固定和 fail-closed，但不扩张成产品卖点。

### 5.3 第一版威胁模型

| 风险 | 必须建立的边界 | 验收方式 |
| --- | --- | --- |
| 客户端伪造 `tenantId` | Tenant 只从认证 Principal 派生 | A 使用 B 的 ID 仍无法访问或操作 B 的对象 |
| 猜中其他 Run/Workspace ID | 所有外部 Store/Service 查询 Tenant-scoped | 跨 Tenant 读取、interrupt、resume 返回 404 |
| 路径穿越或任意宿主机路径 | `workspaceId` 映射到 Tenant Root，规范化后校验 | `../`、绝对路径、symlink escape 测试失败 |
| 恶意 Prompt 诱导工具越权 | Effective Policy + ToolGateway + Sandbox 三层强制 | 模型输出不能扩大调用者权限 |
| 读取其他 Tenant 文件或 Secret | 每 Attempt 独立 mount，只注入授权 Secret | 文件、环境变量与进程探测攻击失败 |
| 网络外传数据 | 默认无网络，模型流量走受控入口 | 任意外连失败，允许的模型请求仍可用 |
| fork bomb / 内存耗尽 / 长命令 | PID、CPU、内存与超时限制 | 超限只终止本 Sandbox，Run/slot 正确收敛 |
| Sandbox 被 kill 或服务重启 | 持久状态、事件、Checkpoint 与启动重建 | 不泄漏 slot，不重复已确认危险副作用 |

第一版威胁模型关注同机、不互信 Tenant 之间的应用级与容器级隔离。它不声称抵御
宿主机内核漏洞、容器逃逸、恶意管理员或物理攻击；这些限制必须在 README 和演示中
明确说明。

## 6. 实施顺序

### P0：可信多租户入口

当前状态（2026-08-17）：已完成 API Key 摘要存储、`RequestPrincipal`、服务端 Tenant
派生、Run 的读/事件/中断/恢复 Tenant 检查与 IDOR 404 测试，以及认证/授权
`ALLOW/DENY` 的追加式审计事件；用户可查询的审计 API/UI 仍待补。

任务：

- 增加高熵 API Key 认证，数据库只保存不可逆凭证摘要；
- 建立 `RequestPrincipal { subjectId, tenantId, scopes }`；
- 从 Principal 派生 Tenant，停止信任请求体 `tenantId`；
- Run、Session、Event、Decision、Checkpoint 和 Queue 查询全部 Tenant-scoped；
- 跨 Tenant 资源统一返回 404，管理员能力使用显式 scope；
- 记录认证与授权的允许/拒绝审计事件。

退出条件：Tenant A 无法创建、读取、中断或恢复 Tenant B 的任务，也无法看到 B 的
队列、Workspace 和 Secret 元数据。

### P0：Workspace 与 ExecutionProfile

当前状态（2026-08-17）：已完成受管 Workspace 的创建、列表和 `workspaceId → tenant
root` 映射，正式 HTTP 提交不再接受任意 `workspacePath`；Sandbox Secret 值已按 Tenant
namespace 解析且没有全局 fallback。版本化 ExecutionProfile 与可配置的 Tenant Secret
Reference 仍待补。

任务：

- 用户通过 `workspaceId` 使用服务端管理的 Workspace，不再提交任意绝对路径；
- Workspace 路径固定在 Tenant Root 下并防止路径穿越；
- 定义版本化 ExecutionProfile：镜像、Tool、网络模式、Secret 与资源限制；
- Tenant/Template/Workspace/Run 策略继续取交集，编译成不可变 `SandboxSpec`；
- Secret Provider 改为 Tenant-scoped，只保存引用和名称。

退出条件：同一 Tenant 可以拥有多个项目；不同 Tenant 即使使用相同 workspace 名称
也不会指向同一目录、Secret 或环境配置。

### P0：真实隔离执行环境

当前状态（2026-08-17）：已实现 `ContainerSandboxProvider`，把非 root、只读 RootFS、
cap drop、no-new-privileges、PID/CPU/内存、网络与单 Workspace 挂载编译为 Docker
启动参数，且对不可可信落实的 bind-mount 磁盘配额 fail closed。Pi 内置文件/Shell
工具已改走容器命令边界；Docker 真机攻击测试仍待完成。该 Provider 当前是 Docker/runc
硬化基线，不能声称为独立内核边界。

补充状态：Container Provider 已将 `docker exec` 的容器缺失/停止语义翻译为 Sandbox LOST
生命周期事件，使既有 Attempt/Run/Instance 收敛链可以消费；该映射已由 fake Docker 与
Stage 2 集成测试验证，真实 daemon 失联与 kill 演练仍待真机。

本机 2026-08-17 未发现可连接的 Docker daemon/socket，因此不能用单元测试替代此退出条件；
真机攻击与清理验收应在 Linux Docker/A6000 环境进行，并保留原始命令和结果。

任务：

- 实现单机 Linux `ContainerSandboxProvider`；
- 每个 Attempt 创建独立容器并等待 readiness；
- 落实非 root、只读 RootFS、capabilities、CPU、内存、PID 和默认无网络；
- 只挂载本次 Workspace，只注入本次被授权的 Secret；
- Agent 文件和 Shell Tool 通过 Sandbox Executor 执行，不再直接操作宿主机；
- Sandbox exit/lost/timeout 进入 Attempt、Run 和 slot 收敛链；
- `ManagedLocal` 只保留为开发和测试 Provider。

### P0.5：Sandbox 运行时分级（当前迭代核心）

当前状态（2026-08-17）：已完成第一步代码切片：`SandboxSpec` 固定 profile/runtime，OCI 参数编译
与 Docker runtime adapter 分离，`default` 默认选择 runsc 并通过 `docker inspect` 保存实际 runtime
证据；strict 仅路由到显式预留 Provider，gVisor 不匹配时 fail closed。Linux Docker/gVisor 真机
smoke 与攻击式验证仍待执行，不能把 fake 测试当作真机隔离证据。

决策：保留 OCI/Docker 作为镜像与生命周期接口，以 gVisor/runsc 作为多租户默认执行运行时；
Kata/Firecracker/托管 microVM 仅作为 `strict` Provider 的可替换目标，不自研虚拟机控制面。

任务：

- 在 `SandboxSpec` / `ExecutionProfile` 加入不可变 `sandboxProfile`（`default`、
  `restricted-egress`、`strict`）和实际 runtime 证据；
- 将 `ContainerSandboxProvider` 拆为 OCI 参数编译层与 runtime adapter，新增
  `runsc` adapter；不支持的能力 fail closed，不得降级为 runc；
- `default` 使用 gVisor，继续落实每 Attempt 独立环境、非 root、最小挂载、资源限额；
- `restricted-egress` 默认仍不直连公网；后续只经受控 egress proxy 按任务授予域名白名单；
- `strict` 的路由、审计和生命周期先接入统一合同，具体 microVM Provider 后续可接 Kata、
  Firecracker 或托管实现；
- 将 Workspace 交付演进为受控输入/输出同步与 Diff/Artifact 导出，避免把宿主机目录当作
  长期共享环境；
- 新增攻击式验证：跨 Tenant 文件/Secret、宿主敏感路径、外网、fork bomb、资源耗尽、
  runtime 不支持能力与 Sandbox 丢失。

退出条件：Linux 真机上可证明 `default` 任务实际使用 runsc，攻击不能静默落入 runc；
每个 Attempt 的 profile、runtime、资源限额、网络决定和回收结果可在审计记录中关联。

退出条件：文件、进程、环境变量、Secret 和网络的跨 Tenant 隔离由真实攻击测试
证明，而不是只检查数据库配置。

### P0：任务编排与恢复闭环

任务：

- 保持 Tenant 内 FIFO、Tenant 间 round-robin 和并发上限；
- GPU/vLLM `CRITICAL/UNKNOWN` 继续形成可解释背压；
- Sandbox 创建成功后才把 Attempt 置为 RUNNING；
- Sandbox 创建失败、丢失、超限退出和控制面重启后状态可重建；
- 已成功工具结果不重复执行；未知副作用进入 `REVIEW_REQUIRED`；
- 恢复任务重新经过身份、策略、Sandbox 和资源准入。

退出条件：单一 Tenant、失败 Sandbox 或控制面重启不会泄漏 slot、越权恢复或重复
危险副作用。

### P1：用户任务闭环

当前状态（2026-08-17）：已提供同源最小 Task Console 和 Tenant-scoped 的 Workspace、Run
历史、输出、Diff、终态 Artifact 下载、中断 API；“实时”当前以 1.2 秒轮询持久化输出实现，
工具时间线与 `REVIEW_REQUIRED` 人工操作仍待补。

API 与最小界面至少支持：

- 登录/凭证状态；
- Workspace 创建与列表；
- Task/Run 创建、列表和详情；
- 排队状态、实时文本与工具时间线；
- interrupt/resume；
- 最终回答、文件 Diff、命令/测试结果和 Artifact；
- `REVIEW_REQUIRED` 的原因展示与人工决定；
- Tenant 管理员的 ExecutionProfile、Quota 和 Secret Reference 配置。

退出条件：新用户不需要理解 RunStore、PolicySnapshot 或 SandboxProvider，也能完成
“创建项目 → 提交任务 → 查看修改 → 恢复失败任务”的完整流程。

### P1：真实环境和产品验收

在 A6000 Linux 服务器上验证：

- 直接 Pi → vLLM 与服务路径的时延开销；
- 两个 Tenant 的公平启动顺序和最大等待时间；
- 多个并发 Sandbox 的 CPU、内存与清理行为；
- GPU/vLLM 压力下的排队与自动推进；
- 文件、进程、网络、Secret 跨 Tenant 攻击；
- Sandbox kill、Runtime failure 和控制面重启后的恢复；
- 重复外部副作用次数，目标为 0。

结果保留运行配置、原始数据和用户可读汇总；没有证据时不宣称生产级隔离、性能
提升或高可用。

## 7. 代表性产品演示

```text
Tenant A 和 B 分别登录并创建同名 Workspace
  → A 连续提交 A1/A2，B 提交 B1
  → GPU 繁忙，任务显示排队原因和位置
  → 资源恢复后按 A1 → B1 → A2 推进
  → A1/B1 获得不同 Sandbox、目录、Secret 和资源上限
  → A 尝试读取 B 文件、Secret、Run 和网络，全部被不同边界拒绝
  → B1 在容器中修改代码并运行测试，用户看到实时过程和 Diff
  → kill B1 Sandbox，控制面释放 slot 并给出恢复决定
  → 安全恢复不重复已完成工具，危险副作用显示人工确认
  → 用户取得最终回答、文件修改和 Artifact
```

## 8. 当前不做

- 第二 Runtime、异构 Adapter 市场；
- Kubernetes、多节点和完整云平台；
- 通用 MCP/RAG/Memory/Workflow/Eval 平台；
- 企业 SSO、复杂 RBAC、计费和组织管理；
- MicroVM 与任意网络白名单；
- 自研推理引擎或无数据支撑的 vLLM 深度调度；
- LLM 网关 / 多模型路由治理：**第一步已完成**（内嵌控制面、OpenAI 兼容、主备回退、熔断、决策记录），第二步（Pi 真实调用经网关、持久化决策记录）与 GPU 压力联动路由为候选扩展。

## 9. 完成定义

产品阶段完成必须同时满足：

1. 用户能够完成 Workspace、任务、过程和结果的端到端流程；
2. Tenant 身份来自认证上下文，而不是客户端自报；
3. Agent 的文件和 Shell 操作真实发生在独立 Sandbox；
4. 两个 Tenant 的数据、Workspace、进程、Secret 和权限攻击测试通过；
5. 共享 GPU 压力真实改变任务执行，公平性可以查询和复现；
6. Sandbox/Agent 故障后状态、slot 和副作用安全收敛；
7. 用户能获得最终回答、Diff/Artifact，而不只是数据库终态；
8. README 明确当前保证、威胁模型和非目标。
