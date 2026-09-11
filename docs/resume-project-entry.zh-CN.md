# VRAM-Aware Agent Harness：简历项目经历与倒推学习清单

> 目标岗位：Agent Infra / AI 平台后端 / 后端开发。  
> 证据基线：当前工作区 `bun run test` 为 **476 pass / 0 fail（98 files）**；T4、runsc 数据来自已保存的真机验收记录。  
> 使用原则：简历上的每句话都必须能沿源码、测试和边界说明三层自证。
>
> **2026-09-11 事实同步（只改数字，未改措辞）**：测试基线 269 → 476（59 → 98 files）。
> 本文的 Bullet 仍是较早一版的写法，尚未纳入以下更新的事实（写入简历前请自行取舍）：
> ① **定位是单机多租户实验室项目**，不做多机/HA，也**不是生产级**；
> ② 全场景 campaign **86 个场景跑了 84 个**（67 完整通过 / 8 部分 / 8 FAIL / 1 INCONCLUSIVE）；
> ③ 容量 **λ\*=1.146 任务/s**、8h 长稳 3505 次沙箱 0 残留；
> ④ **N28 两层上下文压缩**（Pi 摘要式压缩为主、网关截断兜底）经真机验证：单会话 134 次运行 21 次压缩、0 上下文超限失败；
> ⑤ **N27 是上游 vLLM 缺陷**（流式工具调用参数丢末字符 26%），已在网关 SSE 层兜底修复；
> ⑥ N 系列缺陷**已全部收口**（[known-issues](known-issues.zh-CN.md) §23–§25）。
> 交叉索引见 [`scenario-test-index.zh-CN.md`](scenario-test-index.zh-CN.md)。

## 一、推荐写入简历的最终版本

### VRAM-Aware Agent Harness｜多租户本地大模型 Agent 任务平台

**技术栈：TypeScript、Bun、SQLite、Pi Agent Runtime、vLLM、Docker、runsc/gVisor**

面向团队共享本地大模型的开发场景，在 Pi 与 vLLM 之上构建多租户受管 Agent Runtime，重点解决 GPU 资源调度、可靠恢复和隔离执行。

- **受管 Agent Runtime：**设计 `Session → Run → Attempt → Sandbox` 生命周期模型，统一编排模型推理、工具调用、运行事件与隔离环境；打通异步任务提交、实时输出、最终回答、Workspace Diff 和 Artifact 交付链路。
- **资源调度与背压：**实现 Tenant 内 FIFO、Tenant 间 Round-Robin、全局/租户并发 slot、同会话串行及 single-flight QueuePump；融合 vLLM Metrics 与 NVIDIA GPU 指标进行资源分类和 `START / QUEUE` 准入，在 T4 16 GB + vLLM 的 120 并发压力场景中验证 `CRITICAL → QUEUE → 资源恢复后自动推进` 闭环。
- **可靠执行与恢复：**通过 SQLite 事务、追加式 RunEvent、稳定去重键和工具执行账本维护执行事实；按只读、幂等写、未知副作用划分恢复策略，结合 Checkpoint 与启动对账自动恢复安全任务并拦截高风险重放。
- **多租户隔离：**建立 API Key → Principal → Tenant 的可信身份链，将平台、Tenant、Template、Workspace、Run 五层策略交集落实到 ToolGateway 与 runsc Sandbox，控制文件、进程、网络、Secret 和计算资源边界；通过 9 项真机隔离攻击验证及 **476 项自动化测试**。

## 二、一页简历空间不足时的压缩版

### VRAM-Aware Agent Harness｜多租户本地大模型 Agent 任务平台

**TypeScript / Bun / SQLite / Pi / vLLM / Docker / runsc(gVisor)**

- 在 Pi 与 vLLM 之上构建多租户受管 Agent Runtime，设计 `Session → Run → Attempt → Sandbox` 生命周期，打通模型/工具执行、最终回答、Workspace Diff 与 Artifact 交付链路。
- 实现 Tenant 内 FIFO、Tenant 间 Round-Robin、公平 slot 与 single-flight QueuePump，结合 vLLM/GPU 指标进行资源准入；在 T4 + vLLM 120 并发压力场景中验证 `CRITICAL → QUEUE → 自动推进` 背压闭环。
- 基于 SQLite 事务、追加式事件、工具执行账本和 Checkpoint 实现副作用感知恢复，以稳定 ID 去重并复用结果，自动恢复安全任务并拦截高风险重放。
- 建立 Principal 驱动的多租户数据边界和五层策略交集，将文件/Shell 工具限制在 runsc Sandbox；通过 9 项真机隔离攻击验证及 476 项自动化测试。

## 三、不同岗位的第一句话

### 投 Agent Infra / AI 平台

> 设计并实现面向团队共享本地模型的多租户 Agent 执行控制面，重点解决 Agent 任务的资源准入、隔离执行、副作用治理和故障恢复。

### 投通用后端

> 设计并实现单节点多租户异步任务服务，围绕持久化状态机、公平调度、事务一致性、故障恢复和权限隔离构建完整执行闭环。

### 投云原生 / 容器方向

> 设计并实现多租户 Agent 任务控制面，将版本化策略编译为 runsc 容器执行边界，并通过运行时证据和攻击测试验证 Workspace、网络、进程和 Secret 隔离。

## 四、简历用词边界

| 不写 | 应写 |
|---|---|
| 生产级分布式 Agent 平台 | 单节点多租户 Agent 任务控制面 |
| 自研 Agent 框架或 Agent Loop | 复用 Pi Agent Runtime，建设执行与隔离控制面 |
| 自研 GPU/vLLM 调度器 | 根据 vLLM/GPU 资源事实实施 Run 级准入和背压 |
| 120 个完整 Agent/Sandbox 并发 | 120 个并发模型请求触发真实资源压力 |
| 绝对安全或 MicroVM 级隔离 | runsc/gVisor Sandbox，9 项既定攻击场景通过 |
| runsc 普遍只慢 1.22 倍 | 指定真机环境的冷启动对照约 1.22 倍 |
| 完整 Event Sourcing | 状态快照 + 追加式 Run Event Timeline |
| Exactly-once 工具执行 | 稳定 ID、事务与结果复用实现业务幂等；不确定副作用转人工处理 |
| 476 项真机测试 | 476 项自动化测试；GPU 与隔离另有独立真机验收 |

## 五、从简历倒推的源码学习顺序

### Bullet 1：任务模型、生命周期与结果闭环

必须能回答：

1. Session、Run、Attempt、Runtime invocation、Sandbox 分别是什么？
2. 为什么既保存 Run 当前状态，又保存 RunEvent？
3. Run 与初始事件、状态更新与事件为什么要在同一事务中？
4. RuntimeEvent 如何映射、排序和去重？
5. 为什么内部 `COMPLETED` 不等于用户已经拿到可用结果？

源码证据：

- `src/runs/agent-run.ts`
- `src/runs/run-attempt.ts`
- `src/runs/run-service.ts`
- `src/runs/runstore.ts`
- `src/events/runtime-event-bridge.ts`
- `src/runs/run-output-store.ts`
- `src/workspaces/run-workspace-result.ts`
- `src/workspaces/run-artifact-store.ts`

测试证据：

- `tests/runs/`
- `tests/events/`
- `tests/workspaces/`
- `tests/integration/harness-process-http.test.ts`

### Bullet 2：公平调度、资源准入与背压

必须能回答：

1. 为什么数据库 `QUEUED` 与内存 Scheduler 都需要？
2. `claimNext` 为什么在返回前预占 slot？
3. Admission 的 active count 为什么减一？
4. `drainPromise` 与 `drainRequested` 分别解决什么？
5. vLLM token 调度、GPU 资源事实和 Harness 逻辑 slot 有什么区别？
6. Observer 不可用、BUSY、CRITICAL、资源恢复分别如何处理？

源码证据：

- `src/scheduling/tenant-run-scheduler.ts`
- `src/scheduling/run-queue-coordinator.ts`
- `src/scheduling/run-queue-pump.ts`
- `src/scheduling/queued-run-recovery-service.ts`
- `src/resources/vllm-resource-observer.ts`
- `src/resources/resource-classifier.ts`
- `src/resources/execution-policy.ts`
- `src/resources/resource-admission-service.ts`
- `src/resources/policy-decision-store.ts`

测试与真机证据：

- `tests/scheduling/`
- `tests/resources/`
- `scripts/e2e-gpu-pressure.ts`
- `docs/archive/gpu-completion-runbook.zh-CN.md`

### Bullet 3：工具幂等与安全恢复

必须能回答：

1. 为什么数据库事务不能独自解决外部副作用一致性？
2. `PREPARED / COMPLETED / FAILED` 分别表示什么？
3. 三种 ToolEffect 的恢复规则是什么？
4. 外部操作成功、本地尚未写 COMPLETED 时为什么危险？
5. 启动恢复为什么先回收旧 Sandbox，再重建队列和扫描中断任务？

源码证据：

- `src/tools/tool-execution.ts`
- `src/tools/tool-execution-store.ts`
- `src/tools/tool-gateway.ts`
- `src/checkpoints/checkpoint.ts`
- `src/checkpoints/recovery-decision.ts`
- `src/checkpoints/recovery-service.ts`
- `src/checkpoints/recovery-executor.ts`
- `src/checkpoints/recovery-startup-coordinator.ts`

测试证据：

- `tests/tools/`
- `tests/checkpoints/`
- `tests/integration/day7-recovery-resource.e2e.test.ts`

### Bullet 4：身份、策略与 Sandbox

必须能回答：

1. API Key 来自客户端，为什么 Tenant 仍不是客户端自报？
2. Workspace IDOR 为什么统一返回 404？
3. 五层策略交集如何形成不可变 Effective Policy？
4. ToolGateway 在副作用发生前检查了什么？
5. 为什么创建容器后还必须 inspect 实际 runtime？
6. runsc 解决了什么，又没有解决什么？

源码证据：

- `src/auth/request-principal.ts`
- `src/auth/api-credential-store.ts`
- `src/http/harness-http-api.ts`
- `src/policies/effective-policy.ts`
- `src/policies/policy-compilation.ts`
- `src/policies/tool-policy-guard.ts`
- `src/runtime/pi-tool-gateway.ts`
- `src/sandbox/container-sandbox-provider.ts`
- `src/sandbox/oci-sandbox-spec.ts`
- `src/evidence/`

测试与真机证据：

- `tests/http/tenant-boundary.test.ts`
- `tests/policies/`
- `tests/runtime/pi-tool-gateway.test.ts`
- `tests/sandbox/`
- `scripts/container-sandbox-attack-smoke.ts`
- `docs/archive/sandbox-runtime-benchmark-runbook.zh-CN.md`

### 横向证据：测试与工程边界（不单独占简历 Bullet）

必须能回答：

1. Fake Runtime/Observer 证明什么，不能证明什么？
2. 单元、组件、集成和真机测试分别覆盖哪些风险？
3. 为什么普通 CI 不依赖真实 GPU？
4. 为什么选择 SQLite，迁移多 Worker 时哪些机制先失效？
5. 476 项测试中最有价值的五个失败路径是什么？

当前可引用基线：

```text
bun run test
476 pass / 0 fail
4890 expect() calls
98 test files
```

## 六、投递前必须掌握的优先级

| 优先级 | 内容 | 达标标准 |
|---|---|---|
| P0 | Bullet 1、2、3 | 能不看资料画出 Runtime、调度和恢复三条调用链，并连续承受 10 分钟追问 |
| P0 | Bullet 4 的 Principal、Tenant、ToolGateway、runsc 边界 | 能解释纵深隔离及诚实边界 |
| P1 | Bullet 5 | 能用测试层次和失败路径证明工程质量 |
| P1 | Template、Instance、Capability、Effective Policy | 能说明为什么 Run 要固定不可变执行证据 |
| P2 | Eval、Dashboard、LLM Gateway | 知道入口、价值与第一步边界，不作为主卖点展开 |

## 七、项目介绍模板

### 30 秒版本

> 我做了一个面向团队共享本地大模型的多租户 Agent 任务控制面。Pi 负责模型和工具循环，我主要解决真实任务执行中的资源准入、公平调度、工具副作用恢复和 runsc 隔离。系统根据 vLLM 与 GPU 指标决定任务启动或排队，通过状态机、工具账本和 Checkpoint 避免故障后重复危险副作用；当前 476 项自动化测试全绿，并完成了 T4 资源背压和 9 项 runsc 隔离攻击的真机验证。

### 诚实边界结尾

> 当前定位是单节点工程验证：SQLite、单进程 QueuePump、单一主要 Runtime，没有多 Worker、Kubernetes 高可用和 MicroVM 隔离。项目的重点是先把任务语义、恢复不变量和隔离证据闭合，再演进分布式基础设施。
