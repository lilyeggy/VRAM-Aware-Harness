# Agent Infra 面试演示 Runbook

> 目的：用一条用户任务说明这个项目服务了谁、内部为什么聚焦 Agent 执行环境（③）与执行编排（④），并让每个结论都回到可检查的代码和证据。

## 30 秒定位

这是一个面向团队共享模型的多租户 Agent 任务服务。用户创建自己的 Workspace、提交任务、观察输出并获得 Diff/Artifact；项目不把自己包装成“通用 Agent 平台”，而是在服务这条用户链路时，重点实现可信 Tenant、每 Attempt 容器化工具执行、资源准入/公平队列和安全恢复。

一句话边界：**Pi/vLLM 负责 Agent loop 与模型推理；Harness 负责谁能执行、在哪执行、何时执行、失败后能否安全继续，以及用户最终得到什么。**

## 三分钟现场走查

先运行：

```bash
bun run demo:console
```

浏览器打开终端打印的地址，输入同一终端打印的 demo API Key。该命令使用 Fake Runtime，
用于演示真实 HTTP/认证/控制面链路；不要把它说成 Docker 或模型性能测量。

| 时间 | 操作与应说的话 | 代码锚点 | 可见证据 |
| --- | --- | --- | --- |
| 0:00–0:25 | 创建 Workspace。客户端不提交宿主机路径，也不自报 Tenant。 | `src/http/harness-http-api.ts: submitRun()`；`src/workspaces/workspace-service.ts` | UI 只提交 `workspaceId`；目录由服务端生成。 |
| 0:25–0:45 | 提交任务。API Key 解出 Principal，Tenant 不可伪造。 | `src/auth/api-credential-store.ts`；`HarnessHttpApi.requirePrincipal()` | `tests/http/tenant-boundary.test.ts`：伪造 `tenantId` 无效、跨 Tenant Run 返回 404。 |
| 0:45–1:15 | 打开任务历史和输出。任务先进入 Queue，资源决策决定何时运行。 | `src/scheduling/run-queue-coordinator.ts`；`src/resources/resource-admission-service.ts`；`src/runs/run-output-store.ts` | Run 状态、输出、决策和队列位置均可查询。 |
| 1:15–1:55 | 说明真实执行路径：Run → Attempt → Sandbox → Pi tools → `docker exec`；default 还必须取得 `runsc` inspect 证据。 | `src/runtime/managed-agent-runtime.ts`；`src/sandbox/oci-sandbox-spec.ts`；`src/sandbox/container-runtime-adapter.ts`；`src/runtime/pi-tool-gateway.ts` | profile、runtime、Sandbox ID、OCI 限制与 ToolGateway checkpoint 是可审计事实；runtime 不匹配会 fail closed。 |
| 1:55–2:25 | 展示终态输出、Diff 和 Artifact；说明 Artifact 为何不是当前 Workspace 的软链接。 | `src/workspaces/run-workspace-result.ts`；`src/workspaces/run-artifact-store.ts` | Artifact 复制前验证 hash，使用 `wx` 固化；随后 Workspace 改动不影响它。 |
| 2:25–3:00 | 说明故障/安全恢复：容器消失不是普通 tool error，未知副作用不自动重放。 | `ContainerSandboxProvider.markLost()`；`src/checkpoints/recovery-service.ts`；`src/tools/tool-gateway.ts` | Stage 2 测试证明 LOST → Attempt/Run/Instance 收敛；Checkpoint 证明可恢复边界。 |

## 追问速答

### 为什么不是进程隔离？

同一宿主机普通进程默认仍共享宿主文件系统和网络命名空间，无法构成 Tenant 执行边界。这里每
Attempt 使用独立 OCI 容器，只挂载自己的 Workspace，并应用非 root、只读 RootFS、cap drop、
no-new-privileges、PID/CPU/内存、默认无网络；多租户 default 还必须由 `docker inspect` 证明
实际 runtime 是 `runsc`。入口是 `OciSandboxSpecCompiler` 与
`DockerRunscRuntimeAdapter`。这仍不等于独立 guest kernel 或生产级隔离。

### 容器 UID 如何访问 0700 Workspace？

`WorkspaceService` 在容器模式用 `HARNESS_CONTAINER_USER_ID`（默认 65532）交接新目录所有权，
Container Provider 用同一 UID 运行；交接失败则创建 Workspace 失败。这比把目录放宽到
`777` 或在运行中发现权限错误更安全。

### Secret 如何隔离？

策略的 `allowedSecrets` 只决定名称是否允许；值经 `SecretProvider.get(tenantId, name)` 按
Tenant namespace 读取。默认环境变量格式为
`HARNESS_SECRET_<TENANT_UTF8_HEX>_<NAME>`，不允许全局同名 fallback，且数据库只保存名称。

### 容器被 kill 后怎么办？

`docker exec` 发现容器不存在或已停止会转为 `Sandbox LOST`，由 `ManagedAgentRuntime` 更新
Attempt/Run/Instance 并释放调度语义。恢复必须经过 Checkpoint 与 ToolExecution：已成功工具
不重复，未知副作用进入人工审查。

### 当前还不能声称什么？

- 当前机器没有可连接 Docker daemon/runsc 证据，未完成真实 Linux Docker/A6000 攻击、性能和
  kill 演练；单测中的 Docker command fake 不替代真机证据。
- Artifact、输出与 Diff 已实现；完整工具时间线 UI 和 `REVIEW_REQUIRED` 的人工操作页面仍是后续
  增强，不影响当前最小用户闭环。
- 不声称对恶意宿主管理员、内核漏洞或容器逃逸提供防御。

## 复盘必读顺序

1. `docs/adr/0009-build-a-multi-tenant-agent-task-service.md`：项目为什么是用户服务、为何内部聚焦③④层。
2. `docs/multi-tenant-agent-task-service-roadmap.zh-CN.md`：当前范围、完成条件和非目标。
3. `docs/implementation-log/2026-08-p0-tenant-sandbox.zh-CN.md`：每条能力的代码调用链与测试索引。
4. 本文：将代码事实压缩成一次可讲的用户旅程。
