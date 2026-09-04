# Agent Infra 秋招深度面试题库

> 基于 **VRAM-Aware Agent Harness** 项目源码，覆盖多租户隔离、认证授权、Agent Runtime、沙箱工程、可靠执行、调度公平性等核心方向。

---

## 目录

1. [认证与多租户隔离](#一认证与多租户隔离)
2. [Agent Runtime 抽象与事件系统](#二agent-runtime-抽象与事件系统)
3. [沙箱工程深度问题](#三沙箱工程深度问题)
4. [策略系统与权限治理](#四策略系统与权限治理)
5. [资源调度与公平性](#五资源调度与公平性)
6. [可靠执行与故障恢复](#六可靠执行与故障恢复)
7. [测试策略与工程实践](#七测试策略与工程实践)
8. [架构决策与诚实边界](#八架构决策与诚实边界)

---

## 一、认证与多租户隔离

### Q1: 你们的认证链路是怎样的？API Key 如何映射到 Tenant？

**面试官想考察什么**：身份认证设计、安全最佳实践（timing-safe comparison）、租户边界意识。

**回答要点**：

> 认证链路：**Raw API Key → SHA-256 Digest → SQLite 查询 → RequestPrincipal → tenantId + scopes**
>
> 1. 客户端提交 `Authorization: Bearer <rawKey>`
> 2. 服务端计算 `SHA-256(rawKey)` 作为 `keyDigest`
> 3. 在 `api_credentials` 表中查询未撤销的凭证
> 4. 即使索引命中，仍然做一次 `timingSafeEqual` 防止时序攻击
> 5. 返回 `RequestPrincipal { tenantId, scopes }`
>
> **核心原则**：Tenant 是服务端派生的，不是客户端自报的。所有后续操作必须带 `tenantId` 字段，跨 Tenant 访问返回 404。

**关键代码**：

```typescript
// src/auth/api-credential-store.ts:56-74
authenticate(rawKey: string): RequestPrincipal | null {
    const row = this.db.query<CredentialRow, { keyDigest: string }>(`
        SELECT id, key_digest AS keyDigest, tenant_id AS tenantId, ...
        FROM api_credentials
        WHERE key_digest = $keyDigest AND revoked_at IS NULL;
    `).get({ keyDigest: digest(rawKey) });
    if (row === null) return null;

    // 即使索引已匹配，仍做 timing-safe 比较防时序攻击
    if (!timingSafeEqual(Buffer.from(row.keyDigest), Buffer.from(digest(rawKey)))) {
        return null;
    }
    return Object.freeze({
        tenantId: row.tenantId,
        scopes: Object.freeze(JSON.parse(row.scopesJson) as string[]),
    });
}
```

---

### Q2: 多租户隔离在你们的系统里体现在哪几个层面？

**面试官想考察什么**：纵深防御（Defense in Depth）思维、多租户架构分层。

**回答要点**：

> 五个层面：
>
> | 层面 | 机制 | 代码位置 |
> |------|------|----------|
> | **身份层** | API Key → Principal → tenantId 派生 | `src/auth/` |
> | **数据层** | 所有表（Run、Event、Sandbox、PolicyDecision）带 `tenantId` 字段 | `src/storage/schema.ts` |
> | **调度层** | Tenant 内 FIFO、Tenant 间 round-robin，防止单一租户饥饿 | `src/scheduling/tenant-run-scheduler.ts` |
> | **运行层** | 每个 Attempt 独立 Sandbox、独立 Workspace 挂载、独立 Secret | `src/sandbox/container-sandbox-provider.ts` |
> | **网络层** | 默认 `--network none`，按策略开启 | `src/sandbox/oci-sandbox-spec.ts` |
>
> **审计层**：所有 PolicyDecision 和 RunEvent 都带 `tenantId`，可跨层追踪。

---

### Q3: 如果一个 Tenant 拿到了另一个 Tenant 的 API Key，他能做什么？

**面试官想考察什么**：安全边界、威胁建模。

**回答要点**：

> 他只能访问**该 Key 所属 Tenant** 的数据。因为：
>
> 1. `ApiCredentialStore.authenticate()` 从 Key 派生 `tenantId`，不是从请求体读取
> 2. `RunStore.get(runId)` 查询时隐含 `tenantId` 过滤（通过 Principal 注入）
> 3. 跨 Tenant Run 访问返回 404，不暴露"存在但无权限"的信息
>
> 但如果有 SQL 注入漏洞，上述隔离就会失效。所以我们用参数化查询（Bun SQLite `query().run()`）杜绝注入。

---

## 二、Agent Runtime 抽象与事件系统

### Q4: 为什么需要 `AgentRuntime` 抽象层？直接调用 Pi SDK 不行吗？

**面试官想考察什么**：接口隔离、依赖倒置、架构分层。

**回答要点**：

> **直接依赖 Pi SDK 的问题**：
> - 测试需要真实 Pi + vLLM + GPU，无法单元测试
> - 换 Runtime（Claude、Gemini）需要改所有调用处
> - 事件格式由 Pi 定义，Harness 无法做统一审计
>
> **`AgentRuntime` 抽象的价值**：
> 1. **依赖倒置**：Harness 只依赖 `AgentRuntime` 接口，不依赖具体 SDK
> 2. **可测试性**：`FakeAgentRuntime` 实现同一接口，用于确定性测试
> 3. **可替换性**：Pi、Claude、自研 Runtime 都可以接入
> 4. **事件统一**：所有 Runtime 事件被映射为 Harness `RuntimeEvent`，再转为 `RunEvent` 持久化

**关键代码**：

```typescript
// src/runtime/agent-runtime.ts:168-179
export interface AgentRuntime {
    getCapabilityProfile?(): RuntimeCapabilityProfile;
    start(request: RuntimeStartRequest): Promise<void>;
    resume(request: RuntimeResumeRequest): Promise<void>;
    interrupt(runId: string): Promise<void>;
    subscribe(runId: string, handler: RuntimeEventHandler): () => void;
}
```

---

### Q5: `PiAdapter` 是怎么把 Pi 的事件翻译成 Harness 事件的？如果 Pi 加了新事件类型，你们会崩溃吗？

**面试官想考察什么**：类型安全、防御性编程、事件驱动架构。

**回答要点**：

> **翻译机制**：`PiAdapter` 订阅 Pi 的 `AgentSessionEvent`，在 `switch` 中映射到 Harness `RuntimeEvent`：
> - `agent_start` → `agent_started`
> - `message_start/end` → `model_started/completed`（含 usage、cost）
> - `tool_execution_start/end` → `tool_started/completed`
> - `agent_end` → 根据 `stopReason` 区分为 `agent_completed/failed/interrupted`
>
> **防崩溃设计**：
> 1. **显式忽略已知无业务意义事件**：`turn_start`、`tool_execution_update` 等明确列在 switch 中但不映射
> 2. **`never` 类型兜底**：`default` 分支调用 `warnUnknownPiEvent(event: never)`，如果 Pi SDK 扩展了事件联合类型，TypeScript 编译会失败，**强制我们决定是映射、忽略还是告警**
> 3. **运行时告警但不崩溃**：未知事件只打 `console.warn`，不影响当前 Run

**关键代码**：

```typescript
// src/runtime/pi-adapter.ts:114-123
private warnUnknownPiEvent(event: never): void {
    const unknownEvent = event as { type?: unknown };
    console.warn(`收到未知 Pi AgentSessionEvent：${String(unknownEvent.type)}`, event);
}

// default 分支
default:
    this.warnUnknownPiEvent(piEvent);  // 编译时保证 exhaustiveness
```

---

### Q6: `RuntimeEventBridge` 为什么要区分"持久化事件"和"非持久化事件"？

**面试官想考察什么**：事件分类、存储成本、可观测性设计。

**回答要点**：

> **三层事件**：
> 1. **生命周期事件**（`agent_started/completed/failed/interrupted/resumed`）：由 `RunService` 直接处理并更新 Run 状态，`Bridge` 返回 `null` 避免重复存储
> 2. **业务边界事件**（`model_started/completed`、`tool_started/completed`）：需要持久化，用于审计、恢复、用量统计
> 3. **流式展示事件**（`text_delta`）：只用于实时推送到前端，不持久化（量大、可重建）
>
> **去重设计**：每个持久化事件有 `dedupeKey`，如 `tool:${toolCallId}:finished`。即使 Runtime 错误地先发成功、后发失败，也使用同一去重键，避免数据库中出现矛盾记录。

**关键代码**：

```typescript
// src/events/runtime-event-bridge.ts:113-131
case "tool_completed":
    return {
        runId: event.runId,
        type: event.isError ? "TOOL_FAILED" : "TOOL_COMPLETED",
        // 一个工具调用只能拥有一个最终结果
        dedupeKey: `tool:${event.toolCallId}:finished`,
        payload: { toolCallId, toolName, result, isError },
    };
```

---

## 三、沙箱工程深度问题

### Q7: 你们的 Sandbox 到底是怎么创建的？从策略到容器经历了哪些步骤？

**面试官想考察什么**：完整链路理解、OCI 规范、安全编译。

**回答要点**：

> **七步链路**：
> ```
> EffectivePolicySnapshot
>   → OciSandboxSpecCompiler.compile()  // 策略 → OCI Spec
>   → 校验 profile/runtime 匹配        // fail-closed
>   → 读取 Secret（按 tenantId）        // SecretProvider.get(tenantId, name)
>   → docker create [args...]           // 实际创建
>   → docker inspect verify             // 验证 runtime 证据
>   → 状态变为 ACTIVE                   // 可执行
> ```
>
> **关键安全点**：
> - `default` profile 必须用 `runsc`，配置成 `runc` 直接抛错
> - `docker inspect` 验证实际 runtime，防止 Docker daemon 被篡改后静默降级
> - Secret 只保存名称到 `SandboxRecord`，值存在内存 Map 中

---

### Q8: 为什么容器执行失败时，要区分"容器不见了"（LOST）和普通失败？

**面试官想考察什么**：故障分类、状态机设计、恢复策略。

**回答要点**：

> **LOST 是基础设施故障信号**，不是业务逻辑失败：
> - 普通失败：`exitCode !== 0` 但容器还在，可能是命令本身报错
> - LOST：`docker exec` 返回 "no such container"，说明 Sandbox 进程被外部杀掉、Docker daemon 重启、或节点故障
>
> **不同处理**：
> - 普通失败 → 工具执行记录为 `FAILED`，Agent 可能重试或报错
> - LOST → Sandbox 状态变为 `LOST`，触发生命周期事件，Run 变为 `INTERRUPTED`，进入恢复流程

**关键代码**：

```typescript
// src/sandbox/container-sandbox-provider.ts:200-209
async execute(sandboxId: string, command: readonly string[]) {
    const result = await this.commands.run([
        this.docker, "exec", "--workdir", "/workspace", name, ...command,
    ]);
    if (result.exitCode !== 0 && isContainerMissing(result.stderr)) {
        this.markLost(sandboxId, redact(result.stderr));  // 容器消失 → LOST
    }
    return result;
}

// 正则匹配容器消失的各种错误信息
function isContainerMissing(value: string): boolean {
    return /no such container|container .* is not running|cannot exec in a stopped state/i.test(value);
}
```

---

### Q9: 如果 Docker daemon 在创建容器时把 `runsc` 降级成了 `runc`，你们怎么发现？

**面试官想考察什么**：安全验证、证据链、fail-closed。

**回答要点**：

> **创建后验证**：`ContainerSandboxProvider.create()` 在 `docker create` 成功后，立即调用 `adapter.verify()` 通过 `docker inspect` 读取实际 runtime。
>
> **验证失败的处理**：
> 1. 立即 `docker rm --force` 销毁容器
> 2. 记录失败原因到 `SandboxRecord`
> 3. 抛出错误，上层将 Run 标记为 FAILED
>
> 这样即使 Docker daemon 配置被篡改，也不会让应该走 runsc 的容器实际上用 runc 运行。

**关键代码**：

```typescript
// src/sandbox/container-sandbox-provider.ts:158-172
const verifiedEvidence = await this.adapter.verify(
    this.commands, this.docker, `agent-harness-${input.id}`,
);
if (!verifiedEvidence.verified) {
    await this.commands.run([this.docker, "rm", "--force", `agent-harness-${input.id}`]);
    const failed = {
        ...record, status: "FAILED" as const,
        failureReason: reason,
        runtimeEvidence: freezeRuntimeEvidence(verifiedEvidence),
    };
    this.store.update(failed, "PROVISIONING");
    throw new Error(`Sandbox runtime 证据校验失败：${reason}`);
}
```

---

## 四、策略系统与权限治理

### Q10: 五层策略交集是怎么计算的？如果两层冲突怎么办？

**面试官想考察什么**：策略组合、冲突解决、最小权限原则。

**回答要点**：

> **五层策略**（从全局到具体）：`PLATFORM` → `TENANT` → `TEMPLATE` → `WORKSPACE` → `RUN`
>
> **交集规则**（全部取最严格）：
> | 字段类型 | 交集方式 | 示例 |
> |----------|----------|------|
> | 布尔 | 逻辑与 | `allowNetwork: true && false → false` |
> | 数值 | 取最小 | `cpuCores: 4 && 2 → 2` |
> | 列表 | 取交集 | `allowedTools: ["read", "write"] && ["read", "bash"] → ["read"]` |
> | 路径 | 共同子目录 | `/a/b` 和 `/a/c` → 无交集则抛错 |
> | Profile | 冲突抛错 | `default` 和 `strict` 不能共存 |
>
> **缺省值是 `unrestrictedPolicy`**：如果某层未设置限制，不表示"禁止"，而是"由上层决定"。只有显式设置限制才会收紧权限。

**关键代码**：

```typescript
// src/policies/effective-policy.ts:105-127
function intersectConstraints(left: PolicyConstraints, right: PolicyConstraints): PolicyConstraints {
    return {
        allowNetwork: left.allowNetwork && right.allowNetwork,
        allowProcess: left.allowProcess && right.allowProcess,
        resourceLimits: {
            cpuCores: minimum(left.resourceLimits.cpuCores, right.resourceLimits.cpuCores),
            memoryMiB: minimum(left.resourceLimits.memoryMiB, right.resourceLimits.memoryMiB),
            diskMiB: minimum(left.resourceLimits.diskMiB, right.resourceLimits.diskMiB),
        },
        // ...
    };
}
```

---

### Q11: 工具调用时，策略是怎么生效的？模型想调一个不允许的工具，会发生什么？

**面试官想考察什么**：运行时权限校验、ToolGateway 设计。

**回答要点**：

> **三层校验**：
> 1. **Capability 预检**：Run 启动前，`RuntimeCapabilityProfile` 声明本 Runtime 支持的工具，与策略交集后确定可用工具列表
> 2. **ToolGateway 前置守卫**：模型发出工具调用时，`ToolGateway` 检查 `toolName` 是否在 `allowedTools` 中，不在则拒绝执行并记录审计
> 3. **Sandbox 执行边界**：即使绕过 ToolGateway，Sandbox 的文件系统/网络/进程隔离也会限制实际影响
>
> **体验设计**：如果工具被策略禁止，Agent 会收到错误响应（而不是静默忽略），可以引导用户调整策略或使用替代工具。

---

## 五、资源调度与公平性

### Q12: 你们的资源准入决策链路是怎样的？观测失败时为什么默认 QUEUE 而不是 START？

**面试官想考察什么**：背压设计、fail-closed、观测驱动决策。

**回答要点**：

> **三级链路**：`ResourceObserver.observe()` → `ResourceClassifier.classify()` → `ExecutionPolicy.decide()`
>
> **观测失败的处理**：
> - 如果 `ResourceObserver` 返回 `ok: false`（比如 vLLM Metrics 接口超时、GPU 驱动异常），直接输出 `QUEUE` 决策
> - reasonCode = `RESOURCE_OBSERVATION_FAILED`，pressure = `UNKNOWN`
> - 这个决策会被持久化到 `PolicyDecisionStore`，用于后续审计
>
> **为什么是 QUEUE 不是 START**：
> - 如果 GPU 实际已满但观测失败，START 会导致 OOM 或任务崩溃
> - 如果 GPU 实际空闲但观测失败，QUEUE 只是延迟启动，不会造成数据损坏
> - **保守策略的安全收益 > 性能损失**

**关键代码**：

```typescript
// src/resources/resource-admission-service.ts:59-80
const observation = await this.observer.observe();
if (!observation.ok) {
    const decision: PolicyDecision = {
        decisionId: crypto.randomUUID(),
        runId: request.runId,
        action: "QUEUE",  // fail-closed
        reasonCode: "RESOURCE_OBSERVATION_FAILED",
        pressure: "UNKNOWN",
        observationFailureReason: observation.reason,
        // ...
    };
    this.decisionRecorder.save(decision, null);
    return { observation, classification: null, decision };
}
```

---

### Q13: 如果 Tenant A 有 100 个任务在排队，Tenant B 只有 1 个，你们怎么保证 B 不被饿死？如果 A 的任务优先级都很高呢？

**面试官想考察什么**：公平调度、优先级与公平的权衡。

**回答要点**：

> **基础公平性**：`TenantRunScheduler` 使用 round-robin：
> - 全局 slot 未满时，按 `tenantOrder` 轮转，每次从每个 Tenant 取一个任务
> - 调度顺序：A1 → B1 → A2 → A3... B 永远不会被永久饿死
>
> **单 Tenant 并发上限**：`maxActiveRunsPerTenant` 确保 A 不能占满全部 slot。如果 A 的活跃任务已达上限，即使轮转到 A，也会把 A 放回队尾，继续检查 B。
>
> **关于优先级**：当前 MVP 不支持任务级优先级。原因是：
> - 优先级需要与公平性做 trade-off，算法复杂度上升
> - 在证明基础公平性有效之前，先不引入额外变量
> - 秋招后如果需要，可以在 Tenant 内做优先级队列，但 Tenant 间仍保持 round-robin

**关键代码**：

```typescript
// src/scheduling/tenant-run-scheduler.ts:138-183
for (let inspected = 0; inspected < tenantsToInspect; inspected += 1) {
    const tenantId = this.tenantOrder.shift()!;
    const tenantQueue = this.queuesByTenant.get(tenantId);
    const activeTenantByRunCount = this.getActiveTenantRunCount(tenantId);

    // 当前 tenant 达到并发上限 → 放回队尾，继续下一轮
    if (activeTenantByRunCount >= this.config.maxActiveRunsPerTenant) {
        this.tenantOrder.push(tenantId);
        continue;
    }

    // 调度成功，如果还有任务则放回队尾
    const run = tenantQueue.shift()!;
    if (tenantQueue.length > 0) {
        this.tenantOrder.push(tenantId);
    }
    this.activeTenantByRunId.set(run.runId, run.tenantId);
    return run;
}
```

---

## 六、可靠执行与故障恢复

### Q14: 任务执行到一半崩溃了，恢复流程是怎样的？什么情况下能自动恢复？

**面试官想考察什么**：状态机、Checkpoint、副作用分类、恢复决策。

**回答要点**：

> **恢复决策三步走**：
> 1. **有没有 Checkpoint？** 没有 → `MANUAL_REVIEW`（无法确定从哪里恢复）
> 2. **Checkpoint 后的工具是否安全？** 遍历 `PREPARED` 状态的工具执行，检查 `canAutomaticallyReplay(status, effect)`
> 3. **决策**：全部安全 → `AUTO_RESUME`；有任何不安全 → `MANUAL_REVIEW` + 指出 blocking tool
>
> **ToolEffect 三分类的安全级别**：
> | 分类 | 能否自动重放 | 理由 |
> |------|-------------|------|
> | `READ_ONLY` | ✅ | 只读无副作用 |
> | `IDEMPOTENT_WRITE` | ❌ | 声明幂等 ≠ 实际幂等，fail-closed |
> | `UNKNOWN_EFFECT` | ❌ | 未知副作用，必须人工确认 |

**关键代码**：

```typescript
// src/checkpoints/recovery-decision.ts:23-63
export function decideRecovery(
    checkpointId: string | null,
    preparedExecution: readonly ToolExecution[],
): RecoveryDecision {
    if (checkpointId === null) {
        return { action: "MANUAL_REVIEW", reason: "NO_CHECKPOINT", blockingToolExecutionId: null };
    }
    const unsafeExecution = preparedExecution.find(
        (execution) => !canAutomaticallyReplay(execution.status, execution.effect)
    );
    if (unsafeExecution !== undefined) {
        return {
            action: "MANUAL_REVIEW",
            reason: "UNSAFE_TOOL_EFFECT",
            blockingToolExecutionId: unsafeExecution.id,
        };
    }
    return { action: "AUTO_RESUME", reason: "SAFE_CHECKPOINT", blockingToolExecutionId: null };
}

// src/tools/tool-execution.ts:36-54
export function canAutomaticallyReplay(status: ToolExecutionStatus, effect: ToolEffect): boolean {
    if (status !== "PREPARED") return false;  // 已执行过的不重放
    switch (effect) {
        case "READ_ONLY": return true;
        case "IDEMPOTENT_WRITE": return false;  // 保守：需校验真实幂等证据
        case "UNKNOWN_EFFECT": return false;
    }
}
```

---

### Q15: Checkpoint 是什么？为什么说它不是"内存 dump"？

**面试官想考察什么**：状态持久化、恢复语义、工程精确性。

**回答要点**：

> **Checkpoint 是稳定引用**，包含：
> - `checkpointId`：Harness 持久化的标识
> - `runtimeSessionRef`：Pi Session 文件路径（Pi 的会话持久化引用）
> - `lastEventSequence`：Harness 事件序列号，恢复时从该序号继续追加
>
> **为什么不是内存 dump**：
> - 内存 dump 需要序列化整个进程状态，体积大、版本不兼容
> - 我们的 Checkpoint 引用的是 Pi 自己的会话文件 + Harness 的事件序列，**两者都是持久化的**
> - 恢复时重新创建 Pi Session（从 `SessionManager.open(runtimeSessionRef)`），重新订阅事件，从 `lastEventSequence + 1` 开始追加
> - 这样即使 Harness 进程重启，也能恢复

**关键代码**：

```typescript
// src/runtime/agent-runtime.ts:35-44
export interface RuntimeCheckpointRef {
    checkpointId: string;
    runtimeSessionRef: string;   // Pi Session 文件路径
    lastEventSequence: number;   // Harness 事件序号
}

// src/runtime/pi-adapter.ts:429-433
const sessionManager = SessionManager.open(
    request.checkpoint.runtimeSessionRef,
    undefined,
    request.run.workspacePath
);
```

---

### Q16: 如果 `Runtime.resume()` 在打开 Session 之前就抛错了，Run 会卡在什么状态？怎么处理？

**面试官想考察什么**：异常处理、状态机完整性。

**回答要点**：

> **状态回退到 `INTERRUPTED`**：
> - `RunService.executeQueuedResume()` 在 `try/catch` 中调用 `this.runtime.resume()`
> - 如果 resume 抛错，`catch` 块调用 `markRuntimeInvocationFailureInterrupted()`
> - Run 状态从 `RUNNING` 回退到 `INTERRUPTED`，并记录失败原因
> - 这样 Run 不会永远卡在 `RUNNING`，下次恢复流程会再次尝试
>
> **为什么不是 `FAILED`**：因为 Checkpoint 仍然有效，问题可能是临时的（vLLM 瞬时不可用），回退到 `INTERRUPTED` 允许后续自动或人工恢复。

**关键代码**：

```typescript
// src/runs/run-service.ts:262-296
async executeQueuedResume(input: ResumeRunInput): Promise<AgentRun> {
    const unsubscribe = this.subscribeToRuntime(input.runId);
    try {
        await this.runtime.resume({ ... });
    } catch (error) {
        this.markRuntimeInvocationFailureInterrupted(input.runId, error, "RESUME_FAILED");
        throw error;
    } finally {
        unsubscribe();
    }
    // ...
}

// src/runs/run-service.ts:496-537
private markRuntimeInvocationFailureInterrupted(
    runId: string, error: unknown, reason: "START_FAILED" | "RESUME_FAILED"
): void {
    // Runtime 已经发出终态事件时，以已持久化的终态为准
    if (currentRun.status !== "RUNNING" && currentRun.status !== "WAITING_TOOL") {
        return;
    }
    this.store.update(
        { ...currentRun, status: "INTERRUPTED", updatedAt: timestamp },
        { eventId: crypto.randomUUID(), runId, type: "RUN_INTERRUPTED", ... }
    );
}
```

---

## 七、测试策略与工程实践

### Q17: 你们为什么用 `FakeAgentRuntime` 而不是直接 mock Pi SDK？

**面试官想考察什么**：测试设计、Fake vs Mock、可重复性。

**回答要点**：

> **Fake 的优势**：
> 1. **确定性行为**：FakeRuntime 按预设序列发出事件，不依赖外部网络/GPU/模型
> 2. **合同测试**：验证所有 Runtime 实现（Fake、Pi、未来其他）都遵守 `AgentRuntime` 接口的语义契约
> 3. **快速反馈**：单元测试秒级完成，不需要启动 vLLM
> 4. **无魔法**：Mock 需要了解 Pi SDK 内部实现，Fake 只需要实现接口
>
> **Fake 的验证点**（5 个核心测试）：
> - `start` 发送事件序列正确
> - `resume` 发送恢复事件
> - `interrupt` 记录中断请求
> - 取消订阅后不再收到事件
> - 不同 `runId` 的事件不会串扰

**关键代码**：

```typescript
// tests/runtime/agent-runtime.test.ts:161-221
test("不同 runId 的事件不会发送给错误的订阅者", async () => {
    const runtime = new FakeAgentRuntime();
    const run1Events: RuntimeEvent[] = [];
    const run2Events: RuntimeEvent[] = [];

    runtime.subscribe("run-1", event => run1Events.push(event));
    runtime.subscribe("run-2", event => run2Events.push(event));

    await runtime.start(run1Request);  // 只启动 run-1
    expect(run1Events).toHaveLength(3);
    expect(run2Events).toHaveLength(0);  // run-2 没收到任何事件
});
```

---

### Q18: `ContainerSandboxProvider` 的测试里为什么用一个 `FakeDocker` 而不是真的启动 Docker？

**面试官想考察什么**：测试金字塔、外部依赖隔离。

**回答要点**：

> **FakeDocker 验证的是"我们生成的命令是否正确"**：
> - 检查 `docker create` 参数是否包含 `--runtime runsc`、 `--read-only`、 `--network none` 等
> - 检查 Workspace bind mount 路径是否正确
> - 检查 Secret 是否通过环境变量注入
> - 检查资源限制（`--cpus 1.5`、`--memory 512m`）是否生效
>
> **真机验证在 smoke 测试**：`bun run smoke:container` 在真实 Linux Docker 环境执行，验证 runsc 实际隔离效果。
> 
> **分层策略**：单元测试用 Fake（快、确定）→ Smoke 测试用真 Docker（验证实际行为）→ 攻击测试用真 runsc（验证安全边界）。

**关键代码**：

```typescript
// tests/sandbox/container-sandbox-provider.test.ts:35-85
test("容器 Sandbox 将隔离策略编译为可审计 Docker 参数", async () => {
    const create = docker.calls[0]!;
    expect(create).toContain("--runtime");
    expect(create).toContain("runsc");
    expect(create).toContain("--read-only");
    expect(create).toContain("--cap-drop");
    expect(create).toContain("ALL");
    expect(create).toContain("--network");
    expect(create).toContain("none");
    expect(JSON.stringify(store.get(handle.id))).not.toContain("secret-value");  // 值不持久化
    expect(store.get(handle.id)?.secretNames).toEqual(["TOKEN"]);  // 只存名称
});
```

---

## 八、架构决策与诚实边界

### Q19: 为什么选 Pi 作为 Agent Runtime，而不是自研 Agent Loop？

**面试官想考察什么**：技术选型、不做重复造轮子、核心差异化判断。

**回答要点**：

> **ADR-0001 的决策**：
> - 自研 Agent Loop 需要解决：Prompt 模板、上下文压缩、工具循环、Session 管理、错误重试——这些都是通用问题
> - Pi SDK 已经成熟地解决了这些问题，且有活跃维护
> - 我们的核心差异化在**控制面**（隔离、调度、恢复、治理），不在 Agent Loop
>
> **保留的抽象**：`AgentRuntime` 接口让我们可以在不修改 Harness 核心的情况下替换 Runtime。FakeRuntime 用于测试，PiAdapter 用于生产，未来可以接 Claude/Gemini。

---

### Q20: 这个项目最大的诚实边界是什么？哪些是你没做、但面试时最容易被误吹的？

**面试官想考察什么**：自我认知、工程诚实、对生产环境的理解。

**回答要点**：

> | 不能说的话 | 正确的说法 |
> |-----------|-----------|
> | "自研沙箱，安全级别和 Kata/Firecracker 一样" | "底层用现成 runsc/gVisor，亮点在上层控制面" |
> | "生产级高并发分布式" | "单进程服务，面试/学习项目，没有多机高可用" |
> | "绝对安全" | "9 项攻击冒烟在 ECS 真机上通过；没有 KVM 不声称 strict 隔离" |
> | "自研 LLM 模型/协议" | "OpenAI 兼容代理，做路由和可靠性" |
> | "GPU 资源准入已完全真实" | "T4 + vLLM 0.7.3 120 并发验证；A6000 未二次复验" |
>
> **这是面试加分项**：主动说出边界，比被追问出来要好得多。说明你对"什么条件下能声称什么"有清醒认识。

---

## 附：面试速查卡

### 核心数字

| 数字 | 含义 |
|------|------|
| 254 tests pass / 0 fail | 基础功能稳定性 |
| 9 项攻击冒烟 PASS | 沙箱隔离有效性 |
| 120 并发 → CRITICAL → QUEUE | 资源背压真实有效 |
| runsc 1.22x 开销 | 隔离开销可接受 |
| 5 层策略交集 | 最小权限原则 |
| 3 类 ToolEffect | 副作用治理 |
| 2 级公平调度 | Tenant 内 FIFO + Tenant 间 round-robin |

### 核心文件索引

| 主题 | 关键文件 |
|------|----------|
| 认证 | `src/auth/api-credential-store.ts` |
| 运行时抽象 | `src/runtime/agent-runtime.ts` |
| Pi 适配 | `src/runtime/pi-adapter.ts` |
| 事件桥接 | `src/events/runtime-event-bridge.ts` |
| 沙箱 Provider | `src/sandbox/container-sandbox-provider.ts` |
| 策略计算 | `src/policies/effective-policy.ts` |
| 资源准入 | `src/resources/resource-admission-service.ts` |
| 调度器 | `src/scheduling/tenant-run-scheduler.ts` |
| 恢复决策 | `src/checkpoints/recovery-decision.ts` |
| 工具副作用 | `src/tools/tool-execution.ts` |
| Run 状态机 | `src/runs/run-service.ts` |

---

*本文档由 VRAM-Aware Harness 源码深度分析生成，用于 Agent Infra 秋招面试准备。*
