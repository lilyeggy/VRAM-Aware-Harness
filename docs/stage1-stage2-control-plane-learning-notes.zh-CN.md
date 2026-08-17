# Stage 1–2 控制面实现与学习笔记

本文对应 ADR 0007 路线图的 Stage 1 和 Stage 2，描述真实代码，而不是候选设计。

## 1. 完整执行链

```text
旧 submitRun 输入
  → DefaultPiControlPlane
      → Tenant 默认 HarnessTemplateVersion
      → HarnessInstance
      → HarnessSession
  → AgentRun 固定 templateVersionId / harnessInstanceId
  → 资源准入与公平队列
  → ManagedAgentRuntime
      → 计算五层 EffectivePolicySnapshot
      → 创建并绑定 RunAttempt
      → 校验 RuntimeCapabilityProfile
      → 编译 Pi Model / Tool / Skill 配置
      → 创建 ManagedLocal Sandbox
      → PiAdapter.start/resume
          → 所有 Pi 内置 Tool 经过 ToolGateway
      → 完成 Attempt / Sandbox / Instance 状态
```

旧 HTTP 和应用调用方不需要立即提供 Template/Instance ID。兼容入口按 Tenant 懒创建
默认对象，但正式应用创建的新 Run 一定写入不可变版本和 Instance 引用。直接构造
`RunService` 的旧单元测试仍可不启用控制面，用于保护 Stage 0 契约。

## 2. Stage 1 对象

### HarnessInstance

`HarnessInstance` 绑定 Tenant、TemplateVersion、Runtime 类型和能力声明。

```ts
export interface HarnessInstance {
    readonly id: string;
    readonly tenantId: string;
    readonly templateVersionId: string;
    readonly capabilityProfileId: string;
    readonly runtimeKind: "PI";
    readonly desiredState: "RUNNING" | "STOPPED";
    readonly actualState:
        | "PROVISIONING"
        | "READY"
        | "ACTIVE"
        | "STOPPED"
        | "FAILED";
    readonly failureReason: string | null;
}
```

Stage 2 使用的关键状态路径是：

```text
PROVISIONING → READY → ACTIVE → READY
                         └────→ FAILED（Sandbox 丢失）
```

### Session、Run、Attempt

- Session：Harness 管理的对话归属，可保存 Runtime Session 引用；
- Run：用户希望完成的逻辑任务；
- Attempt：Run 的一次真实 START 或 RESUME 尝试。

Attempt 保存本次执行真正使用的 Instance、TemplateVersion、CapabilityProfile、
EffectivePolicySnapshot 和 Sandbox，因此一次恢复不会覆盖第一次启动的证据。策略
快照在 Attempt 之前生成，Attempt 创建时立即绑定它；即使能力校验尚未通过，这次
`REJECTED` 尝试也仍然能沿 `policySnapshotId` 解释。

### RuntimeCapabilityProfile

能力使用细粒度集合表达，而不是单个 `supportsResume`：

```ts
type RuntimeCapability =
    | "SESSION_CREATE"
    | "SESSION_RESUME"
    | "INTERRUPT"
    | "WORKSPACE_REUSE"
    | "TOOL_INTERCEPTION"
    | "TOOL_RESULT_REUSE"
    | "SIDE_EFFECT_EVIDENCE"
    | "NATIVE_SANDBOX"
    | "EXTERNAL_SANDBOX"
    | "MODEL_USAGE"
    | "MODEL_EVENTS";
```

PiAdapter 报告自己的部署能力。TemplateVersion 分别声明 required 和 optional 能力：

- required 缺失：Attempt 记为 REJECTED，Runtime 和 Sandbox 都不会启动；
- optional 缺失：允许运行，但 PolicyCompilation 记为 DEGRADED，并保存原因。

## 3. Stage 2 五层策略

有效策略严格由以下五层交集产生：

```text
Platform ∩ Tenant ∩ Template ∩ Workspace ∩ Run
```

集合权限取交集，布尔权限取 AND，资源上限取最小值：

```ts
allowedTools = intersection(allLayers.allowedTools)
allowNetwork = everyLayer.allowNetwork
memoryMiB = min(allDeclaredMemoryLimits)
```

`null` 表示该层不额外限制，不表示空集合。空数组表示明确禁止全部。

每次 Attempt 都生成新的不可变 `EffectivePolicySnapshot`。快照保存全部输入层和最终
结果，避免将来策略修改后无法解释历史执行。

## 4. Pi Policy Compiler

Compiler 将控制面意图变成 Pi 的具体配置：

```ts
{
    provider,
    modelId,
    tools: effectiveToolIntersection,
    skills: effectiveSkillIntersection,
    policySnapshotId,
}
```

- Model 不在有效 allowlist：拒绝；
- Tool 取 Template 与有效策略的交集；
- Skill 通过 Pi `DefaultResourceLoader.skillsOverride` 真正过滤；
- 编译配置放进 `RuntimeStartRequest.execution`，PiAdapter 不再只读取进程级全局配置。

因此同一个 PiAdapter 可以为两个 Tenant 创建不同 Tool/Skill 配置的 Session。

## 5. ToolGateway 强制边界

策略校验发生在 `ToolExecution PREPARED` 和真实工具调用之前：

```text
Pi Tool request
  → PersistentToolPolicyGuard
      → DENY：记录 ToolPolicyDecision，直接抛错
      → ALLOW：记录 ToolPolicyDecision
  → ToolExecution PREPARED
  → invoke real tool
  → result + Checkpoint
```

这保证被拒绝的调用：

- 不调用真实工具；
- 不产生误导性的 PREPARED 副作用记录；
- 保存 policySnapshotId、toolCallId 和拒绝原因。

文件工具会校验解析后的路径是否位于 Workspace roots 内。ManagedLocal 无法证明任意
`bash` 命令不会越过文件或网络边界，因此在存在这些硬约束时 fail closed。

## 6. Sandbox 与 Secret

`SandboxProvider` 是可替换接口。当前首个实现 `ManagedLocalSandboxProvider` 负责：

- Workspace 范围校验；
- PROVISIONING / ACTIVE / TERMINATED / LOST 生命周期；
- 将文件、进程和工具网络约束连接到 ToolGateway；
- 按 EffectivePolicySnapshot 中的 Secret 名称按需获取值；
- Sandbox 结束或丢失后立即销毁内存 Secret；
- Sandbox LOST 时把 Instance 标记 FAILED，并中断 Run/Attempt。

数据库只保存 Secret 名称：

```json
{"secretNames":["API_TOKEN"]}
```

不会保存 Secret 值。值只在 `SandboxHandle.withSecrets(...)` 回调期间可见。

### 明确限制

ManagedLocal 不是容器，不宣称提供内核级 CPU、内存或磁盘隔离。当有效策略声明这类
硬限制时，它会明确拒绝：

```text
MANAGED_LOCAL 无法落实 CPU/内存/磁盘硬限制，拒绝执行
```

未来可用 Docker/Kubernetes Provider 替换，不改变上层 Attempt 和策略语义。

## 7. 数据库证据

Migration v6 新增：

- `runtime_capability_profiles`
- `harness_instances`
- `harness_sessions`
- `run_attempts`
- AgentRun 的 TemplateVersion/Instance 引用

Migration v7 新增：

- `effective_policy_snapshots`
- `policy_compilations`
- `tool_policy_decisions`
- `sandboxes`
- AgentRun 的 Run 临时策略 JSON

## 8. 验收测试

核心端到端测试位于：

`tests/integration/stage1-stage2-control-plane.e2e.test.ts`

它证明：

1. 两个 Tenant 使用同一 Runtime 得到不同 Tool 配置；
2. Run 可追溯到 TemplateVersion、Instance、Session 和 Attempt；
3. 排队后发布 Template v2 不改变 Run 已固定的 v1；
4. 强制能力缺失时 Runtime/Sandbox 启动次数为零；
5. 被拒绝的 write 调用真实副作用计数为零；
6. Sandbox LOST 改变 Instance、Run 和 Attempt 状态；
7. Secret 值没有进入持久化记录；
8. 无法落实的资源硬限制明确拒绝。

2026-08-10 的完整本地验收结果：

```text
184 pass / 0 fail / 690 expect() calls
严格 TypeScript：通过
Day 7 Fake 闭环：RESULT: PASS
```

统一入口：`bun run verify:stage0`。命令名称保留 Stage 0 是为了兼容已有工程入口，
当前它同时回归 Stage 0 契约以及 Stage 1/2 新增测试。

## 9. 推荐阅读顺序

1. `runtime/runtime-capability.ts`
2. `instances/harness-instance.ts`
3. `runs/run-attempt.ts`
4. `control-plane/default-pi-control-plane.ts`
5. `policies/effective-policy.ts`
6. `runtime/managed-agent-runtime.ts`
7. `policies/tool-policy-guard.ts`
8. `sandbox/managed-local-sandbox.ts`
9. `runtime/pi-adapter.ts`
10. Stage 1/2 端到端测试
