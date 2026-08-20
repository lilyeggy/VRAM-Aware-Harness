# Paperclip 源码参考指南：我们应该借鉴什么、怎样落到异构 Harness 控制面

> **定位说明（2026-08-12）**：本文是源码参考和秋招后演进材料，不是当前实施
> 路线。Claude/多 Adapter、通用 Provider 与大型控制面已经暂停；只借鉴与
> Workspace/Sandbox、工具副作用、状态竞争、恢复、Tenant 权限和故障证据直接相关
> 的设计。当前路线见
> [多租户 Agent 任务服务路线图](multi-tenant-agent-task-service-roadmap.zh-CN.md)。

> 文档性质：面向本项目后续开发的源码级参考与实施建议  
> 分析日期：2026-08-10  
> Paperclip 本地仓库：`/Users/mac/Desktop/agent_harness/paperclip`  
> Paperclip 固定提交：`6a4e2e1b8c7129f6f913ae458ab0be9cba50bd6a`  
> 提交标题：`fix(routes): return 409 for routine checkout conflicts (#3790)`  
> 克隆方式：`git clone --depth 1`，因此当前适合阅读现状，不包含完整提交历史  
> 本项目：`/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness`

## 0. 先给结论

Paperclip 是目前最值得我们作为**工程实现主参考**的项目，但不是因为它与我们的产品
完全相同，而是因为它已经真实解决了以下问题：

1. 在同一个 TypeScript 控制面中运行 Claude、Codex、Gemini、Pi、Cursor、OpenCode、
   HTTP、普通进程以及外部插件 Adapter；
2. 把本地进程、SSH 和 Sandbox 统一为 provider-neutral 的执行目标；
3. 持久化 Runtime Session，并在 Adapter、工作目录或远端环境变化时谨慎决定是否恢复；
4. 使用数据库 compare-and-set 抢占 Run、阻止晚到结果覆盖已有终态；
5. 管理进程元数据、环境 Lease、孤儿回收、重启调和和日志持久化；
6. 在 Tool Gateway 中实现租户作用域、权限、审批、参数签名、限流、审计和幂等键；
7. 把 Adapter 的配置 Schema、环境诊断、模型发现、Skill 同步、配额查询一并纳入契约。

我们不应该把 Paperclip 当作可以改名复用的底座。Paperclip 的中心对象是
`company → agent → issue/task → heartbeat run`；我们的中心对象是：

```text
Tenant
  └── HarnessTemplate(version)
        └── HarnessInstance
              └── Session
                    └── Run
                          └── Attempt
```

更关键的是，我们的长期差异化能力是：

- 资源事实参与准入，而不只是统计用量；
- 恢复要分别证明 Session、Workspace、Run/Attempt 与工具副作用；
- 通过 Capability Profile 诚实表达不同 Harness 的保证；
- 统一审计不能丢失 Runtime 原始证据；
- 无法落实的关键策略必须 fail closed。

因此正确策略是：

> **借 Paperclip 的 Adapter 工程化、Environment/Lease、CAS 状态更新、凭据隔离、日志与
> 测试方法；保留并深化我们自己的 Capability、EffectivePolicy、ResourceAdmission、
> Attempt、Checkpoint 与 ToolEffect 语义。**

## 1. 两个项目的相同点与本质差异

| 维度 | Paperclip | 我们的项目 | 结论 |
| --- | --- | --- | --- |
| 技术栈 | TypeScript、Node、pnpm monorepo、Postgres/Drizzle | TypeScript、Bun、SQLite，当前单服务 | 语言和生态高度可参考 |
| Adapter | 多种 Coding Agent、CLI/ACP/HTTP/插件 | 当前 Pi，下一阶段 Claude | Paperclip 是直接实现参考 |
| 核心对象 | Agent、Issue、Task Session、Heartbeat Run | Template、Instance、Session、Run、Attempt | 不照搬领域模型 |
| 执行环境 | local、SSH、Sandbox plugin、Lease | ManagedLocal Sandbox，Provider 接口已存在 | 借鉴 target/driver/lease 分层 |
| 调度 | Agent 串行、Issue 锁、依赖、预算、定时唤醒 | Tenant 公平队列、资源准入、ResourcePool 方向 | 组合，而不是替换 |
| 恢复 | Session 续用、进程丢失重试、热重启 adoption、liveness | Checkpoint + ToolEffect + RecoveryDecision + Attempt | 我们的安全恢复应更严格 |
| 工具治理 | 权限、审批、签名、连接、限流、审计 | 前置策略守卫、副作用台账、结果复用 | 两套优点必须合并 |
| 资源 | token/cost/quota、环境容量等 | GPU/VRAM 已真实参与准入，准备扩成异构资源池 | 这是我们的核心差异之一 |
| 能力表达 | Adapter optional hooks/flags，部分仍有硬编码 fallback | 显式 `RuntimeCapabilityProfile` | 保留我们的显式模型 |
| 编排结构 | `heartbeat.ts` 约 19,115 行 | 多个小服务和状态机 | 学语义，不复制巨型服务 |

## 2. 阅读优先级：哪些代码最值得先看

### P0：必须阅读，直接影响我们 Stage 3–4

| 顺序 | 文件 | 重点 |
| --- | --- | --- |
| 1 | [Adapter 类型契约](/Users/mac/Desktop/agent_harness/paperclip/packages/adapter-utils/src/types.ts) | `ServerAdapterModule`、执行上下文、结果、事件、Session codec、诊断 |
| 2 | [Adapter Registry](/Users/mac/Desktop/agent_harness/paperclip/server/src/adapters/registry.ts) | 内置/外部 Adapter 注册、覆盖、暂停、墓碑、模型与配置发现 |
| 3 | [Pi execute](/Users/mac/Desktop/agent_harness/paperclip/packages/adapters/pi-local/src/server/execute.ts) | 我们现有 PiAdapter 最直接的对照实现 |
| 4 | [Codex execute](/Users/mac/Desktop/agent_harness/paperclip/packages/adapters/codex-local/src/server/execute.ts) | 第二个异构 Runtime 所需的凭据、Session、超时、降级与远程执行经验 |
| 5 | [Execution Target](/Users/mac/Desktop/agent_harness/paperclip/packages/adapter-utils/src/execution-target.ts) | Adapter 与 local/SSH/Sandbox 解耦的关键层 |
| 6 | [Environment Run Orchestrator](/Users/mac/Desktop/agent_harness/paperclip/server/src/services/environment-run-orchestrator.ts) | acquire → realize → target → release 生命周期 |
| 7 | [Environment Runtime](/Users/mac/Desktop/agent_harness/paperclip/server/src/services/environment-runtime.ts) | Provider/Driver 与 Lease 的真正接口 |
| 8 | [Heartbeat 编排](/Users/mac/Desktop/agent_harness/paperclip/server/src/services/heartbeat.ts) | Run claim、CAS 终态、Session 持久化、孤儿回收与 finally 清理 |

### P1：应当选择性阅读，用于强化已有能力

| 文件 | 重点 |
| --- | --- |
| [Tool Access Policy](/Users/mac/Desktop/agent_harness/paperclip/server/src/services/tool-access-policy.ts) | 租户/主体/Run/Issue 作用域校验、策略优先级、限流与调用记录 |
| [Tool Gateway](/Users/mac/Desktop/agent_harness/paperclip/server/src/services/tool-gateway.ts) | 审批参数签名、一次性消费、远程 MCP/stdio/plugin 调度、审计 |
| [Tool schema](/Users/mac/Desktop/agent_harness/paperclip/packages/db/src/schema/tool_access.ts) | Invocation、ActionRequest、CallEvent、Gateway Session 的数据模型 |
| [Run Log Store](/Users/mac/Desktop/agent_harness/paperclip/server/src/services/run-log-store.ts) | NDJSON、字节范围读取、SHA-256、S3 完成/进行中镜像 |
| [Run schema](/Users/mac/Desktop/agent_harness/paperclip/packages/db/src/schema/heartbeat_runs.ts) | 进程、输出水位、重试、liveness、Session 前后引用 |
| [Task Session schema](/Users/mac/Desktop/agent_harness/paperclip/packages/db/src/schema/agent_task_sessions.ts) | Adapter 作用域的 Session 参数持久化 |
| [Environment Lease schema](/Users/mac/Desktop/agent_harness/paperclip/packages/db/src/schema/environment_leases.ts) | Lease 状态、策略、Provider 引用、清理状态 |

### P2：暂不应复制

- Issue/组织层级、Board approval、Routine、公司治理等产品域代码；
- 复杂 UI 与插件商店；
- Paperclip 的 Agent 心跳业务语义；
- `heartbeat.ts` 的整体组织方式；
- 为兼容历史数据而存在的 legacy fallback；
- 在完成 Pi + Claude 双 Runtime 前，继续接入十几个 Adapter。

## 3. 最值得借鉴之一：把 Adapter 从 `start/resume` 扩成完整模块

### 3.1 Paperclip 的契约到底包含什么

Paperclip 的 [ServerAdapterModule](/Users/mac/Desktop/agent_harness/paperclip/packages/adapter-utils/src/types.ts)
不是只有一个 `execute()`。它还包括：

```ts
interface ServerAdapterModule {
  type: string;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext):
    Promise<AdapterEnvironmentTestResult>;

  sessionCodec?: AdapterSessionCodec;
  sessionManagement?: AdapterSessionManagement;
  getConfigSchema?: () => AdapterConfigSchema | Promise<AdapterConfigSchema>;

  listSkills?: ...;
  syncSkills?: ...;
  listModels?: ...;
  refreshModels?: ...;
  getQuotaWindows?: ...;
  detectModel?: ...;

  getRuntimeCommandSpec?: (config) => AdapterRuntimeCommandSpec | null;
  supportsLocalAgentJwt?: boolean;
  supportsInstructionsBundle?: boolean;
  requiresMaterializedRuntimeSkills?: boolean;
}
```

这段设计揭示了一个容易被低估的事实：**异构 Harness 的差异并不只发生在运行时事件
映射阶段。** 差异同时发生在：

- 如何发现和安装命令；
- 如何验证环境；
- 如何表示和迁移 Session；
- Skill 是传参数、写文件还是不支持；
- 模型列表来自静态声明、本机探测还是 Provider API；
- usage 是单次 Run 还是 Session 累计值；
- 凭据、HOME、网络和 Sandbox 怎样组合；
- UI 怎样渲染 Runtime 特有配置；
- Provider quota 怎样转换为控制面的资源信号。

### 3.2 对我们当前接口的直接影响

我们当前的 [AgentRuntime](/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness/src/runtime/agent-runtime.ts)
主要是：

```ts
interface AgentRuntime {
  getCapabilityProfile?(): RuntimeCapabilityProfile;
  start(request: RuntimeStartRequest): Promise<void>;
  resume(request: RuntimeResumeRequest): Promise<void>;
  interrupt(runId: string): Promise<void>;
  subscribe(runId: string, handler: RuntimeEventHandler): () => void;
}
```

这个接口适合 Stage 0–2 的纵向切片，但接 Claude 时会开始承受压力：环境检测、Session
结构、配置 Schema、凭据准备、模型/Skill 发现会被迫散落到 composition root、HTTP API
或 Adapter 内部私有逻辑中。

建议不要把所有 optional 方法继续塞进 `AgentRuntime`，而是拆成显式模块：

```ts
export interface HarnessAdapterManifest {
  readonly kind: RuntimeKind;
  readonly version: string;
  readonly driver: RuntimeDriver;
  readonly sessionCodec: RuntimeSessionCodec;
  readonly capabilityReporter: RuntimeCapabilityReporter;
  readonly policyCompiler: RuntimePolicyCompiler;
  readonly environmentDiagnostics: EnvironmentDiagnostics;
  readonly configuration: AdapterConfigurationProvider;
  readonly catalog?: {
    readonly models?: ModelCatalogProvider;
    readonly skills?: SkillCatalogProvider;
    readonly quotas?: QuotaWindowProvider;
  };
}
```

这里有两个有意区别于 Paperclip 的地方：

1. Paperclip 的能力主要由“某 optional hook 是否存在”和少量 flag 推断；我们仍应保留
   独立 `RuntimeCapabilityProfile`，因为能力会决定拒绝、降级和恢复保证；
2. Paperclip 把执行结果、Session 和 Run 较紧地绑在一次 `execute()` 上；我们仍要维持
   `Run → Attempt`，每次 start/resume 都产生独立 Attempt 证据。

### 3.3 应直接借鉴的细节

`AdapterExecutionResult` 中值得进入我们稳定模型的字段：

- `errorCode`、`errorFamily`、`retryNotBefore`：不要只保存错误字符串；
- `usageBasis: per_run | session_cumulative`：否则恢复同一 Session 后容易重复计费；
- `sessionParams` 与 `sessionDisplayId` 分离：机器恢复句柄与 UI 展示 ID 不应混为一谈；
- `clearSession`：Adapter 可明确宣布已保存 Session 失效；
- `provider`、`biller`、`model`、`billingType`：执行 Provider 与实际计费主体可能不同；
- `runtimeServices`：Agent 启动的预览服务、开发服务器等应是结构化产物；
- `question`：Runtime 需要人类输入不应伪装成失败；
- `onMeta`、`onEvent`、`onSpawn`、`onRuntimeProgress`：分别承载调用元数据、归一化事件、
  进程身份和短暂运行进度。

我们可以把结果模型放在 `src/runtime/`，但持久化时应绑定 `attemptId`，而不是只绑定
`runId`。

## 4. Adapter Registry：注册、覆盖、墓碑与迁移

### 4.1 Paperclip 做得好的地方

[registry.ts](/Users/mac/Desktop/agent_harness/paperclip/server/src/adapters/registry.ts) 同时处理：

- 内置 Adapter 注册；
- 外部插件异步加载；
- 外部 Adapter 覆盖内置 Adapter；
- 暂停覆盖时恢复内置实现；
- 禁用 Adapter 只从新建菜单隐藏，不破坏已有 Agent；
- 模型静态声明、动态发现和强制刷新；
- 退役 Adapter 的 tombstone。

其中最值得抄的是 `acpx_local` 墓碑。Paperclip 没有直接删除类型，而是保留一个一定
失败、错误信息明确的 Adapter。这样旧数据库记录不会神秘地落入别的执行器。

我们的 Template 是不可变版本，因此更应该采用这一做法：

```ts
interface AdapterResolution {
  status: "ACTIVE" | "RETIRED" | "MISSING" | "INCOMPATIBLE";
  adapterKind: string;
  implementationVersion: string | null;
  replacement?: {
    adapterKind: string;
    migrationGuide: string;
  };
}
```

旧 Template 引用退役 Adapter 时必须得到 `RETIRED_ADAPTER`，不能自动落到通用进程
Adapter。

### 4.2 一个不应照搬的点

Paperclip 同时存在：

```ts
requireServerAdapter(type) // 未找到就抛错
getServerAdapter(type)     // 未找到就回退到 processAdapter
```

第二种行为对我们的安全模型不合适。未知 Runtime 不能静默变成普通进程，否则
Capability、Sandbox、Tool interception 和恢复保证全部可能失真。

我们的 Registry 应只允许：

```ts
resolveExact(kind, implementationVersion): HarnessAdapterManifest
```

找不到就拒绝 Attempt，并写入审计；兼容迁移只能由显式 Template migration 完成。

### 4.3 建议落地文件

新增：

```text
src/runtime/adapter-manifest.ts
src/runtime/adapter-registry.ts
src/runtime/adapter-resolution.ts
tests/runtime/adapter-registry.test.ts
```

核心测试：

- 同 kind、不同实现版本可并存；
- 已启动 Attempt 始终持有解析时的实现版本；
- 新版本注册不改变旧 Attempt；
- retired/missing/incompatible 均 fail closed；
- 外部 Adapter 不能悄悄覆盖平台内置实现；如果未来允许覆盖，必须显式启用并可回滚。

## 5. Pi Adapter：我们现有实现最直接的升级参考

Paperclip 的 [Pi execute](/Users/mac/Desktop/agent_harness/paperclip/packages/adapters/pi-local/src/server/execute.ts)
约 847 行。它不是简单的 CLI wrapper，而是一条完整的执行边界。

### 5.1 它的真实执行顺序

```text
解析 provider-neutral ExecutionTarget
  → 解析模板配置与 Workspace 上下文
  → 注入受管 Skill / Pi provider 配置
  → 构建并过滤环境变量
  → 检测/安装 Runtime command
  → 本地验证模型，或准备远程 Runtime assets
  → 启动远程 callback/log bridge
  → 校验 Session 与 cwd、workspace、remote identity 是否匹配
  → 新建或恢复 Session 文件
  → 构造 system/bootstrap/wake/handoff prompt
  → 输出 invocation meta
  → 执行进程并解析 JSONL
  → 标准化 usage、cost、session、summary、error
  → Session 不存在时用新 Session 重试一次
  → finally 恢复远程 Workspace、关闭 bridge、清理临时配置
```

### 5.2 Session 恢复不是“有 ID 就 resume”

Paperclip 检查：

```ts
const canResumeSession =
  runtimeSessionId.length > 0 &&
  sessionTargetMatches &&
  sessionParamsCwdMatches &&
  sessionHeaderCwdMatches;
```

这对我们非常关键。当前 [RuntimeCheckpointRef](/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness/src/runtime/agent-runtime.ts)
主要保存 `runtimeSessionRef` 和事件位置；未来必须把 Runtime Session 与执行上下文绑定，
至少保存：

```ts
interface RuntimeSessionEnvelope {
  schemaVersion: number;
  adapterKind: RuntimeKind;
  adapterImplementationVersion: string;
  opaqueParams: Record<string, unknown>;
  displayId: string | null;
  workspaceIdentity: {
    workspaceId: string;
    revision: string | null;
    canonicalPath: string | null;
  };
  executionTargetIdentity: Record<string, unknown> | null;
  configFingerprint: string;
}
```

恢复前应分别判断：

- Adapter 与 Session schema 是否兼容；
- Workspace 是否仍是同一份逻辑 Workspace；
- 本地路径或远程目标身份是否匹配；
- 模型/权限/工具/Skill 变化是否允许同一 Session 继续；
- Session 文件/远端状态是否真的存在。

这会把我们现在的“Checkpoint 引用某个 Pi session”升级为“有证据证明这个 Session 能在
本 Attempt 的目标环境中恢复”。

### 5.3 应借鉴的调用元数据

Pi Adapter 在执行前通过 `onMeta` 发送：

- Adapter 类型；
- 解析后的命令和 cwd；
- 参数；
- 已脱敏环境；
- Prompt 和字符统计；
- 上下文；
- 命令说明。

我们应将其拆成两层：

1. `InvocationPlan`：编译后、执行前冻结，用于审计与重现；
2. `RawRuntimeEvidenceRef`：stdout/stderr/原始事件的外部引用。

注意：Prompt 可能包含用户私密内容，不应默认完整进入通用事件 payload。建议持久化
hash、长度、模板版本、脱敏摘要；只有受限 evidence store 保存原文。

### 5.4 对当前 PiAdapter 的具体改造

当前 [PiAdapter](/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness/src/runtime/pi-adapter.ts)
已经完成 SDK event → Harness event、SessionManager、ToolGateway 工具绑定和模型 usage，
但可以从 Paperclip 补齐：

| 缺口 | Paperclip 参考 | 我们应如何实现 |
| --- | --- | --- |
| 环境预检 | `testEnvironment()` | 在创建/启动 Instance 时执行，结果绑定 capability profile |
| Session codec | `pi-local/server/index.ts` | 不把 Pi 文件路径当通用字符串，使用 versioned envelope |
| cwd/target 校验 | `canResumeSession` | 进入 RecoveryDecision 的 Session 层证据 |
| 远端执行 | `execution-target.ts` | Runtime Driver 只依赖 `ExecutionTarget`，不依赖 Sandbox 具体实现 |
| Runtime 安装 | `getRuntimeCommandSpec()` | 仅在模板允许 provisioning 时执行幂等安装 |
| 原始 JSONL | `parsePiJsonl` + run log | 同时保存 raw evidence 和 normalized event |
| 失效 Session | `clearSession` | 标记 Session generation 失效，不能只删除内存 Map |
| 临时资产清理 | `finally` | AttemptFinalizer 统一释放，不由 Adapter 随意吞错 |

但不要把 Paperclip 的 CLI 实现直接换进来。我们当前使用 Pi SDK，能够在 SDK 级别
拦截工具和事件，这是比纯 CLI JSONL 更强的能力。值得借鉴的是外围生命周期，不是退回
更弱的执行方式。

## 6. Codex/Claude Adapter：第二个 Runtime 的真正难点

### 6.1 为什么先读 Codex，再写 Claude

Paperclip 的 Codex 实现展示了异构 Adapter 会遇到的典型问题：

- CLI 与 ACP 两个执行引擎；
- engine `auto` 的能力协商与 fallback；
- 本机登录、API key、受管 HOME、Sandbox 自带登录的优先级；
- 本地与远端 Session identity；
- 长时间无输出但进程可能仍活跃；
- Provider quota、瞬时上游故障、Harness crash 的不同错误族；
- 新 Session、同 Session、safer invocation 的不同重试模式；
- Skill、MCP、instructions 和 config 文件的物化方式。

这些问题同样会出现在 Claude Code/Agent SDK，只是具体配置和事件不同。

### 6.2 凭据优先级必须成为显式决策

[auth-precedence.ts](/Users/mac/Desktop/agent_harness/paperclip/packages/adapters/codex-local/src/server/auth-precedence.ts)
把优先级写成纯函数：

```text
configured API key
  > host auth.json
    > sandbox auth.json
      > none
```

同时记录 Sandbox 登录是否被宿主凭据遮蔽。这比“把 `process.env` 全传给子进程”安全
得多。

我们应把 Secret 注入编译结果定义为：

```ts
interface CredentialResolution {
  selectedSource: "TEMPLATE_BINDING" | "TENANT_BINDING" |
    "INSTANCE_IDENTITY" | "SANDBOX_IDENTITY" | "NONE";
  injectedKeys: readonly string[];
  shadowedSources: readonly string[];
  auditSummary: Record<string, unknown>;
}
```

严禁在审计中保存 token 值。还应在进入 Adapter 前清除宿主继承的 Provider 身份变量，
只注入编译后允许的键。

### 6.3 “无输出超时”与“总执行超时”不同

Codex Adapter 有输出 inactivity monitor：

- 每次 stdout/stderr 或可确认的进程活动会刷新活性；
- 超过阈值先发 `SIGTERM`；
- 5 秒后仍存活再 `SIGKILL`；
- 诊断日志会在进程结束前确保刷出；
- 返回专门的 `codex_output_inactivity_monitor` 错误码。

我们的 Attempt 超时至少应拆为：

```ts
interface AttemptTimeoutPolicy {
  startupTimeoutMs: number;
  wallClockTimeoutMs: number | null;
  outputInactivityTimeoutMs: number | null;
  gracefulTerminationMs: number;
  leaseHeartbeatTimeoutMs: number;
}
```

不同超时触发的恢复结论不同：启动失败通常可安全重试；进程长时间无输出时是否能恢复，
还要检查 Checkpoint 和工具副作用；Lease heartbeat 丢失则先判断 Sandbox 是否仍存在。

### 6.4 Engine lane 应影响 Capability，而不只是配置参数

同一 `codex_local` 在 CLI 与 ACP 模式下，Session、权限交互、进程拓扑、热重启 adoption
能力并不相同。Paperclip 已经在热重启时区分 server-stdio ACP 与可脱离子进程，但其
Adapter 类型仍相同。

我们的 `deploymentKey` 应包含：

```text
runtime kind + adapter version + engine lane + execution target kind
+ runtime version + policy compiler version
```

Capability Profile 必须针对这个部署组合生成，不能写成“Claude 永远支持 X”。

## 7. Session Codec：隔离 Runtime 私有状态与控制面稳定模型

Paperclip 的 [AdapterSessionCodec](/Users/mac/Desktop/agent_harness/paperclip/packages/adapter-utils/src/types.ts)
很小：

```ts
interface AdapterSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?: (params: Record<string, unknown> | null) => string | null;
}
```

价值不在代码量，而在边界：控制面不再假设 Session 只有一个字符串 ID。

Pi codec 能接受 `sessionId/session_id/session` 和 `cwd/workdir/folder`；Codex codec 还保存
workspace、repo 与 ACP 形态。这让历史结构可被规范化。

我们应比它更进一步：

- 每种 codec 有 `schemaVersion`；
- 提供 `migrate(raw, fromVersion)`；
- `validateForResume(session, target, policy, capability)` 返回结构化原因；
- Adapter 私有参数保存在 `opaqueParams`，控制面只理解 envelope；
- `Session` 与 `Checkpoint` 分开：Session 是 Runtime 对话关系，Checkpoint 是控制面
  可恢复边界，两者不能互相替代。

建议新增：

```text
src/sessions/runtime-session-codec.ts
src/sessions/runtime-session-envelope.ts
src/sessions/session-resume-validation.ts
tests/sessions/runtime-session-codec-contract.test.ts
```

每个 Adapter 必须通过同一组 codec contract tests：

- serialize → deserialize 语义等价；
- 未知/损坏输入不抛出未分类异常；
- display ID 不参与恢复正确性；
- 旧 schema 有明确迁移或明确拒绝；
- execution target/config fingerprint 不匹配时不可静默 resume。

## 8. Execution Target、Environment Driver 与 Lease：最适合移植的架构层

### 8.1 Paperclip 的三层分工

```text
EnvironmentRunOrchestrator
  ├── 决定本 Run 用哪个 Environment
  ├── acquire lease
  ├── realize workspace
  ├── 解析 AdapterExecutionTarget
  └── release lease

EnvironmentRuntimeDriver
  ├── acquireRunLease / releaseRunLease
  ├── resumeRunLease / destroyRunLease
  ├── realizeWorkspace
  ├── execute
  └── syncIn / syncOut

AdapterExecutionTarget
  ├── local
  ├── remote + ssh
  └── remote + sandbox
```

Adapter 看到的是最后一层，不需要认识 Kubernetes、某个 Sandbox Provider 或数据库
Lease 表。这正是我们未来支持不同用户使用不同 Harness、不同 Sandbox 的正确边界。

### 8.2 与我们现有 SandboxProvider 的关系

我们已有 [SandboxProvider](/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness/src/sandbox/sandbox-provider.ts)，
但目前它更接近生命周期抽象。下一步可以吸收 Paperclip 的执行 seam：

```ts
interface ExecutionTargetDriver {
  acquire(input: AcquireTargetInput): Promise<ExecutionTargetLease>;
  realizeWorkspace(input: RealizeWorkspaceInput): Promise<WorkspaceRealization>;
  exec(input: TargetExecInput): Promise<TargetExecResult>;
  syncIn?(input: SyncInput): Promise<SyncResult>;
  syncOut?(input: SyncInput): Promise<SyncResult>;
  release(input: ReleaseTargetInput): Promise<void>;
  destroy(input: DestroyTargetInput): Promise<void>;
}
```

其中 `ExecutionTargetLease` 必须绑定：

- tenantId；
- harnessInstanceId；
- runId 与 attemptId；
- provider 与 providerLeaseId；
- acquire/heartbeat/expiry/release 时间；
- cleanup status；
- workspace realization identity；
- 实际落实的网络、文件、CPU/内存/磁盘约束摘要。

### 8.3 Workspace realization 是恢复事实，不是复制细节

Paperclip 区分：

- `copy`：远端复制并在结束后恢复；
- `in_place`：目标环境中的 authoritative root；
- path aliases；
- outbound restore paths。

这应该进入我们的 Workspace 恢复层。一个 Run 的对话 Session 可恢复，不代表 Workspace
仍可恢复；一个 Sandbox 可复用，也不代表其中 Workspace 与当前模板一致。

建议定义：

```ts
interface WorkspaceRealizationEvidence {
  mode: "COPY" | "IN_PLACE" | "MOUNT" | "VOLUME_SNAPSHOT";
  authoritativeRoot: string;
  sourceRevision: string | null;
  realizedRevision: string | null;
  outboundStateRef: string | null;
  integrityHash: string | null;
  dirty: boolean | null;
}
```

RecoveryDecision 应消费它，而不是只看 `workspacePath` 是否存在。

### 8.4 Lease 释放前 Run 必须终态

Paperclip 的 `terminalizeRunOnLeaseRelease()` 固定了一个很好的不变量：

> 环境 Lease 释放时，Run 不能还显示为 queued/running。

如果正常 finalizer 没有写入终态，它会用条件更新将 Run 收敛到 succeeded、cancelled
或 interrupted，并补一条 lifecycle event。

我们应把它改写到 Attempt 语义：

> **Attempt 仍为 PENDING/RUNNING 时不能完成 Lease release；如果释放不可避免，先以
> `INTERRUPTED/LOST` 终结 Attempt，再释放资源。Run 是否终态由后续 RecoveryDecision
> 决定。**

不能直接把 Run 终结，因为我们的一个 Run 可能还有安全的下一个 Attempt。

## 9. Run 编排：值得借鉴的是状态不变量，不是 19k 行服务

### 9.1 原子 claim

Paperclip 的 `claimQueuedRun()` 最终执行：

```ts
UPDATE heartbeat_runs
SET status = 'running', ...
WHERE id = ? AND status = 'queued'
RETURNING *
```

只有一个竞争者会得到记录。这应替换我们未来多 Worker 场景中任何“先读 QUEUED，
再无条件更新 RUNNING”的路径。

对我们而言 claim 对象应是 Attempt/调度票据，并同时完成资源占位：

```text
验证 EffectivePolicy + Capability
  → 原子 claim Attempt
  → 原子/可补偿 acquire ResourceReservation
  → acquire ExecutionTargetLease
  → Attempt RUNNING
```

如果多种资源无法在一个数据库事务中占用，需要 reservation saga，并保证失败时释放
已经占用的资源，不能留下半占用。

### 9.2 条件终结阻止晚到结果覆盖

`setRunStatusFromLive()` 使用 `WHERE status IN (...)`。Adapter 返回成功、取消请求、
watchdog 和孤儿回收可能并发；最先写入终态的路径获胜，晚到结果只能读取现状，不能
覆盖。

我们的 [RunAttempt](/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness/src/runs/run-attempt.ts)
当前状态转换主要是纯函数，下一步 Store 必须增加持久化 CAS：

```ts
finishIfLive(
  attemptId,
  expected: ["PENDING", "RUNNING"],
  terminalPatch,
): { updated: boolean; current: RunAttempt }
```

关键并发测试：

- cancel 先到，Adapter success 后到：保持 cancelled/interrupted；
- watchdog 先判 lost，进程退出失败后到：保持 lost；
- success 先到，Lease release finalizer 后到：保持 success；
- 两个 Worker 同时 claim：仅一个执行 Adapter；
- finally 重复调用 release：资源只释放一次。

### 9.3 Setup failure 与 Adapter failure 都必须持久化

Paperclip 有内外两层 catch：内部处理 Adapter execute 失败，外部处理执行前的 Workspace、
环境、Secret 等 setup failure。两者都会留下终态和 operator-visible event。

我们应给 Attempt 增加阶段：

```ts
type AttemptPhase =
  | "ADMISSION"
  | "POLICY_COMPILE"
  | "TARGET_ACQUIRE"
  | "WORKSPACE_REALIZE"
  | "RUNTIME_PREPARE"
  | "RUNTIME_EXECUTE"
  | "WORKSPACE_FINALIZE"
  | "TARGET_RELEASE";
```

错误应包含 `phase + code + retryClass + evidenceRef`。这能让 RecoveryDecision 区分“还没
调用 Runtime 就失败”和“工具可能已经产生副作用后失败”。

### 9.4 finally 中集中释放

Paperclip 最终会：

- 确保 Run 终态；
- 释放 Environment Lease；
- 释放 runtime services；
- 清理 scratch；
- 清理 active execution map；
- 推进下一个 queued run。

值得借鉴的是“所有路径都经过统一 finalizer”。但我们的 finalizer 不应直接启动下一个
Run；释放事实写入后，由独立 queue pump/reconciler 观察状态并推进，可以避免编排服务
互相递归。

### 9.5 不应复制 `heartbeat.ts`

该文件约 19,115 行，同时承担调度、Issue 锁、Session、Workspace、Environment、预算、
Run、重试、liveness、日志、热重启、业务评论和状态发布。它含有大量成熟的边界处理，
但组织形式已经是典型 god service。

我们的对应结构应保持：

```text
AttemptOrchestrator
  ├── AdmissionStage
  ├── PolicyCompilationStage
  ├── ExecutionTargetStage
  ├── WorkspaceStage
  ├── RuntimeStage
  └── AttemptFinalizer

Reconcilers
  ├── QueuedAttemptReconciler
  ├── InstanceReconciler
  ├── LeaseReconciler
  └── OrphanAttemptReconciler
```

阶段之间通过持久化事实连接，不通过一个超大函数的局部变量连接。

## 10. 热重启、孤儿进程与 Liveness

### 10.1 Paperclip 的热重启 adoption

Paperclip 在热重启前写 shutdown snapshot，保存：

- Run ID、Agent、Adapter；
- PID/进程组；
- Issue；
- 前后服务版本；
- 是否必须 drain。

新进程启动后把候选分类为：

- `adopted`：受支持的本地子进程仍活着；
- `finalized_while_down`：停机期间已结束；
- `lost`：没有进程身份、进程死亡或 snapshot 不完整；
- `skipped`：Adapter 不支持 adoption 或要求 drain。

它还明确拒绝 adoption server-stdio ACP 进程，因为该进程与旧服务的 stdio 强绑定。

这个思想应直接进入 Capability：

```ts
type ProcessTopology =
  | "IN_PROCESS_SDK"
  | "BOUND_CHILD_STDIO"
  | "DETACHED_CHILD"
  | "REMOTE_SESSION"
  | "PROVIDER_JOB";
```

是否能 adopt 由 topology + provider capability 决定，而不是根据 `runtimeKind` 猜。

### 10.2 孤儿回收先看证据，再决定 retry

Paperclip 会检查：

- 内存中是否仍跟踪执行；
- PID 是否活着；
- 进程组是否还有后代；
- Adapter 是否属于受跟踪本地子进程；
- 是否已经执行过一次 process-loss retry；
- 是否有热重启 adoption 元数据。

我们的 OrphanAttemptReconciler 还应增加：

- ExecutionTarget Lease 是否活着；
- Provider job 是否仍运行；
- 最后一次 runtime event / tool event / lease heartbeat；
- 最新 Checkpoint；
- `PREPARED` ToolExecution 是否存在；
- Workspace 是否可重建；
- 当前 Capability Profile 是否仍适用。

它不应直接“一律重试一次”，而应调用现有
[RecoveryDecision](/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness/src/checkpoints/recovery-decision.ts)
的扩展版本。

### 10.3 Liveness 不等于输出是否非空

Paperclip 会根据 Issue 评论、文档修订、Work Product、Workspace operation、Activity、
工具事件等证据分类“有没有有用动作”。这一点适合学习，但不应复制其 Issue 特定规则。

我们可以定义通用 `ProgressEvidence`：

```ts
interface AttemptProgressEvidence {
  lastRuntimeEventAt: string | null;
  lastModelEventAt: string | null;
  lastToolPreparedAt: string | null;
  lastToolCompletedAt: string | null;
  lastCheckpointAt: string | null;
  lastWorkspaceMutationAt: string | null;
  lastLeaseHeartbeatAt: string | null;
  currentRuntimePhase: string | null;
}
```

“运行着但沉默”“进程死了”“工具等待人工批准”“Provider job 仍活着”必须是不同状态。

## 11. Tool Gateway：借治理能力，保留我们的副作用恢复语义

### 11.1 Paperclip 做得很深的部分

Paperclip Tool Gateway 值得借鉴：

- 从认证主体反查 company/agent/run/issue/project，并逐层验证边界；
- 连接、Catalog entry、Schema hash、risk level 都进入 Invocation；
- 策略决定包含 allow/deny/require_approval/rate_limited/defer_runtime；
- 参数只保存脱敏 summary 和 hash；
- 审批保存 canonical arguments hash 与签名；
- 执行前再次验证目标没有在审批后变化；
- 审批请求以 CAS 从 approved 变 executing，保证一次性消费；
- Issue 已终结时，已批准动作也会过期；
- 结果做 prompt-injection 与敏感内容校验；
- Invocation 与 append-only-ish CallEvent 分离；
- 支持远程 MCP、本地 stdio、插件和内置工具；
- 数据库唯一索引约束 `(companyId, idempotencyKey)`。

尤其值得移植的是“审批的不是工具名称，而是**规范化参数 + 目标快照**”。否则用户批准
的是 A，执行时连接、账户或参数已经变成 B。

### 11.2 Paperclip 的幂等语义不能直接替代我们

Paperclip 的 `recordInvocation()` 在发现相同 idempotency key 时直接返回已有 invocation，
调用方把它视为 replay，并从 `resultSummary` 恢复结果。Invocation 状态包括 pending、
authorized、executing、succeeded、failed 等，但该路径并没有使用我们这样的
`PREPARED + effect classification + checkpoint boundary` 来证明崩溃窗口中的外部副作用。

风险窗口是：

```text
Invocation 已写 executing
  → 外部副作用成功
  → 控制面在 result 持久化前崩溃
```

重启后，数据库无法仅凭 `executing` 证明外部动作成功还是未执行。返回空摘要或再次调用
都可能不安全。

我们现有：

- [ToolExecution](/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness/src/tools/tool-execution.ts)
  的 `READ_ONLY / IDEMPOTENT_WRITE / UNKNOWN_EFFECT`；
- `PREPARED / SUCCEEDED / FAILED`；
- [ToolGateway](/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness/src/tools/tool-gateway.ts)
  执行前持久化 PREPARED；
- 成功结果与 Checkpoint 原子完成；
- 只有安全类别允许自动 replay；

这些不应删除。

### 11.3 最佳合并模型

建议把一次工具调用拆成四组事实：

```text
ToolAuthorization
  - effectivePolicySnapshotId
  - matched rules / decision / explanation

ToolApproval
  - canonical argument hash
  - target snapshot hash
  - signature / approver / expiresAt / one-shot consume

ToolExecution
  - effect class
  - PREPARED / SUCCEEDED / FAILED / UNCERTAIN
  - idempotency key / provider request id
  - exact result artifact ref

ToolAuditEvent
  - append-only state transitions and redacted summaries
```

状态建议增加 `UNCERTAIN`：外部调用可能成功但控制面没有提交结果时，不应伪装成
FAILED。恢复策略：

| Effect | PREPARED/UNCERTAIN 后恢复 |
| --- | --- |
| READ_ONLY | 可以重新执行，仍记录新 Attempt |
| IDEMPOTENT_WRITE | 只有 Provider 接受并验证同一幂等键时可重试 |
| UNKNOWN_EFFECT | REQUIRE_REVIEW，除非有外部查询证据证明结果 |

### 11.4 适合从 Paperclip 移植的测试

- 作用域不匹配一律 403/deny；
- 审批参数 hash 不一致拒绝；
- 审批后目标连接变化拒绝；
- 已批准 Action 只能被一个执行者 CAS 消费；
- 审批到期/任务关闭后拒绝；
- 限流计数原子更新；
- 参数与结果脱敏；
- prompt injection 检测失败不把原始恶意结果交给 Runtime；
- 日志和 audit event 中不出现 Secret。

然后叠加我们自己的 crash-window 故障注入测试。

## 12. 日志与统一审计：双轨存储非常值得借鉴

### 12.1 Paperclip RunLogStore

[run-log-store.ts](/Users/mac/Desktop/agent_harness/paperclip/server/src/services/run-log-store.ts)
采用 NDJSON，每条包含：

```json
{"ts":"...","stream":"stdout","chunk":"...","seq":17}
```

它支持：

- 本地 append，保持 live tail 低延迟；
- 每 Run 单调 seq；
- offset + limitBytes 范围读取；
- finalize 时计算 bytes 和 SHA-256；
- 完成日志镜像到 S3；
- 可选地周期镜像 in-flight 日志；
- finalize 等待正在进行的镜像，避免旧的 partial object 反向覆盖完整日志；
- 本地文件消失时回退 S3；
- 本地 stat 与 open 之间发生删除时也回退，处理 TOCTOU；
- 对象存储失败不覆盖 Run 本身的最终结果。

这些细节高度适合我们的“统一但不丢原始证据”目标。

### 12.2 我们应采用 normalized event + raw evidence 双轨

```text
Runtime 原始 stdout/stderr/SDK event
  ├── RawEvidenceStore
  │     ├── immutable chunks / NDJSON
  │     ├── content hash
  │     ├── adapter + parser version
  │     └── retention / tenant scope
  │
  └── RuntimeEventNormalizer
        └── RunEventTimeline
              ├── model_started/completed
              ├── tool_started/completed
              ├── lifecycle
              └── policy/resource/recovery events
```

我们当前 [RuntimeEventBridge](/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness/src/events/runtime-event-bridge.ts)
可以继续承担规范化，但每条规范化事件应补：

```ts
interface RuntimeEvidencePointer {
  evidenceRef: string;
  rawSequenceStart: number;
  rawSequenceEnd: number;
  normalizerVersion: string;
  adapterImplementationVersion: string;
}
```

这样上游 SDK 事件变化或 parser 修复后可以重新解释原始证据，而不是只剩不可逆的统一
事件。

### 12.3 Paperclip event seq 的一个扩展点

Paperclip `nextRunEventSeq()` 用 `max(seq) + 1` 查询。在同一 Run 有并发事件写入时，若无
额外串行化/唯一约束，两个写者可能算出相同 seq。

我们当前单进程中问题不明显，但未来多 Worker 应使用：

- Run/Attempt 行上的原子 sequence counter；或
- 数据库 sequence allocation；或
- 唯一 `(runId, sequence)` + 冲突重试。

不能依赖“通常只有一个写者”。

## 13. Environment Diagnostics 与声明式配置 Schema

Paperclip 要求每个 Adapter 实现 `testEnvironment()`，返回 pass/warn/fail 和结构化检查：

```ts
{
  code,
  level,
  message,
  detail,
  hint
}
```

它还允许 Adapter 返回声明式 `getConfigSchema()`，UI 不需要为每个 Adapter 都写专用
React 表单。

这适合我们，但诊断应成为 capability 的证据来源，而不是仅供设置页展示：

```text
Template 创建/升级
  → Schema validation
  → Instance reconcile
  → Environment diagnostics
  → Runtime version/capability probe
  → CapabilityProfile snapshot
  → Run admission validates required guarantees
```

建议诊断分为：

- `STATIC_CONFIG`：字段、组合、版本约束；
- `HOST_RUNTIME`：命令、SDK/CLI 版本、依赖；
- `CREDENTIAL`：只有存在性和来源，不泄露值；
- `EXECUTION_TARGET`：目标可达性、Provider capability；
- `POLICY_ENFORCEMENT`：网络/文件/进程/Tool hook 是否真实可落实；
- `SESSION_RECOVERY`：Session store 是否可读写/跨主机；
- `RESOURCE_SIGNAL`：quota/usage/resource observation 是否可用。

安全关键诊断失败必须阻止 Instance Ready 或 Attempt admission。

## 14. 测试代码比主实现更适合作为阅读入口

Paperclip 的主编排很大，先从测试反推不变量会更高效。

### Adapter 与 Session

- [Adapter registry tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/adapter-registry.test.ts)
- [Session codec tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/adapter-session-codecs.test.ts)
- [Pi remote execute tests](/Users/mac/Desktop/agent_harness/paperclip/packages/adapters/pi-local/src/server/execute.remote.test.ts)
- [Codex remote execute tests](/Users/mac/Desktop/agent_harness/paperclip/packages/adapters/codex-local/src/server/execute.remote.test.ts)
- [Codex auth tests](/Users/mac/Desktop/agent_harness/paperclip/packages/adapters/codex-local/src/server/execute.auth.test.ts)
- [Codex auth precedence tests](/Users/mac/Desktop/agent_harness/paperclip/packages/adapters/codex-local/src/server/auth-precedence.test.ts)

### Environment 与 Lease

- [Execution target tests](/Users/mac/Desktop/agent_harness/paperclip/packages/adapter-utils/src/execution-target.test.ts)
- [Sandbox target tests](/Users/mac/Desktop/agent_harness/paperclip/packages/adapter-utils/src/execution-target-sandbox.test.ts)
- [Environment target tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/environment-execution-target.test.ts)
- [Environment orchestrator tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/environment-run-orchestrator.test.ts)
- [Lease-release terminalization tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/heartbeat-run-lease-release-terminalization.test.ts)

### Run、恢复与日志

- [Process recovery tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/heartbeat-process-recovery.test.ts)
- [Start lock tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/heartbeat-start-lock.test.ts)
- [Zombie guard tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/heartbeat-zombie-guard.test.ts)
- [Retry scheduling tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/heartbeat-retry-scheduling.test.ts)
- [Run log tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/services/run-log-store.test.ts)

### Tool Gateway

- [Tool access policy tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/tool-access-policy-service.test.ts)
- [Tool gateway service tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/tool-gateway-service.test.ts)
- [Tool gateway route tests](/Users/mac/Desktop/agent_harness/paperclip/server/src/__tests__/tool-gateway.test.ts)

阅读测试时不要关注 Paperclip 的 Issue 文案，重点记录：

- 初始状态；
- 并发或故障点；
- 哪个写入必须是条件更新；
- 最终必须保留的事实；
- 重复执行时的幂等结果；
- 失败是否 fail closed；
- Secret/raw content 是否被脱敏。

## 15. Paperclip 代码到我们项目的逐项映射

| Paperclip 实现 | 我们现有代码 | 建议动作 | 优先级 |
| --- | --- | --- | --- |
| `ServerAdapterModule` | `src/runtime/agent-runtime.ts` | 拆出 manifest、driver、codec、diagnostics、catalog | P0 |
| Adapter registry | 暂无正式 registry | 新建严格的 versioned registry，不允许 fallback | P0 |
| Pi session codec/target checks | Pi checkpoint 仅存 ref | 增加 session envelope 与 resume validation | P0 |
| Pi/Codex execution meta | `RuntimeEventBridge` | 增加 InvocationPlan 与 raw evidence ref | P0 |
| Codex auth precedence/managed home | `SecretProvider` 最小边界 | 建立 credential resolution 与 env sanitization | P0 |
| EnvironmentRunOrchestrator | `SandboxProvider` + app 组装 | 拆出 target acquire/realize/release stage | P0 |
| Environment Lease schema | `SandboxRecord` | 新增显式 Lease/heartbeat/cleanup/attempt binding | P0 |
| claimQueuedRun CAS | `RunQueueCoordinator`/`RunService` | 为 Attempt 增加持久化 CAS claim | P0 |
| setRunStatusFromLive | Run/Attempt 纯状态函数 | Store 增加 `finishIfLive` | P0 |
| terminalize on lease release | Sandbox LOST 收敛 | 改为先终结 Attempt，再判断 Run recovery | P0 |
| process recovery/hot restart | `RecoveryStartupCoordinator` | 增加 process topology、lease/provider reconciliation | P1 |
| Tool policy scope/approval/signing | `ToolPolicyGuard` | 移植治理层和批准目标快照 | P1 |
| Tool invocation idempotency | `ToolExecution` | 保留我们的 effect ledger，增加 UNCERTAIN/provider evidence | P0 |
| Run log store | event timeline | 增加 raw NDJSON/evidence store、hash、range read | P1 |
| model/quota providers | runtime config/resource observer | 纳入 ResourcePool Provider，不只 UI 展示 | P1 |
| Config schema | Template validation | Adapter schema 只负责特有字段，平台 schema 负责统一约束 | P1 |
| Heartbeat god service | 已拆分服务 | 只移植不变量，不复制组织方式 | 禁止照搬 |

## 16. 推荐实施顺序：把参考转换成开发任务

### Phase A：先完成第二个 Runtime 前的 Adapter 基础

1. 建立 `HarnessAdapterManifest` 和严格 versioned registry；
2. 将 Pi 注册为第一个 manifest，保持现有执行路径通过；
3. 增加 Environment Diagnostics contract；
4. 增加 versioned Runtime Session Envelope/Codec；
5. 扩充 Runtime result/error/usage 模型；
6. 把 InvocationPlan 与 raw evidence pointer 进入 Attempt 审计。

验收：Pi 行为不回退；同一 Run 能精确指出 Adapter 实现版本、Session schema、执行目标、
策略编译版本与原始证据。

### Phase B：接入 Claude，验证异构能力

1. 明确 Claude 使用 SDK、CLI 或 ACP 的首个 lane；
2. 为该 lane 单独报告 Capability Profile；
3. 实现 credentials/env sanitization；
4. 实现 Session codec 与 resume validation；
5. 实现 permissions/hooks/settings 的 Policy Compiler；
6. 保存 Claude 原始事件和统一事件；
7. 用共同 contract tests 对照 Pi 与 Claude。

验收：相同策略意图在 Pi/Claude 上产生可解释的不同编译结果；缺关键 hook 时明确拒绝，
而不是声称已经保护。

### Phase C：把 Sandbox 升级成 Execution Target + Lease

1. 新建 `ExecutionTargetDriver`；
2. 将 ManagedLocal 包装为第一个 driver；
3. 持久化 Lease 与 WorkspaceRealizationEvidence；
4. Attempt 执行改为 acquire → realize → execute → finalize → release；
5. 所有阶段写结构化错误；
6. Lease release 与 Attempt terminal 形成不变量；
7. 加入失联/重复 release/进程仍活着等故障测试。

### Phase D：并发与恢复强化

1. Attempt Store 增加 claim/finalize CAS；
2. 增加 ProcessTopology 与 RuntimeProcessIdentity；
3. 增加 Lease/Provider/Process 三类 startup reconciliation；
4. RecoveryDecision 消费 Session、Workspace、Attempt、ToolEffect 四层证据；
5. ToolExecution 增加 UNCERTAIN；
6. 只有证据允许时创建 RESUME/RETRY Attempt；
7. 新 Attempt 必须重新经过策略和资源准入。

### Phase E：工具治理与审计增强

1. 引入 canonical arguments hash；
2. 引入审批 target snapshot + signature + expiry；
3. 引入 CAS one-shot consumption；
4. 引入 provider request ID / external reconciliation hook；
5. 增加 raw evidence store；
6. 规范化事件携带 evidence pointer 与 mapping version；
7. 补齐 Secret/redaction/prompt-injection 测试。

## 17. 建议先写的接口，而不是先搬实现

下面这些接口可以作为下一阶段设计评审的最小骨架：

```ts
export interface HarnessAdapterManifest {
  readonly kind: RuntimeKind;
  readonly implementationVersion: string;
  readonly sessionCodec: RuntimeSessionCodec;
  readonly driver: RuntimeDriver;
  readonly capabilities: RuntimeCapabilityReporter;
  readonly policyCompiler: RuntimePolicyCompiler;
  readonly diagnostics: EnvironmentDiagnostics;
}

export interface RuntimeDriver {
  prepare(input: RuntimePrepareInput): Promise<PreparedRuntimeInvocation>;
  start(input: PreparedRuntimeInvocation): Promise<RuntimeExecutionHandle>;
  resume(input: PreparedRuntimeResume): Promise<RuntimeExecutionHandle>;
  interrupt(input: RuntimeInterruptInput): Promise<void>;
  inspect(input: RuntimeInspectionInput): Promise<RuntimeInspection>;
}

export interface RuntimeSessionCodec {
  readonly schemaVersion: number;
  decode(raw: unknown): RuntimeSessionEnvelope | null;
  encode(session: RuntimeSessionEnvelope): Record<string, unknown>;
  validateForResume(input: SessionResumeValidationInput):
    SessionResumeValidation;
}

export interface AttemptFinalizer {
  finalize(input: {
    attemptId: string;
    proposedOutcome: AttemptTerminalOutcome;
    runtimeResult?: RuntimeExecutionResult;
  }): Promise<{
    terminalAttempt: RunAttempt;
    releaseResults: readonly ReleaseResult[];
    recoveryRequired: boolean;
  }>;
}
```

两个特别重要的设计约束：

1. `prepare()` 只生成不可变 Invocation Plan，不产生外部执行副作用；真正启动放在
   `start/resume()`，便于审计和故障注入；
2. `inspect()` 是恢复必需能力。只提供 start/resume/interrupt 的 Runtime 无法在控制面
   重启后重建真实状态。

## 18. 我们相对 Paperclip 应保持的差异化

### 18.1 资源准入是执行前事实

Paperclip 已有 quota/cost/budget 和环境容量，但我们的
[ResourceAdmissionService](/Users/mac/Desktop/agent_harness/VRAM-Aware-Harness/src/resources/resource-admission-service.ts)
已经把真实观测转换成确定性的 ADMIT/QUEUE，并持久化 decision + snapshot。应继续扩成：

```text
GPU/vLLM pool
Remote model rate/quota/cost pool
Sandbox instance/CPU/memory/disk pool
Tool/API quota pool
```

Paperclip 的 `getQuotaWindows()` 可作为远程模型 ResourceObserver 的输入，但不能只显示
在 UI；必须真实改变 admission 或 budget。

### 18.2 Attempt 是一等对象

Paperclip 的 retry 通常创建新的 heartbeat run 或修改同一 Run 的恢复状态。我们应坚持：

- 用户任务是 Run；
- 每一次实际启动/恢复是 Attempt；
- 每个 Attempt 固定 Adapter、Capability、Policy、Sandbox/Target Lease 与资源快照；
- Run 的最终结果由多个 Attempt 的有序证据决定。

这样才能回答“第几次实际执行产生了哪个副作用，为什么下一次可以恢复”。

### 18.3 Capability 决定保证

Paperclip 的 optional hooks 很实用，但仍存在“built-in Adapter 走硬编码 legacy list”的
兼容路径。我们的新项目没有这份历史包袱，应坚持：

- capability 缺失时不能推断为支持；
- 关键安全能力缺失则拒绝；
- 可降级观测能力缺失时记录 audit completeness；
- capability snapshot 与 Attempt 一起冻结。

### 18.4 ToolEffect 恢复不能退化

权限审批只能回答“是否允许执行”，不能回答“崩溃后是否已经执行”。这是我们比普通
异构 Agent 平台更深的地方，必须保留。

### 18.5 Runtime 原始证据可重新解释

只存统一事件会在 Adapter parser 升级后失去真相。我们的双轨审计应允许：

- 查统一时间线；
- 下钻 raw evidence；
- 知道哪个 parser/normalizer 生成当前事件；
- 在不篡改旧事件的前提下生成新的 interpretation version。

## 19. 明确不要照搬的实现

1. **不要复制 `heartbeat.ts` 的巨型编排结构。** 复制其中 CAS、finally、reaper 等不变量，
   保持我们的小服务和显式阶段。
2. **不要使用未知 Adapter → process 的 fallback。** 我们必须严格解析并 fail closed。
3. **不要把 Adapter optional flags 当完整 Capability Profile。** 部署组合能力需要独立探测。
4. **不要把 Session resume 当成完整恢复。** Workspace、Attempt、工具副作用仍需独立证据。
5. **不要只凭 invocation idempotency key 重放外部副作用。** 必须结合 effect class 与
   Provider 幂等/查询证据。
6. **不要让 Adapter 直接决定全局重试。** Adapter 只分类错误并提供证据，Retry/Resume
   由控制面 RecoveryDecision 决定。
7. **不要一次接入所有 Adapter。** 先用 Pi + Claude 证明抽象，再考虑第三个。
8. **不要照搬 Paperclip 产品域。** Company/Issue/Agent org 并不是我们的核心对象。
9. **不要默认保存完整 Prompt、环境或结果。** 先脱敏、hash、分级存储。
10. **不要把本地路径当跨主机身份。** Session/Workspace/Target 必须使用逻辑 identity。

## 20. 最终建议：Paperclip 在我们项目中的正确角色

Paperclip 最适合承担三种角色：

1. **Adapter 工程手册**：每新增一个 Harness，都对照它的配置、环境、Session、凭据、
   远端执行、usage、错误和测试维度；
2. **生产故障清单**：CAS、晚到结果、孤儿 PID、热重启、Lease 泄漏、日志丢失、凭据
   遮蔽、Session/cwd 不匹配等，都可以提前转成我们的故障测试；
3. **反面架构提醒**：成熟控制面很容易把所有逻辑吸入一个 orchestrator；我们应在功能
   增长前固定阶段边界、Attempt 状态机和 Reconciler 职责。

一句话总结：

> **参考 Paperclip 建好“多 Harness 怎么可靠地跑起来”的工程外壳；用我们自己的
> Capability、Policy、ResourcePool、Attempt、Checkpoint 与 ToolEffect，回答“在不同
> 保证、不同资源和故障条件下，为什么允许跑、为什么能恢复、为什么不会重复副作用”。**

这既能缩短开发时间，也保留了我们相对 Paperclip 最有价值的技术差异。
