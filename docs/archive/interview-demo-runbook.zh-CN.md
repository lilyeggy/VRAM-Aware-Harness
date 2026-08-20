# Agent Infra 面试演示 Runbook

> 目的：用一条用户任务说明这个项目服务了谁、内部为什么聚焦 Agent 执行环境（③）与执行编排（④），并让每个结论都回到可检查的代码和证据。  
> 更新日期：2026-08-19。已同步 P0.5 真机验收与 A/B/C 三个差异化方向。

---

## 30 秒定位

这是一个面向团队共享模型的**多租户 Agent 任务控制面**。用户创建 Workspace、提交任务、观察输出并获得 Diff/Artifact；系统重点实现可信 Tenant、每 Attempt 容器化工具执行、资源准入/公平队列、安全恢复，以及最近的执行质量评测、观测驾驶舱和 LLM 路由网关。

**一句话边界**：Pi/vLLM 负责 Agent loop 与模型推理；Harness 负责谁能执行、在哪执行、何时执行、失败后能否安全继续、**执行质量如何度量、模型调用如何路由**，以及用户最终得到什么。

---

## 一分钟电梯演讲（推荐背诵）

> 我做了一个多租户 Agent 任务控制面。Agent 负责"动脑"，我的系统负责"安排与安保"：多租户身份、GPU 资源准入与背压、runsc 沙箱隔离、工具副作用记账与崩溃恢复，以及最近的执行质量评测、观测驾驶舱和 LLM 路由网关。254 个测试全绿，T4 GPU 和 ECS runsc 真机都已验证。

---

## 三分钟现场走查

先运行：

```bash
# 走通核心控制面链路
bun run scripts/demo-console.ts

# 或查看执行质量报告
bun run scripts/eval-report.ts
```

浏览器打开终端打印的地址，输入同一终端打印的 demo API Key。Fake Runtime 用于演示 HTTP/认证/控制面链路；**不要把它说成 Docker 或模型性能测量**——真机证据另有 runbook。

| 时间 | 操作与应说的话 | 代码锚点 | 可见证据 |
| --- | --- | --- | --- |
| 0:00–0:25 | 创建 Workspace。客户端不提交宿主机路径，也不自报 Tenant。 | `src/http/harness-http-api.ts` `submitRun()`；`src/workspaces/workspace-service.ts` | UI 只提交 `workspaceId`；目录由服务端生成。 |
| 0:25–0:45 | 提交任务。API Key 解出 Principal，Tenant 不可伪造。 | `src/auth/api-credential-store.ts`；`HarnessHttpApi.requirePrincipal()` | `tests/http/tenant-boundary.test.ts`：伪造 `tenantId` 无效、跨 Tenant Run 返回 404。 |
| 0:45–1:15 | 打开任务历史和输出。任务先进入 Queue，资源决策决定何时运行。 | `src/scheduling/run-queue-coordinator.ts`；`src/resources/resource-admission-service.ts`；`src/runs/run-output-store.ts` | Run 状态、输出、决策和队列位置均可查询。 |
| 1:15–1:55 | 说明真实执行路径：Run → Attempt → Sandbox → Pi tools → 容器执行；default 还必须取得 `runsc` inspect 证据。 | `src/runtime/managed-agent-runtime.ts`；`src/sandbox/oci-sandbox-spec.ts`；`src/sandbox/container-runtime-adapter.ts`；`src/runtime/pi-tool-gateway.ts` | profile、runtime、Sandbox ID、OCI 限制与 ToolGateway checkpoint 是可审计事实；runtime 不匹配会 fail closed。 |
| 1:55–2:25 | 展示终态输出、Diff 和 Artifact；说明 Artifact 为何不是当前 Workspace 的软链接。 | `src/workspaces/run-workspace-result.ts`；`src/workspaces/run-artifact-store.ts` | Artifact 复制前验证 hash，使用 `wx` 固化；随后 Workspace 改动不影响它。 |
| 2:25–3:00 | 说明故障/安全恢复：容器消失不是普通 tool error，未知副作用不自动重放。 | `ContainerSandboxProvider.markLost()`；`src/checkpoints/recovery-service.ts`；`src/tools/tool-gateway.ts` | Stage 2 测试证明 LOST → Attempt/Run/Instance 收敛；Checkpoint 证明可恢复边界。 |

---

## 5 分钟差异化深挖（A/B/C）

面试官如果说"展开讲讲亮点"，从 A/B/C 里挑一个你最熟的。

### A · 执行质量评测闭环

**问题**：任务能跑不代表跑得好。怎么看"跑得好不好"？

**回答**：
> 我在 `src/eval/evaluation-aggregator.ts` 里复用了 Pi 已经落库的事件和工具执行记录，零新增采集，算出两类指标：
> - 行业标配：成功率、完成度、Token、成本、延迟 P95。
> - 控制面护城河：背压触发率、无人值守率、危险拦截率、cache 命中率。
> 指标输出给 `scripts/eval-report.ts` 文本报表，也通过 `GET /eval` JSON 供观测页消费。

**代码锚点**：`src/eval/evaluation-aggregator.ts`、`src/eval/execution-metrics.ts`、`tests/eval/evaluation-aggregator.test.ts`。

### B · 观测驾驶舱

**问题**：指标算出来，怎么让人一眼看懂？

**回答**：
> 我做了个独立页面 `/observe`，和任务操作台 `/` 解耦。它只读，不会误触任务；支持多租户切换；数据来自 `GET /eval`。
> 可视化包括任务状态环形图、完成度渐变条、租户对比条形图、资源背压堆叠条，以及任务明细表。

**代码锚点**：`src/http/harness-observe-page.ts`、`src/eval/evaluation-aggregator.ts`。

### C · LLM 路由网关

**问题**：模型调用有没有做高可用？

**回答**：
> 我在 Pi 和真实模型后端之间加了一个 OpenAI 兼容代理。Pi 以为自己在正常调 OpenAI，只是把 `baseUrl` 指向网关。
> 网关维护后端路由表，主后端失败（网络错/超时/429/5xx）自动回退到备，连续失败的后端会被熔断，每次选择都记录 `RouteDecision`。
> Agent、控制面调度、沙箱都不变，只改 `models.json` 的 `baseUrl`。

**代码锚点**：`src/llm-gateway/llm-gateway.ts`、`src/llm-gateway/model-router.ts`、`tests/llm-gateway/llm-gateway.test.ts`。

**诚实边界**：网关第一步已完成（mock 后端 10 测试 + 端到端冒烟），第二步（Pi 真实调用经网关）尚未完成；决策记录目前内存缓冲，未持久化。

---

## 追问速答

### 为什么不是进程隔离？

同一宿主机普通进程默认仍共享宿主文件系统和网络命名空间，无法构成 Tenant 执行边界。这里每 Attempt 使用独立 OCI 容器，只挂载自己的 Workspace，并应用非 root、只读 RootFS、cap drop、no-new-privileges、PID/CPU/内存、默认无网络；多租户 default 还必须由 `docker inspect` 证明实际 runtime 是 `runsc`。入口是 `OciSandboxSpecCompiler` 与 `DockerRunscRuntimeAdapter`。这仍不等于独立 guest kernel 或生产级隔离。

### 容器 UID 如何访问 0700 Workspace？

`WorkspaceService` 在容器模式用 `HARNESS_CONTAINER_USER_ID`（默认 65532）交接新目录所有权，Container Provider 用同一 UID 运行；交接失败则创建 Workspace 失败。这比把目录放宽到 `777` 或在运行中发现权限错误更安全。

### Secret 如何隔离？

策略的 `allowedSecrets` 只决定名称是否允许；值经 `SecretProvider.get(tenantId, name)` 按 Tenant namespace 读取。默认环境变量格式为 `HARNESS_SECRET_<TENANT_UTF8_HEX>_<NAME>`，不允许全局同名 fallback，且数据库只保存名称。

### 容器被 kill 后怎么办？

`docker exec` 发现容器不存在或已停止会转为 `Sandbox LOST`，由 `ManagedAgentRuntime` 更新 Attempt/Run/Instance 并释放调度语义。恢复必须经过 Checkpoint 与 ToolExecution：已成功工具不重复，未知副作用进入人工审查。

### 资源背压是怎么被验证的？

AutoDL Tesla T4 + vLLM 0.7.3，120 并发压测下，资源分类器进入 `CRITICAL`，执行策略触发 `QUEUE`，新任务落库排队。见 `docs/gpu-completion-runbook.zh-CN.md`。

### 沙箱隔离是怎么被验证的？

ECS 真机运行 runsc 默认沙箱，`scripts/container-sandbox-attack-smoke.ts` 9 项攻击（跨租户、宿主路径、穿越、Secret、网络、PID、tmpfs、kill→LOST 等）全部 PASS。见 `docs/sandbox-runtime-benchmark-runbook.zh-CN.md`。

---

## 当前还不能声称什么

- **生产级**：单机、单数据库、无 K8s/多机/高可用、无企业 SSO/计费。
- **严格 VM/MicroVM 隔离**：没有 KVM 环境，不声明 Kata/Firecracker strict 隔离通过。
- **LLM 网关完整落地**：第一步已完成，但 Pi 真实调用经网关的第二步尚未完成，决策记录也未持久化。
- **外部 OpenAI 兼容模型做真 GPU 准入**：外部模型 demo 若使用 Fake observer，会明确标注"非 VRAM 证据"。
- **绝对安全**：不声称对恶意宿主管理员、内核漏洞或容器逃逸提供防御。
- **A6000 性能结论**：当前 GPU 真机在 T4 上完成，未在 A6000 上重复验证。

---

## 复盘必读顺序

1. `docs/interview-prep-guide.zh-CN.md`：30 分钟 / 2 小时 / 半天三种准备路线，推荐从这里开始。
2. `docs/adr/0009-build-a-multi-tenant-agent-task-service.md`：项目为什么是用户服务、为何内部聚焦③④层。
3. `docs/multi-tenant-agent-task-service-roadmap.zh-CN.md`：当前范围、完成条件和非目标。
4. `docs/complete-project-detail-course.zh-CN.md`：特别是第八部分（P0.5 验收与 A/B/C）。
5. `docs/implementation-log/2026-08-p0-tenant-sandbox.zh-CN.md`：每条能力的代码调用链与测试索引。
6. 本文：将代码事实压缩成一次可讲的用户旅程。
