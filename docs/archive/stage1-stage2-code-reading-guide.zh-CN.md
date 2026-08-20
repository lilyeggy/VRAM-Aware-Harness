# Stage 1–2 控制面源码精读指南

> **定位说明（2026-08-12）**：本文解释已经实现的 Stage 1–2 代码，相关模块继续
> 保留。文中 Claude、异构 Runtime 和 ResourcePool 只代表原设计背景，不是秋招前
> 实施任务。这些模块现在作为产品内部第③④层的已有底座；当前产品范围见
> [ADR 0009](adr/0009-build-a-multi-tenant-agent-task-service.md)，实施顺序见
> [多租户 Agent 任务服务路线图](multi-tenant-agent-task-service-roadmap.zh-CN.md)。

> 本文面向希望真正吃透当前实现的读者，严格按照推荐阅读顺序讲解 Stage 1 和
> Stage 2 的代码。它不是架构设想，而是对仓库中已经运行、已经测试的真实代码的
> 逐层拆解。

## 0. 如何使用这份文档

这份文档不建议一次性快速看完。每一章按下面的方式阅读：

1. 先读“这一层解决什么问题”；
2. 再看文档中贴出的关键代码；
3. 打开对应源码，对照没有贴出的校验、Store 和类型细节；
4. 阅读对应测试，确认代码承诺是如何被证明的；
5. 回答章末的“读完检查”。

推荐每读完一章，自己画一次输入和输出。控制面最容易混淆的不是语法，而是
“这个对象是谁创建的、什么时候被冻结、由谁消费、失败后留下什么证据”。

本文假设你已经理解 Stage 0 的基础调用链：

```text
submitRun
  → RunService 创建 AgentRun
  → ResourceAdmission + TenantFairQueue
  → AgentRuntime.start/resume
  → RuntimeEventBridge
  → RunEvent / ToolExecution / Checkpoint
```

Stage 1–2 没有替换这条链，而是在 `AgentRuntime` 外围加入版本、能力、策略、
Sandbox 和 Attempt：

```text
submitRun
  → DefaultPiControlPlane 创建或复用控制面对象
  → AgentRun 固定 TemplateVersion + Instance
  → 原有资源准入与公平队列
  → ManagedAgentRuntime
      → 读取 Template / Instance / Session / Capability
      → 计算 EffectivePolicySnapshot
      → 创建 RunAttempt
      → 编译 Pi RuntimeConfig
      → 创建 Sandbox
      → PiAdapter.start/resume
          → ToolGateway 前置策略检查
      → 收敛 Attempt / Sandbox / Instance
```

## 1. 阅读顺序总览

| 顺序 | 文件 | 先回答的问题 |
| --- | --- | --- |
| 1 | `runtime/runtime-capability.ts` | 这个 Runtime 真实能保证什么？ |
| 2 | `instances/harness-instance.ts` | 哪个受管执行环境在承载 Runtime？ |
| 3 | `runs/run-attempt.ts` | 一个 Run 的这一次真实执行如何留证？ |
| 4 | `control-plane/default-pi-control-plane.ts` | 旧 API 如何进入新对象模型？ |
| 5 | `policies/effective-policy.ts` | 五层权限如何合并且只能变得更严格？ |
| 6 | `runtime/managed-agent-runtime.ts` | 谁把前面的对象编排成一次真实执行？ |
| 7 | `policies/tool-policy-guard.ts` | 工具副作用发生前在哪里强制策略？ |
| 8 | `sandbox/managed-local-sandbox.ts` | 执行环境和 Secret 生命周期如何收敛？ |
| 9 | `runtime/pi-adapter.ts` | 控制面结果如何真正进入 Pi SDK？ |
| 10 | `tests/integration/stage1-stage2-control-plane.e2e.test.ts` | 上述承诺如何被端到端证明？ |

---

## 2. 第一读：RuntimeCapabilityProfile

源码：[`src/runtime/runtime-capability.ts`](../src/runtime/runtime-capability.ts)

### 2.1 这一层解决什么问题

异构 Harness 不能假定所有 Runtime 都支持完全相同的功能。例如 Pi 可能支持
Session resume 和 Tool interception，但未必支持跨宿主机恢复；未来的另一个
Runtime 可能提供原生 Sandbox，却不能提供完整原始事件。

如果只定义：

```ts
supportsResume: boolean
```

控制面无法回答下面这些不同的问题：

- 能恢复对话，还是能恢复整个 Workspace？
- 能拦截工具请求，还是只能事后观察工具事件？
- 能否复用已完成工具的结果？
- Sandbox 是 Runtime 原生提供，还是控制面外置提供？
- usage 和模型事件是否完整？

所以代码使用细粒度能力集合：

```ts
export type RuntimeKind = "PI";

export type RuntimeCapability =
    | "SESSION_CREATE"
    | "SESSION_RESUME"
    | "SESSION_FORK"
    | "CROSS_HOST_RESUME"
    | "INTERRUPT"
    | "WORKSPACE_REUSE"
    | "TOOL_INTERCEPTION"
    | "TOOL_RESULT_REUSE"
    | "SIDE_EFFECT_EVIDENCE"
    | "NATIVE_SANDBOX"
    | "EXTERNAL_SANDBOX"
    | "MODEL_USAGE"
    | "MODEL_EVENTS"
    | "RAW_RUNTIME_EVENTS";
```

当前 `RuntimeKind` 只有 `PI` 是刻意的：Stage 3 尚未开始，因此没有预先伪造 Claude
能力。以后新增 Runtime，应通过扩展 RuntimeKind 和对应 Adapter 来进入，而不是把
能力差异藏进 Pi 分支。

### 2.2 Profile 表达的是“部署组合”，不是 SDK 宣传页

```ts
export interface RuntimeCapabilityProfile {
    readonly id: string;
    readonly runtimeKind: RuntimeKind;
    readonly deploymentKey: string;
    readonly supported: readonly RuntimeCapability[];
    readonly auditCompleteness: "FULL" | "PARTIAL";
    readonly reportedAt: string;
}
```

`deploymentKey` 很重要。能力不仅取决于“使用 Pi”，也取决于具体部署方式。例如：

```text
PI + local vLLM
PI + remote provider
PI + external sandbox
```

它们可能提供不同的 usage、网络控制和恢复保证。因此 Profile 描述的是
`Runtime + deployment` 的真实组合。

`auditCompleteness` 不控制是否允许执行，它表达事件与审计的完整程度。当前 Pi
Profile 使用 `PARTIAL`，因为控制面没有声称已捕获 Pi 的全部原始内部事件。

### 2.3 required 和 optional 为什么必须分开

```ts
export interface CapabilityRequirement {
    readonly required: readonly RuntimeCapability[];
    readonly optional: readonly RuntimeCapability[];
}

export function validateRuntimeCapabilities(
    profile: RuntimeCapabilityProfile,
    requirement: CapabilityRequirement,
): CapabilityValidation {
    const supported = new Set(profile.supported);
    const required = uniqueCapabilities(requirement.required, "required");
    const optional = uniqueCapabilities(requirement.optional, "optional");
    const missingRequired = required.filter((item) => !supported.has(item));
    const missingOptional = optional.filter((item) => !supported.has(item));

    return Object.freeze({
        accepted: missingRequired.length === 0,
        missingRequired: Object.freeze(missingRequired),
        missingOptional: Object.freeze(missingOptional),
    });
}
```

两类能力对应不同安全语义：

- required 缺失：执行保证不成立，必须在 Runtime 前拒绝；
- optional 缺失：主任务仍能安全执行，但必须留下 `DEGRADED` 证据。

默认 Pi 模板将 `TOOL_INTERCEPTION` 和 `SIDE_EFFECT_EVIDENCE` 设为 required，因为
没有它们就无法兑现工具治理和安全恢复；将 `MODEL_USAGE` 设为 optional，因为 usage
不完整会降低观测质量，却不一定让执行本身不安全。

### 2.4 默认 Pi 能力声明

```ts
export function createPiCapabilityProfile(
    id: string,
    deploymentKey: string,
    reportedAt = new Date().toISOString(),
): RuntimeCapabilityProfile {
    return createRuntimeCapabilityProfile({
        id,
        runtimeKind: "PI",
        deploymentKey,
        supported: [
            "SESSION_CREATE",
            "SESSION_RESUME",
            "INTERRUPT",
            "WORKSPACE_REUSE",
            "TOOL_INTERCEPTION",
            "TOOL_RESULT_REUSE",
            "SIDE_EFFECT_EVIDENCE",
            "EXTERNAL_SANDBOX",
            "MODEL_USAGE",
            "MODEL_EVENTS",
        ],
        auditCompleteness: "PARTIAL",
        reportedAt,
    });
}
```

注意没有声明：

- `SESSION_FORK`；
- `CROSS_HOST_RESUME`；
- `NATIVE_SANDBOX`；
- `RAW_RUNTIME_EVENTS`。

这不是功能遗漏，而是“不对尚未证明的保证撒谎”。

### 2.5 输入、输出和消费者

```text
PiAdapter.getCapabilityProfile()
  → DefaultPiControlPlane 持久化 Profile
  → HarnessInstance.capabilityProfileId
  → ManagedAgentRuntime 读取 Profile
  → validateRuntimeCapabilities
  → REJECTED / DEGRADED / APPLIED
```

对应测试：

- `tests/runtime/runtime-capability.test.ts`
- 端到端测试中的“缺少强制能力时拒绝”场景。

### 2.6 读完检查

你现在应该能回答：

1. 为什么 Capability 属于部署组合，而不是 Template？
2. 为什么 `MODEL_USAGE` 可以 optional，而 `TOOL_INTERCEPTION` 通常必须 required？
3. 能力拒绝应该发生在 Sandbox 创建之前还是之后？为什么？

---

## 3. 第二读：HarnessInstance

源码：[`src/instances/harness-instance.ts`](../src/instances/harness-instance.ts)

### 3.1 Instance 不是 Session，也不是 Run

三个对象的区别是：

| 对象 | 表达什么 | 生命周期 |
| --- | --- | --- |
| HarnessInstance | 受控制面管理的执行环境 | 可承载多个 Session/Run |
| HarnessSession | Harness 侧对话关系 | 可包含多个 Run |
| AgentRun | 一次用户任务 | 从 QUEUED 到终态 |

Instance 把模板、能力和运行环境连接起来：

```ts
export interface HarnessInstance {
    readonly id: string;
    readonly tenantId: string;
    readonly templateVersionId: string;
    readonly capabilityProfileId: string;
    readonly runtimeKind: RuntimeKind;
    readonly desiredState: "RUNNING" | "STOPPED";
    readonly actualState: HarnessInstanceActualState;
    readonly failureReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}
```

### 3.2 desiredState 与 actualState 为什么分开

`desiredState` 表示控制面的期望：希望这个 Instance 运行还是停止。

`actualState` 表示观测到的事实：它正在准备、可用、正在执行、已经停止或已经失败。

如果只有一个 `status`，将来异步 Sandbox Provider 或远端 Runtime 启动时，就无法表达：

```text
desiredState = RUNNING
actualState  = PROVISIONING
```

这种差异正是控制面需要持续协调的对象。

### 3.3 状态机

```ts
const actualTransitions = {
    PROVISIONING: ["READY", "FAILED", "STOPPED"],
    READY: ["ACTIVE", "FAILED", "STOPPED"],
    ACTIVE: ["READY", "FAILED", "STOPPED"],
    STOPPED: ["PROVISIONING"],
    FAILED: ["PROVISIONING", "STOPPED"],
} as const;
```

当前正常执行路径是：

```text
PROVISIONING → READY → ACTIVE → READY
```

Sandbox 丢失路径是：

```text
ACTIVE → FAILED
```

状态只能通过领域函数转换：

```ts
export function transitionHarnessInstance(
    instance: HarnessInstance,
    actualState: HarnessInstanceActualState,
    updatedAt: string,
    failureReason: string | null = null,
): HarnessInstance {
    if (!actualTransitions[instance.actualState].includes(actualState)) {
        throw new Error(
            `非法 HarnessInstance 状态转换：${instance.actualState} -> ${actualState}`,
        );
    }
    if ((actualState === "FAILED") !== (failureReason !== null)) {
        throw new Error("FAILED Instance 必须且只能携带 failureReason");
    }

    return Object.freeze({
        ...instance,
        actualState,
        failureReason,
        updatedAt,
    });
}
```

这里有两个关键不变量：

1. 禁止调用方任意跳转状态；
2. `FAILED` 必须带原因，非 `FAILED` 状态不能残留旧失败原因。

第二条避免出现 `READY + failureReason` 这种自相矛盾的数据。

对应测试：`tests/instances/harness-instance.test.ts`。

### 3.4 读完检查

1. 为什么 Sandbox LOST 修改的是 Instance，而普通模型调用失败通常只结束 Attempt？
2. 为什么 `ACTIVE → PROVISIONING` 是非法的？
3. `HarnessInstance` 为什么引用 TemplateVersion，而不是只引用可变 Template？

---

## 4. 第三读：RunAttempt

源码：[`src/runs/run-attempt.ts`](../src/runs/run-attempt.ts)

### 4.1 Run 和 Attempt 的根本区别

Run 表示用户的逻辑目标，例如“审查这个仓库”。Attempt 表示实现该目标的一次实际
执行。一个 Run 可能经历：

```text
Attempt #1 START  → Sandbox LOST → INTERRUPTED
Attempt #2 RESUME → SUCCEEDED
```

如果只在 Run 上覆盖 `sandboxId`、`policyId` 和 `runtimeSessionRef`，第一次执行的证据
会被第二次恢复覆盖。因此这些事实必须进入追加式 Attempt。

### 4.2 Attempt 固定哪些证据

```ts
export interface RunAttempt {
    readonly id: string;
    readonly runId: string;
    readonly attemptNumber: number;
    readonly kind: "START" | "RESUME";
    readonly instanceId: string;
    readonly templateVersionId: string;
    readonly capabilityProfileId: string;
    readonly policySnapshotId: string | null;
    readonly sandboxId: string | null;
    readonly status: RunAttemptStatus;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly failureReason: string | null;
}
```

这些引用回答了一次执行的六个审计问题：

| 字段 | 回答的问题 |
| --- | --- |
| attemptNumber/kind | 这是第几次，是启动还是恢复？ |
| instanceId | 在哪个受管执行环境中运行？ |
| templateVersionId | 使用了哪份不可变期望配置？ |
| capabilityProfileId | 执行时控制面相信 Runtime 有哪些能力？ |
| policySnapshotId | 最终强制执行的是哪份策略交集？ |
| sandboxId | 实际使用了哪个执行环境？ |

### 4.3 为什么 PENDING 可以直接 REJECTED

Attempt 在 Runtime 启动前就创建，因为“尝试过但被能力门拒绝”本身也是一次控制面
事实。因此状态允许：

```text
PENDING → REJECTED
PENDING → FAILED       // 例如 Sandbox 创建失败
PENDING → RUNNING → SUCCEEDED / FAILED / INTERRUPTED
```

创建和完成逻辑：

```ts
export function createRunAttempt(input: ...): RunAttempt {
    if (!Number.isInteger(input.attemptNumber) || input.attemptNumber <= 0) {
        throw new Error("attemptNumber 必须为正整数");
    }
    return Object.freeze({
        ...input,
        status: "PENDING",
        startedAt: null,
        finishedAt: null,
        failureReason: null,
    });
}

export function finishRunAttempt(
    attempt: RunAttempt,
    status: "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "REJECTED",
    finishedAt: string,
    failureReason: string | null = null,
): RunAttempt {
    if (attempt.status !== "PENDING" && attempt.status !== "RUNNING") {
        throw new Error(`Attempt 已经结束：${attempt.id}`);
    }
    if ((status === "FAILED" || status === "REJECTED")
        !== (failureReason !== null)) {
        throw new Error(`${status} Attempt 必须且只能携带 failureReason`);
    }
    return Object.freeze({ ...attempt, status, finishedAt, failureReason });
}
```

`REJECTED` 和 `FAILED` 的差别：

- REJECTED：控制面在执行前明确判断保证不成立，例如缺少 required capability；
- FAILED：本来允许执行，但准备或运行过程发生错误，例如 Sandbox Provider 创建失败。

对应测试：`tests/runs/run-attempt.test.ts`。

### 4.4 读完检查

1. 为什么 Attempt 在能力校验前创建，而不是 Runtime start 后创建？
2. 为什么恢复不应该覆盖旧 Attempt？
3. `INTERRUPTED` 为什么不强制 failureReason，而 `FAILED` 必须有？

---

## 5. 第四读：DefaultPiControlPlane

源码：[`src/control-plane/default-pi-control-plane.ts`](../src/control-plane/default-pi-control-plane.ts)

### 5.1 它是迁移桥，不是最终的模板管理 API

Stage 0 的调用方只提交：

```ts
{
    tenantId,
    harnessSessionId,
    userInput,
    workspacePath,
}
```

如果 Stage 1 直接要求所有调用方同时提供 TemplateVersion、Instance 和 CapabilityProfile，
会一次性推翻 HTTP API、应用测试和恢复链。`DefaultPiControlPlane` 的作用是把旧输入
解析成正式控制面绑定：

```ts
export interface RunControlBinding {
    readonly templateVersionId: string;
    readonly harnessInstanceId: string;
}
```

`RunService.createQueuedRun()` 在持久化 Run 前调用它：

```ts
const controlBinding = this.controlBindingResolver?.resolve(input);

const run: AgentRun = {
    // 原有字段
    ...(controlBinding ?? {}),
};
```

因此正式 Composition Root 创建的每个新 Run 都会固定控制面引用，而直接构造
`RunService` 的旧单元测试仍可不注入 Resolver，保护 Stage 0 兼容性。

### 5.2 resolve 的实际步骤

第一步，保存 Pi 部署能力：

```ts
this.capabilities.save(this.profile);
```

第二步，按 Tenant 生成稳定默认 ID：

```ts
const suffix = encodeURIComponent(input.tenantId);
const templateId = `default-pi-template:${suffix}`;
const templateVersionId = `default-pi-template-version:${suffix}:1`;
const instanceId = `default-pi-instance:${suffix}`;
```

这样不同 Tenant 不会错误共享同一个 Template 或 Instance。

第三步，首次使用时发布不可变模板版本：

```ts
this.templates.publishVersion(templateId, createPiTemplateVersion({
    id: templateVersionId,
    templateId,
    version: 1,
    provider: this.config.provider,
    modelId: this.config.modelId,
    tools: this.config.tools,
    skills: [],
    requiredCapabilities: [
        "SESSION_CREATE",
        "INTERRUPT",
        "TOOL_INTERCEPTION",
        "SIDE_EFFECT_EVIDENCE",
        "EXTERNAL_SANDBOX",
    ],
    optionalCapabilities: [
        "SESSION_RESUME",
        "MODEL_USAGE",
        "MODEL_EVENTS",
    ],
    createdAt: now,
}));
```

第四步，首次使用时创建 Instance，并从 `PROVISIONING` 转到 `READY`：

```ts
instance = createHarnessInstance({
    id: instanceId,
    tenantId: input.tenantId,
    templateVersionId,
    capabilityProfileId: this.profile.id,
    runtimeKind: "PI",
    createdAt: now,
});
this.instances.create(instance);
const ready = transitionHarnessInstance(instance, "READY", now);
this.instances.update(ready, instance.actualState);
```

第五步，创建或校验 Session：

```ts
const existingSession = this.sessions.get(input.harnessSessionId);
if (existingSession === null) {
    this.sessions.create(createHarnessSession({
        id: input.harnessSessionId,
        tenantId: input.tenantId,
        instanceId: instance.id,
        createdAt: now,
    }));
} else if (
    existingSession.tenantId !== input.tenantId
    || existingSession.instanceId !== instance.id
) {
    throw new Error("HarnessSession 归属与本次 Run 不匹配");
}
```

这个校验防止调用方用相同 sessionId 穿越 Tenant 或 Instance 边界。

### 5.3 为什么修改模板不影响已排队 Run

Run 保存的是 `templateVersionId`，不是“当前最新模板”。排队后即使发布 v2，执行时
`ManagedAgentRuntime` 仍按 Run 上固定的 v1 ID 加载。因此版本解析发生在提交时，
而不是开始执行时。

对应端到端测试：`排队后发布新模板版本不会改变 Run 已固定的版本证据`。

### 5.4 读完检查

1. 为什么默认对象按 Tenant 创建，而不是全平台共享？
2. 为什么 Resolver 必须在 `RunStore.create()` 之前调用？
3. 为什么这个类是兼容入口，而不是最终用户直接操作的 CRUD Service？

---

## 6. 第五读：EffectivePolicy

源码：[`src/policies/effective-policy.ts`](../src/policies/effective-policy.ts)

### 6.1 策略系统要保证“越叠加越严格”

有效策略由五个来源共同约束：

```text
Platform ∩ Tenant ∩ Template ∩ Workspace ∩ Run
```

任何下层都不能放宽上层限制。例如：

```text
Platform tools = [read, write, bash]
Tenant   tools = [read, write]
Template tools = [read, bash]
Run      tools = [read]

Effective tools = [read]
```

### 6.2 约束数据结构

```ts
export interface PolicyConstraints {
    readonly allowedTools: readonly string[] | null;
    readonly allowedSkills: readonly string[] | null;
    readonly allowedModels: readonly string[] | null;
    readonly workspaceRoots: readonly string[] | null;
    readonly allowNetwork: boolean;
    readonly allowProcess: boolean;
    readonly allowedSecrets: readonly string[] | null;
    readonly resourceLimits: {
        readonly cpuCores: number | null;
        readonly memoryMiB: number | null;
        readonly diskMiB: number | null;
    };
}
```

必须区分：

- `null`：这一层不增加限制；
- `[]`：这一层明确不允许任何值。

如果混淆两者，默认 `unrestrictedPolicy` 就可能意外禁止全部工具。

### 6.3 五层完整性校验

```ts
const kinds = new Set(input.layers.map((layer) => layer.kind));
for (const kind of [
    "PLATFORM", "TENANT", "TEMPLATE", "WORKSPACE", "RUN",
] as const) {
    if (!kinds.has(kind)) {
        throw new Error(`缺少策略层：${kind}`);
    }
}
```

即使某一层当前没有额外限制，也必须显式放入一份 unrestricted layer。这样历史快照
能证明“这一层被计算过且没有限制”，而不是无法区分“确实无限制”和“程序忘了加载”。

### 6.4 各类权限如何求交集

```ts
function intersectConstraints(left, right): PolicyConstraints {
    return {
        allowedTools: intersectValues(left.allowedTools, right.allowedTools),
        allowedSkills: intersectValues(left.allowedSkills, right.allowedSkills),
        allowedModels: intersectValues(left.allowedModels, right.allowedModels),
        workspaceRoots: intersectRoots(left.workspaceRoots, right.workspaceRoots),
        allowNetwork: left.allowNetwork && right.allowNetwork,
        allowProcess: left.allowProcess && right.allowProcess,
        allowedSecrets: intersectValues(left.allowedSecrets, right.allowedSecrets),
        resourceLimits: {
            cpuCores: minimum(left.resourceLimits.cpuCores,
                              right.resourceLimits.cpuCores),
            memoryMiB: minimum(left.resourceLimits.memoryMiB,
                               right.resourceLimits.memoryMiB),
            diskMiB: minimum(left.resourceLimits.diskMiB,
                             right.resourceLimits.diskMiB),
        },
    };
}
```

规则可以总结为：

| 约束 | 合并规则 | 原因 |
| --- | --- | --- |
| Tool/Skill/Model/Secret | 集合交集 | 任何层拒绝都不能被下层重新允许 |
| allowNetwork/allowProcess | 逻辑 AND | 任一层禁止则最终禁止 |
| CPU/内存/磁盘 | 最小非 null 值 | 最严格预算胜出 |
| Workspace roots | 保留更窄的包含路径 | 子目录比父目录更严格 |

Workspace 判断使用解析后的绝对路径和路径分隔符：

```ts
export function isWithin(path: string, root: string): boolean {
    const resolvedPath = resolve(path);
    const resolvedRoot = resolve(root);
    return resolvedPath === resolvedRoot
        || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}
```

附加 `${sep}` 可以避免把 `/tmp/workspace-evil` 错误当成 `/tmp/workspace` 的子目录。

### 6.5 Snapshot 为什么保存输入层和计算结果

```ts
export interface EffectivePolicySnapshot extends PolicyConstraints {
    readonly id: string;
    readonly runId: string;
    readonly tenantId: string;
    readonly templateVersionId: string;
    readonly layers: readonly PolicyLayer[];
    readonly createdAt: string;
}
```

如果只保存结果 `[read]`，无法解释是谁禁止了 `write`。保存五层输入后，审计可以回答：

```text
write 被拒绝
  → Effective allowedTools 中不存在
  → Tenant layer 只允许 read
  → 决策使用 snapshot X
```

对应测试：

- `tests/policies/effective-policy.test.ts`
- `tests/policies/policy-compilation.test.ts`

### 6.6 读完检查

1. `null` 与 `[]` 分别代表什么？
2. 为什么有效策略不能使用“后写覆盖前写”？
3. 为什么即使 Platform 当前无限制，也必须把 PLATFORM layer 放进快照？

---

## 7. 第六读：ManagedAgentRuntime

源码：[`src/runtime/managed-agent-runtime.ts`](../src/runtime/managed-agent-runtime.ts)

这是 Stage 1–2 最核心的文件。前面五章是在定义事实和规则；这个类负责把它们真正
放进 Runtime 调用路径。

### 7.1 装饰器结构

```text
RunService
  → ManagedAgentRuntime
      → inner AgentRuntime
          → PiAdapter 或测试 FakeAgentRuntime
```

构造函数注入所有控制面依赖：

```ts
constructor(
    private readonly inner: AgentRuntime,
    private readonly runs: RunStore,
    private readonly templates: HarnessTemplateStore,
    private readonly instances: HarnessInstanceStore,
    private readonly sessions: HarnessSessionStore,
    private readonly capabilities: RuntimeCapabilityProfileStore,
    private readonly attempts: RunAttemptStore,
    private readonly policies: EffectivePolicyStore,
    private readonly policyRegistry: PolicyRegistry,
    private readonly sandbox: SandboxProvider,
) {
    this.sandbox.subscribe((event) => this.onSandboxFailure(event));
}
```

它没有修改 PiAdapter 的通用 `AgentRuntime` 合同，而是在外层组合能力。这让测试 Fake、
未来 Claude Adapter 和其他 Runtime 都可以被相同控制面包装。

### 7.2 兼容入口

```ts
start(request: RuntimeStartRequest): Promise<void> {
    if (!hasControlBinding(request)) return this.inner.start(request);
    return this.execute("START", request, (managed) => this.inner.start(managed));
}
```

直接 Runtime 单元测试没有 Template/Instance 绑定时会透传给 inner。正式 Composition
Root 创建的 Run 一定有绑定，因此会进入受管路径。这是有意识的渐进迁移边界。

### 7.3 第一道门：引用和 Tenant 归属

```ts
const run = this.runs.get(request.run.runId);
if (
    run === null
    || run.templateVersionId === undefined
    || run.harnessInstanceId === undefined
) throw new Error(`Run 缺少控制面绑定：${request.run.runId}`);

const template = this.templates.getVersion(run.templateVersionId);
const instance = this.instances.get(run.harnessInstanceId);
const session = this.sessions.get(run.harnessSessionId);

if (
    instance.tenantId !== run.tenantId
    || instance.templateVersionId !== template.id
    || session.tenantId !== run.tenantId
    || session.instanceId !== instance.id
) throw new Error(`Run 控制面归属不一致：${run.id}`);
```

这里不相信调用请求携带的对象关系，而是重新从数据库读取并验证。它防止：

- Tenant A 的 Run 引用 Tenant B 的 Instance；
- Instance 使用的 TemplateVersion 与 Run 固定版本不同；
- Session 属于另一个 Instance。

### 7.4 先保存 Snapshot，再创建 Attempt

```ts
const snapshot = computeEffectivePolicy({
    id: crypto.randomUUID(),
    runId: run.id,
    tenantId: run.tenantId,
    templateVersionId: template.id,
    layers: this.policyLayers(run, template.spec),
    createdAt: now,
});
this.policies.saveSnapshot(snapshot);

let attempt = createRunAttempt({
    id: crypto.randomUUID(),
    runId: run.id,
    attemptNumber: this.attempts.nextAttemptNumber(run.id),
    kind,
    instanceId: instance.id,
    templateVersionId: template.id,
    capabilityProfileId: profile.id,
    policySnapshotId: snapshot.id,
    sandboxId: null,
    createdAt: now,
});
this.attempts.create(attempt);
```

顺序不能随意交换。Attempt 从创建时就绑定 Snapshot，因此后面的能力拒绝、模型拒绝
或 Sandbox 创建失败都有完整策略证据。

### 7.5 第二道门：Capability

```ts
const validation = validateRuntimeCapabilities(profile, {
    required: template.spec.requiredCapabilities ?? [],
    optional: template.spec.optionalCapabilities ?? [],
});

if (!validation.accepted) {
    const reason =
        `Runtime 缺少强制能力：${validation.missingRequired.join(",")}`;
    this.saveCompilation(snapshot.id, "REJECTED", null, [reason], now);
    const rejected = finishRunAttempt(attempt, "REJECTED", now, reason);
    this.attempts.update(rejected, attempt.status);
    throw new Error(reason);
}
```

这段发生在 `sandbox.create()` 和 `inner.start()` 之前，所以强制能力缺失时不会产生
真实执行或副作用。

optional 缺失不会拒绝，而是：

```ts
const degradations = validation.missingOptional.map(
    (item) => `缺少非关键能力：${item}`,
);
this.saveCompilation(
    snapshot.id,
    degradations.length === 0 ? "APPLIED" : "DEGRADED",
    compiled,
    degradations,
    now,
);
```

### 7.6 第三道门：Policy Compiler

```ts
compiled = compilePiPolicy(template.spec, snapshot);
```

Compiler 输出的是 Pi 可以直接使用的配置，而不是抽象策略：

```ts
{
    runtimeKind: "PI",
    provider,
    modelId,
    tools,
    skills,
    policySnapshotId,
}
```

模型不在 allowlist 时，Compiler 抛错，Attempt 变成 `REJECTED`。这证明策略不是只存
数据库，而是决定 Runtime 是否能开始。

### 7.7 第四道门：Sandbox

```ts
const handle = await this.sandbox.create({
    id: sandboxId,
    runId: run.id,
    instanceId: instance.id,
    workspacePath: run.workspacePath,
    policy: snapshot,
});
```

只有 Sandbox 创建成功，Attempt 才进入 RUNNING，Instance 才进入 ACTIVE：

```ts
attempt = startRunAttempt(attempt, now, snapshot.id, handle.id);
this.attempts.update(attempt, "PENDING");

const activeInstance = transitionHarnessInstance(instance, "ACTIVE", now);
this.instances.update(activeInstance, instance.actualState);
```

这保证 `ACTIVE` 表示受管执行环境已经准备好且确实开始执行，而不是“控制面准备调用”。

### 7.8 把编译结果交给 inner Runtime

```ts
const managedRequest = {
    ...request,
    execution: {
        attemptId: attempt.id,
        policySnapshotId: snapshot.id,
        sandboxId: handle.id,
        runtimeConfig: compiled,
    },
} as T;

await invoke(managedRequest);
```

`RuntimeExecutionContext` 是控制面到 Adapter 的执行合同。PiAdapter 不需要重新理解
五层策略，只消费已经编译好的 Model、Tool 和 Skill 配置。

### 7.9 RuntimeEvent 如何反向更新控制面

ManagedAgentRuntime 订阅 inner 事件：

```ts
if (event.type === "agent_started" || event.type === "agent_resumed") {
    this.sessions.update(bindRuntimeSession(
        current,
        event.runtimeSessionRef,
        event.timestamp,
    ));
} else if (event.type === "agent_completed") {
    terminal = "SUCCEEDED";
} else if (event.type === "agent_failed") {
    terminal = "FAILED";
    terminalReason = event.message;
} else if (event.type === "agent_interrupted") {
    terminal = "INTERRUPTED";
}
```

注意 Run 状态仍由外层 `RunService + RuntimeEventBridge` 更新；这里专门维护 Session、
Attempt、Sandbox 和 Instance。这避免一个类同时拥有所有状态机。

### 7.10 finally 为什么重要

```ts
finally {
    unsubscribe();
    this.activeBySandboxId.delete(handle.id);
    await this.sandbox.terminate(handle.id);

    const currentInstance = this.instances.get(instance.id);
    if (currentInstance?.actualState === "ACTIVE") {
        const ready = transitionHarnessInstance(
            currentInstance,
            "READY",
            new Date().toISOString(),
        );
        this.instances.update(ready, currentInstance.actualState);
    }
}
```

无论成功、Runtime 抛错还是中断，都必须：

- 取消订阅；
- 清理 Sandbox 到 Attempt 的内存索引；
- 终止 Sandbox 并销毁 Secret；
- 如果 Instance 没有因故障进入 FAILED，则恢复 READY。

### 7.11 Sandbox LOST 如何收敛

```ts
private onSandboxFailure(event: SandboxLifecycleEvent): void {
    const active = this.activeBySandboxId.get(event.sandboxId);
    if (active === undefined) return;

    // Instance ACTIVE → FAILED
    // Attempt RUNNING → INTERRUPTED
    // 向 RunService 发出 agent_interrupted
    this.emit({
        type: "agent_interrupted",
        runId: event.runId,
        timestamp: event.timestamp,
    });
    void this.inner.interrupt(event.runId).catch(() => undefined);
}
```

`emit(agent_interrupted)` 让已有 RunService 事件链把 Run 转成 INTERRUPTED；同时调用
inner interrupt 停止实际 Agent。这样控制面状态和真实执行共同收敛。

### 7.12 读完检查

1. ManagedAgentRuntime 与 PiAdapter 的职责边界是什么？
2. 为什么 Run 状态不直接在 ManagedAgentRuntime 中更新？
3. 能力拒绝、策略拒绝和 Sandbox 创建失败分别对应什么 Attempt 状态？
4. 为什么 Snapshot 必须早于 Attempt 保存？

---

## 8. 第七读：ToolPolicyGuard

源码：[`src/policies/tool-policy-guard.ts`](../src/policies/tool-policy-guard.ts)

相邻源码：[`src/tools/tool-gateway.ts`](../src/tools/tool-gateway.ts)

### 8.1 为什么必须在 ToolGateway 最外层检查

ToolGateway 原有顺序是：

```text
查历史 → PREPARED → 真实工具 → SUCCEEDED/FAILED + Checkpoint
```

Stage 2 把策略检查放到最前面：

```ts
async execute(input, invokeTool): Promise<unknown> {
    // 必须先于 PREPARED 和 invokeTool
    this.policyGuard?.assertAllowed(input);

    const history = this.store.getByToolCall(
        input.runId,
        input.toolCallId,
    );
    // 后续原有幂等和 Checkpoint 流程
}
```

如果先写 PREPARED 再拒绝，就会留下“工具可能已经发生副作用”的恢复证据，导致重启
恢复错误地要求人工处理。策略拒绝不是执行失败，它意味着执行根本不应该开始。

### 8.2 Snapshot 必须属于当前 Run

```ts
const snapshot = this.policies.getSnapshot(input.policySnapshotId);
if (snapshot === null || snapshot.runId !== input.runId) {
    throw new Error(`找不到 Run 的有效策略快照：${input.runId}`);
}
```

不能只按 Snapshot ID 加载后直接使用，否则调用方可能把另一个 Tenant/Run 的宽松
Snapshot 放进本次请求。

### 8.3 三类拒绝

第一类，工具名不允许：

```ts
if (
    snapshot.allowedTools !== null
    && !snapshot.allowedTools.includes(input.toolName)
) {
    denial = `策略不允许工具：${input.toolName}`;
}
```

第二类，本地 Provider 无法证明 bash 满足进程、网络或 Workspace 约束：

```ts
else if (
    input.toolName === "bash"
    && (
        !snapshot.allowProcess
        || !snapshot.allowNetwork
        || snapshot.workspaceRoots !== null
    )
) {
    denial = ...;
}
```

这里采用保守拒绝，因为解析任意 shell 字符串无法可靠证明它不会访问网络或越过
Workspace。允许一个无法证明安全的 bash 会让策略成为纸面配置。

第三类，文件路径越界：

```ts
const path = toolPath(input.arguments, input.workspacePath);
if (
    path !== null
    && snapshot.workspaceRoots !== null
    && !snapshot.workspaceRoots.some((root) => isWithin(path, root))
) {
    denial = `工具路径超出 Workspace 策略：${path}`;
}
```

### 8.4 允许和拒绝都要持久化

```ts
this.policies.recordToolDecision({
    id: crypto.randomUUID(),
    snapshotId: snapshot.id,
    runId: input.runId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    action: denial === null ? "ALLOW" : "DENY",
    reason: denial ?? "有效策略允许工具调用",
    decidedAt: new Date().toISOString(),
});

if (denial !== null) throw new Error(denial);
```

只记录拒绝无法证明成功调用经过了策略；只记录允许又无法解释为什么真实工具没有
发生。两种决策都持久化才能形成完整审计链。

### 8.5 与幂等恢复的关系

策略门通过后，Stage 0 ToolGateway 逻辑仍然生效：

- 已 SUCCEEDED：复用历史结果；
- 已 FAILED：返回确定失败；
- PREPARED + READ_ONLY：允许自动重放；
- PREPARED + 未知副作用：拒绝自动重放；
- 首次成功：结果与 Checkpoint 原子提交。

所以 Stage 2 没有替换恢复机制，而是在它前面加了一道可解释的授权门。

### 8.6 读完检查

1. 为什么拒绝不能生成 ToolExecution PREPARED？
2. 为什么 Guard 必须验证 Snapshot.runId？
3. 为什么 ManagedLocal 下受 Workspace 限制的 bash 直接拒绝？

---

## 9. 第八读：ManagedLocalSandboxProvider

源码：[`src/sandbox/managed-local-sandbox.ts`](../src/sandbox/managed-local-sandbox.ts)

接口：[`src/sandbox/sandbox-provider.ts`](../src/sandbox/sandbox-provider.ts)

### 9.1 Provider 抽象的意义

```ts
export interface SandboxProvider {
    create(input: {
        id: string;
        runId: string;
        instanceId: string;
        workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle>;

    terminate(sandboxId: string): Promise<void>;
    subscribe(handler: (event: SandboxLifecycleEvent) => void): () => void;
}
```

控制面只依赖生命周期合同，不依赖 Docker、Kubernetes 或某个云 Sandbox API。以后
更换 Provider 时，上层仍然创建 Attempt、保存 Snapshot、响应 LOST，不需要重写
RunService。

### 9.2 当前实现诚实地承认边界

`ManagedLocalSandboxProvider` 不是容器。它负责：

- Workspace 路径校验；
- Sandbox 生命周期和持久化证据；
- Secret 按需获取与销毁；
- LOST 事件；
- 与 ToolGateway 共同执行文件、网络和进程的 fail-closed 边界。

它不声称提供内核级 CPU、内存和磁盘隔离：

```ts
if (Object.values(input.policy.resourceLimits)
    .some((value) => value !== null)) {
    throw new Error(
        "MANAGED_LOCAL 无法落实 CPU/内存/磁盘硬限制，拒绝执行",
    );
}
```

这是 Capability 原则在 Sandbox 层的体现：无法落实硬保证时拒绝，而不是保存配置后
照常运行。

### 9.3 Workspace 校验

```ts
if (
    input.policy.workspaceRoots !== null
    && !input.policy.workspaceRoots.some((root) =>
        isWithin(input.workspacePath, root))
) {
    throw new Error(
        `Sandbox Workspace 超出策略范围：${input.workspacePath}`,
    );
}
```

这里检查的是整个 Sandbox 的工作目录；具体文件工具仍由 ToolPolicyGuard 再检查
单次 path。二者分别保护环境边界和工具调用边界。

### 9.4 Secret 为什么只保存名字

```ts
const secretNames = input.policy.allowedSecrets ?? [];
const environment: Record<string, string> = {};

for (const name of secretNames) {
    const value = this.secrets.get(name);
    if (value === null) {
        throw new Error(`授权 Secret 不存在：${name}`);
    }
    environment[name] = value;
}
```

持久化记录只包含：

```ts
const provisioning: SandboxRecord = {
    // ...
    secretNames: Object.freeze([...secretNames]),
};
```

实际值进入私有内存 Map：

```ts
this.secretValues.set(input.id, Object.freeze(environment));
```

调用方通过回调式 Handle 访问：

```ts
withSecrets: <T>(callback) =>
    callback(this.secretValues.get(input.id) ?? Object.freeze({})),
```

数据库、SandboxRecord 和常规日志都不会包含 Secret 值。这里要准确理解当前保证：

- 回调 API 限制了 Secret 的正常获取入口；
- `terminate/lose` 后 Map 被删除，后续回调拿不到值；
- 受信任调用方仍然可以从回调返回或复制 Secret，当前实现不是机密计算环境；
- 当前 Pi 主路径还没有调用 `withSecrets` 将值注入某个工具子进程，因此目前证明的是
  “授权名称、按需取值、不落库、生命周期销毁”边界，不是完整进程级 Secret 注入。

未来容器 Provider 应把 Secret 直接注入受控工具进程或容器环境，并继续只向数据库
保存名称；不能为了方便把值放进 `RuntimeExecutionContext` 或 RunEvent。

### 9.5 生命周期

创建：

```text
写入 PROVISIONING → 更新 ACTIVE → 保存内存 Secret → 返回 Handle
```

正常结束：

```ts
async terminate(sandboxId: string): Promise<void> {
    const current = this.store.get(sandboxId);
    this.secretValues.delete(sandboxId);
    if (current === null || current.status === "TERMINATED") return;
    if (current.status !== "ACTIVE") return;
    this.store.update({
        ...current,
        status: "TERMINATED",
        updatedAt: new Date().toISOString(),
    }, current.status);
}
```

失联：

```ts
lose(sandboxId: string, reason: string): void {
    const current = this.store.get(sandboxId);
    if (current === null || current.status !== "ACTIVE") return;

    this.secretValues.delete(sandboxId);
    this.store.update({
        ...current,
        status: "LOST",
        failureReason: reason,
    }, current.status);

    for (const handler of this.handlers) {
        handler({
            sandboxId,
            runId: current.runId,
            instanceId: current.instanceId,
            status: "LOST",
            reason,
            timestamp,
        });
    }
}
```

`lose()` 既是故障注入入口，也代表未来真实 Provider 失联回调的语义。

对应测试：`tests/sandbox/managed-local-sandbox.test.ts`。

### 9.6 读完检查

1. SandboxRecord 为什么能保存 Secret 名称但不能保存值？
2. Workspace 创建校验和 Tool path 校验为什么都需要？
3. 未来 Docker Provider 可以替换哪一层，哪些上层对象无需改变？

---

## 10. 第九读：PiAdapter

源码：[`src/runtime/pi-adapter.ts`](../src/runtime/pi-adapter.ts)

### 10.1 PiAdapter 的职责边界

PiAdapter 只负责两类翻译：

```text
Harness command → Pi SDK call
Pi SDK event     → RuntimeEvent
```

它不负责：

- 计算五层策略；
- 决定 Tenant 权限；
- 创建 Attempt；
- 管理 Sandbox 状态；
- 直接写 SQLite。

这些由 ManagedAgentRuntime 和 Store 负责。

### 10.2 Adapter 自己报告能力

```ts
getCapabilityProfile() {
    return createPiCapabilityProfile(
        `pi-capability:${this.config.provider}/${this.config.modelId}`,
        `${this.config.provider}/${this.config.modelId}`,
    );
}
```

Composition Root 优先使用显式注入的测试 Profile，否则读取 Adapter 报告：

```ts
capabilityProfile: dependencies.capabilityProfile
    ?? baseRuntime.getCapabilityProfile?.(),
```

### 10.3 配置来源发生了什么变化

旧直接调用使用进程配置：

```ts
private readonly config: PiAdapterConfig
```

受管调用优先使用本 Attempt 的编译结果：

```ts
const config = request.execution?.runtimeConfig ?? this.config;
const model = this.modelRuntime.getModel(
    config.provider,
    config.modelId,
);
```

这行 `??` 同时完成了两件事：

- 正式主路径使用 Effective Policy 编译结果；
- 旧 Adapter 单元测试保持兼容。

### 10.4 Tool 策略如何进入 Pi

Pi 内置工具名仍然是 `read/bash/edit/write`，但同名 `customTools` 会覆盖其 execute：

```ts
const customTools = this.createGatewayTools(
    runId,
    request.run.workspacePath,
    runtimeSessionRefHolder,
    config.tools,
    request.execution?.policySnapshotId,
);
```

包装上下文把策略快照传给 ToolGateway：

```ts
return createGatewayPiTools(
    toolNames,
    workspacePath,
    this.toolGatewayBinding.gateway,
    {
        runId,
        workspacePath,
        getPolicySnapshotId: () => policySnapshotId,
        getRuntimeSessionRef: () => { /* ... */ },
        getLastEventSequence: () =>
            this.toolGatewayBinding.getLastEventSequence(runId),
    },
);
```

因此模型看到熟悉的 Pi 工具，但真实调用路径变成：

```text
Pi tool execute
  → Gateway wrapper
  → PersistentToolPolicyGuard
  → ToolExecution 幂等/恢复
  → Pi 原始工具实现
```

### 10.5 Skill 策略如何进入 Pi

受管请求创建 Policy ResourceLoader：

```ts
const resourceLoader = request.execution === undefined
    ? undefined
    : this.createPolicyResourceLoader(
        request.run.workspacePath,
        request.execution.runtimeConfig.skills,
    );
```

真正过滤 Skill 的代码：

```ts
private createPolicyResourceLoader(
    workspacePath: string,
    skillNames: readonly string[],
): DefaultResourceLoader {
    const allowed = new Set(skillNames);
    return new DefaultResourceLoader({
        cwd: workspacePath,
        agentDir: join(homedir(), ".pi", "agent"),
        noSkills: allowed.size === 0,
        skillsOverride: (base) => ({
            ...base,
            skills: base.skills.filter(
                (skill) => allowed.has(skill.name),
            ),
        }),
    });
}
```

重点是它没有只把 Skill 名字记录到 Snapshot；过滤结果真实进入 Pi SDK 的资源加载器。

### 10.6 Session 创建与恢复

新建 Session：

```ts
const { session } = await createAgentSession({
    cwd: request.run.workspacePath,
    modelRuntime: this.modelRuntime,
    model,
    tools: [...config.tools],
    customTools,
    sessionManager: SessionManager.create(request.run.workspacePath),
    ...(resourceLoader === undefined ? {} : { resourceLoader }),
});
```

恢复 Session：

```ts
const sessionManager = SessionManager.open(
    request.checkpoint.runtimeSessionRef,
    undefined,
    request.run.workspacePath,
);
```

HarnessSession 保存的是 `runtimeSessionRef`，不是直接序列化 Pi 的内存 Session 对象。

### 10.7 事件翻译

Pi 事件被转换为稳定 RuntimeEvent：

| Pi 事件 | Harness RuntimeEvent |
| --- | --- |
| agent_start | agent_started / agent_resumed |
| message_start | model_started |
| message_update(text_delta) | text_delta |
| message_end | model_completed + usage |
| tool_execution_start | tool_started |
| tool_execution_end | tool_completed |
| agent_end | completed / failed / interrupted |

例如模型 usage 被转换为 Harness 自己的稳定结构：

```ts
this.emit({
    type: "model_completed",
    runId,
    timestamp,
    modelCallId,
    provider: piEvent.message.provider,
    model: piEvent.message.responseModel ?? piEvent.message.model,
    durationMs,
    stopReason: piEvent.message.stopReason,
    usage: {
        inputTokens: piEvent.message.usage.input,
        outputTokens: piEvent.message.usage.output,
        cacheReadTokens: piEvent.message.usage.cacheRead,
        cacheWriteTokens: piEvent.message.usage.cacheWrite,
        reasoningTokens: piEvent.message.usage.reasoning ?? null,
        totalTokens: piEvent.message.usage.totalTokens,
        cost: { /* 稳定字段映射 */ },
    },
});
```

Harness 持久化结构不直接依赖 Pi SDK 的事件类型，降低 SDK 升级对数据库的冲击。

### 10.8 清理与中断

执行结束总是：

```ts
finally {
    unsubscribe();
    this.sessionsByRunId.delete(runId);
    session.dispose();
}
```

中断通过当前 Run 对应的 Pi Session 执行：

```ts
async interrupt(runId: string): Promise<void> {
    const session = this.sessionsByRunId.get(runId);
    if (!session) {
        throw new Error(`没有找到正在运行的 Agent Session ${runId}`);
    }
    await session.abort();
}
```

### 10.9 读完检查

1. 为什么 PiAdapter 不应该读取 PolicyRegistry？
2. `request.execution?.runtimeConfig ?? this.config` 的兼容意义是什么？
3. Tool allowlist 和 Skill allowlist 分别通过什么 Pi SDK 扩展点落实？
4. 为什么持久化的是 runtimeSessionRef，而不是 AgentSession 对象？

---

## 11. 第十读：Stage 1–2 端到端测试

源码：
[`tests/integration/stage1-stage2-control-plane.e2e.test.ts`](../tests/integration/stage1-stage2-control-plane.e2e.test.ts)

测试不是最后才看的附属品。它定义了当前实现真正承诺什么，也揭示哪些能力仍然没有
宣称完成。

### 11.1 场景一：两个 Tenant 产生不同权限

Arrange：

```ts
registry.setTenantPolicy(
    "tenant-a",
    "tenant-a-readonly",
    policy(["read"], {
        allowNetwork: false,
        allowProcess: false,
    }),
);

registry.setTenantPolicy(
    "tenant-b",
    "tenant-b-editor",
    policy(["read", "write"], {
        allowNetwork: false,
        allowProcess: false,
    }),
);
```

Act：两个 Tenant 通过同一个 Composition 和同一个 Fake Runtime 提交 Run。

Assert：

```ts
expect(requestA?.execution?.runtimeConfig.tools).toEqual(["read"]);
expect(requestB?.execution?.runtimeConfig.tools).toEqual([
    "read",
    "write",
]);
```

这证明差异不是不同 Runtime 实例硬编码出来的，而是 Tenant Policy 经 Snapshot 和
Compiler 进入了每个执行请求。

同一测试还检查完整引用链：

```ts
expect(persisted?.templateVersionId).toBeDefined();
expect(persisted?.harnessInstanceId).toBeDefined();
expect(attempts[0]?.policySnapshotId).toBeDefined();
expect(attempts[0]?.sandboxId).toBeDefined();
expect(sandbox.status).toBe("TERMINATED");
```

### 11.2 场景二：被拒绝的工具没有副作用

测试使用计数器代表真实副作用：

```ts
let sideEffectCount = 0;

await expect(composition.toolGateway.execute({
    runId: runA.id,
    toolCallId: "denied-write",
    toolName: "write",
    policySnapshotId: snapshotA.id,
    // ...
}, async () => {
    sideEffectCount += 1;
    return "should-not-run";
})).rejects.toThrow("策略不允许工具：write");

expect(sideEffectCount).toBe(0);
expect(toolExecutionStore.getByToolCall(
    runA.id,
    "denied-write",
)).toBeNull();
```

这里同时证明：

- invokeTool 没有执行；
- 没有 PREPARED；
- DENY 决策已持久化。

### 11.3 场景三：模板版本固定

测试先用 CRITICAL 资源让 Run 留在队列，然后发布模板 v2：

```ts
expect(run.status).toBe("QUEUED");

templateStore.publishVersion(templateId, {
    version: 2,
    spec: { ...pinned.spec, modelId: "future-model" },
});
```

资源恢复后验证执行仍使用 v1：

```ts
expect(startRequest.run.templateVersionId).toBe(pinned.id);
expect(startRequest.execution?.runtimeConfig.modelId)
    .toBe("fake-model");
```

它证明排队时间不会造成配置漂移。

### 11.4 场景四：强制能力缺失

注入只支持 `SESSION_CREATE` 的 Profile：

```ts
capabilityProfile: createRuntimeCapabilityProfile({
    id: "limited-pi",
    runtimeKind: "PI",
    deploymentKey: "fake-provider/fake-model",
    supported: ["SESSION_CREATE"],
    auditCompleteness: "PARTIAL",
    reportedAt,
}),
```

验证：

```ts
expect(baseRuntime.startRequests).toHaveLength(0);
expect(attempt.status).toBe("REJECTED");
expect(attempt.sandboxId).toBeNull();
expect(attempt.policySnapshotId).toBe(snapshot.id);
expect(compilation.status).toBe("REJECTED");
```

这组断言把“执行前拒绝”拆成了五个可观测事实，而不是只断言抛出异常。

### 11.5 场景五：Sandbox LOST

`BlockingRuntime` 让 Run 保持运行状态，测试主动注入失联：

```ts
provider.lose(attempt.sandboxId!, "FAULT_INJECTION");
```

最后验证四个状态共同收敛：

```ts
expect(run.status).toBe("INTERRUPTED");
expect(attempt.status).toBe("INTERRUPTED");
expect(instance.actualState).toBe("FAILED");
expect(sandbox.status).toBe("LOST");
```

单独检查一个状态不够，因为控制面最危险的问题就是数据库状态和实际执行环境分裂。

### 11.6 其他配套测试

| 测试文件 | 证明的局部不变量 |
| --- | --- |
| `runtime/runtime-capability.test.ts` | required/optional 差异与重复能力拒绝 |
| `instances/harness-instance.test.ts` | Instance 合法转换和 FAILED 原因 |
| `runs/run-attempt.test.ts` | Attempt 终态不可重复结束、拒绝保留 Snapshot |
| `policies/effective-policy.test.ts` | 五层交集和缺层拒绝 |
| `policies/policy-compilation.test.ts` | 同一模板产生不同 Tool/Skill 配置、模型拒绝 |
| `sandbox/managed-local-sandbox.test.ts` | Secret 不落库、硬资源限制 fail closed |

### 11.7 读完检查

1. 哪个断言证明策略真的进入 Runtime，而不是只保存在 SQLite？
2. 哪两个断言共同证明被拒绝的工具没有发生副作用？
3. 为什么 Sandbox LOST 测试需要 BlockingRuntime？

---

## 12. 回头补读：Composition Root

源码：
[`src/app/create-harness-application.ts`](../src/app/create-harness-application.ts)

完成前十步后，再看组装入口会非常清楚。关键连接是：

```ts
const toolGateway = new ToolGateway(
    toolExecutionStore,
    new PersistentToolPolicyGuard(effectivePolicyStore),
);

const baseRuntime = dependencies.runtime
    ?? await createPiRuntime(config, modelRuntime, toolGateway, runStore);

const runtime = new ManagedAgentRuntime(
    baseRuntime,
    runStore,
    templateStore,
    instanceStore,
    sessionStore,
    capabilityStore,
    attemptStore,
    effectivePolicyStore,
    policyRegistry,
    sandboxProvider,
);

const controlPlane = new DefaultPiControlPlane(
    templateStore,
    instanceStore,
    sessionStore,
    capabilityStore,
    piConfig,
);

const runService = new RunService(runStore, runtime, controlPlane);
```

从这段可以看到三个关键包裹关系：

```text
RunService 使用 DefaultPiControlPlane 固定对象引用
RunService 调用 ManagedAgentRuntime，而不是直接调用 PiAdapter
PiAdapter 的工具经过带 PersistentToolPolicyGuard 的 ToolGateway
```

如果其中任一连接缺失，新对象就可能只存在于源码或数据库，而没有进入真实主路径。

---

## 13. 回头补读：数据库证据

源码：[`src/storage/migrations.ts`](../src/storage/migrations.ts)

Migration v6 建立 Stage 1 证据：

```text
runtime_capability_profiles
harness_instances
harness_sessions
run_attempts
agent_runs.template_version_id
agent_runs.harness_instance_id
```

Migration v7 建立 Stage 2 证据：

```text
agent_runs.run_policy_json
effective_policy_snapshots
policy_compilations
tool_policy_decisions
sandboxes
```

最重要的关系是：

```text
AgentRun
  ├── template_version_id
  ├── harness_instance_id
  └── RunAttempt
        ├── capability_profile_id
        ├── policy_snapshot_id
        └── sandbox_id

EffectivePolicySnapshot
  ├── layers_json
  ├── effective_json
  ├── PolicyCompilation
  └── ToolPolicyDecision
```

旧 Run 的新增引用允许 NULL，是为了迁移已有 SQLite 数据；正式 Composition Root 创建
的新 Run 通过 DefaultPiControlPlane 保证引用存在。这个区别是数据库兼容策略，不是
新主路径允许绕过控制面。

---

## 14. 三条完整时序

### 14.1 正常执行

```text
1. submitRun
2. DefaultPiControlPlane.resolve
3. Run 固定 TemplateVersion / Instance
4. 资源准入 START
5. ManagedAgentRuntime 校验引用归属
6. 保存 EffectivePolicySnapshot
7. 创建 PENDING Attempt
8. Capability ACCEPTED
9. PolicyCompilation APPLIED/DEGRADED
10. Sandbox PROVISIONING → ACTIVE
11. Attempt PENDING → RUNNING
12. Instance READY → ACTIVE
13. PiAdapter 使用编译后的 Model/Tool/Skill
14. Runtime agent_completed
15. 事件同时送到 RunService 和 ManagedAgentRuntime 的订阅者
16. RunService 将 Run → COMPLETED；ManagedAgentRuntime 记录终态
17. inner Runtime 返回后，Attempt → SUCCEEDED
18. Sandbox → TERMINATED
19. Instance ACTIVE → READY
```

第 16 步两个订阅者的具体回调先后不属于公共合同；实现依靠各自状态机和幂等检查，
而不是依赖监听器顺序。真正必须保证的是：`inner Runtime` 返回后，Run、Attempt、
Sandbox 和 Instance 最终收敛到彼此一致的状态。

### 14.2 能力或策略拒绝

```text
1–7. 与正常路径相同，Snapshot 和 Attempt 已经保存
8. required capability 缺失，或模型不在 allowlist
9. PolicyCompilation → REJECTED
10. Attempt PENDING → REJECTED，并保存 reason
11. 不创建 Sandbox
12. 不调用 PiAdapter
13. RunService 捕获 Runtime 调用拒绝，将 Run → INTERRUPTED
```

Run 使用 `INTERRUPTED` 是沿用 Stage 0 的“Runtime 调用未完成，可进入恢复/处理流程”
语义；更具体的拒绝原因保存在 Attempt 和 PolicyCompilation 中。

### 14.3 Sandbox LOST

```text
1–13. 正常路径运行中
14. Sandbox Provider 发出 LOST
15. Sandbox → LOST，销毁 Secret
16. ManagedAgentRuntime 查找 activeBySandboxId
17. Instance ACTIVE → FAILED
18. Attempt RUNNING → INTERRUPTED
19. 发出 agent_interrupted
20. RunService 将 Run → INTERRUPTED
21. inner Runtime interrupt
22. finally 不把 FAILED Instance 错误恢复为 READY
```

---

## 15. 当前实现明确没有声称完成的内容

读代码时要同时理解边界：

- 没有 Claude Adapter，RuntimeKind 当前只有 PI；
- ManagedLocal 不是容器，不提供内核级资源隔离；
- CPU/内存/磁盘硬限制在 ManagedLocal 下会拒绝，不会假执行；
- bash 无法证明满足网络或 Workspace 约束时会拒绝；
- PolicyRegistry 当前是进程内策略来源，但每次执行的最终 Snapshot 会持久化；
- Secret Provider 已建立不落库和销毁边界，但当前 Pi 工具主路径尚未消费
  `SandboxHandle.withSecrets`，不能宣称已经完成容器/进程级 Secret 注入；
- 没有声称跨宿主机 Session 恢复；
- 没有执行 A6000 性能实验，因此没有新的资源收益结论；
- 没有进入 Stage 3、分层恢复扩展或异构 ResourcePool。

这些限制不妨碍 Stage 1–2 最小控制面语义完成，因为不支持的硬保证已经采用
fail closed，并且拒绝原因可以审计。

---

## 16. 建议的实际学习练习

完成阅读后，可以按难度依次做以下练习，不需要马上改生产代码。

### 练习一：手工推导策略

给五层策略分别设置 Tool、网络和内存限制，先在纸上计算结果，再运行：

```bash
bun test tests/policies/effective-policy.test.ts
```

### 练习二：追踪一个新 Run

从 `RunService.createQueuedRun()` 开始，逐个写出：

```text
TemplateVersion ID
Instance ID
Session ID
Run ID
Attempt ID
PolicySnapshot ID
Sandbox ID
RuntimeSessionRef
```

并标注每个 ID 第一次生成、第一次持久化和第一次被消费的位置。

### 练习三：解释零副作用拒绝

不看本文，自己解释为什么下面三个事实必须同时成立：

```text
sideEffectCount = 0
ToolExecution = null
ToolPolicyDecision = DENY
```

### 练习四：注入故障

阅读 `BlockingRuntime`，解释为什么普通 FakeRuntime 无法稳定测试 Sandbox LOST 的运行中
状态，然后运行：

```bash
bun test tests/integration/stage1-stage2-control-plane.e2e.test.ts
```

### 练习五：画出对象所有权

自己重画下面这张关系图，并为每条边写出对应数据库字段：

```text
Tenant
  └── Template
        └── TemplateVersion
              └── Instance ── CapabilityProfile
                    └── Session
                          └── Run
                                └── Attempt
                                      ├── EffectivePolicySnapshot
                                      └── Sandbox
```

---

## 17. 验收命令与当前结果

局部阅读时可以运行：

```bash
bun test tests/runtime/runtime-capability.test.ts
bun test tests/instances/harness-instance.test.ts
bun test tests/runs/run-attempt.test.ts
bun test tests/policies/effective-policy.test.ts
bun test tests/policies/policy-compilation.test.ts
bun test tests/sandbox/managed-local-sandbox.test.ts
bun test tests/integration/stage1-stage2-control-plane.e2e.test.ts
```

完整验收入口：

```bash
bun run verify:stage0
```

命令名称为了兼容已有工程入口仍叫 `verify:stage0`，但它会运行当前顶层全部测试，
包括 Stage 1–2。

2026-08-10 当前结果：

```text
184 pass
0 fail
690 expect() calls
严格 TypeScript：通过
Day 7 Fake 闭环：RESULT: PASS
```

## 18. 最终应该形成的系统认识

读完这组代码后，最重要的认识不是记住类名，而是理解四个原则：

1. **期望配置必须版本化。** Run 固定 TemplateVersion，排队和恢复期间不能漂移。
2. **保证必须先验证。** Capability、Policy 或 Sandbox 无法落实时，在副作用前拒绝。
3. **每次真实执行必须单独留证。** Attempt 固定能力、策略、Sandbox 和结果。
4. **策略必须进入执行点。** Model/Tool/Skill 进入 Pi，文件和副作用进入 ToolGateway，
   环境和 Secret 进入 Sandbox；只保存数据库不算完成。

这四点共同把原有“能运行的 Agent Runtime”提升为“可解释、可治理、可恢复的 Harness
控制面”。
