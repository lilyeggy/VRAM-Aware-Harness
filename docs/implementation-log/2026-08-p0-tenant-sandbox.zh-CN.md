# P0 实施记录：可信租户入口与容器 Sandbox

> 目标：把“多租户 Agent 任务服务”的安全边界落实为可运行、可测试、可复盘的纵向切片，而非再增加一层概念架构。

## 这轮交付解决了什么

客户端不再能够指定 `tenantId` 或宿主机 `workspacePath` 来决定任务归属与执行目录。服务端从 API Key 解出 `RequestPrincipal { subjectId, tenantId, scopes }`，再由受管 `workspaceId` 找到该租户唯一可用的目录；Run 的读、事件、打断和恢复都在返回前检查同一 Tenant，跨租户统一返回 404。

每个受管 Attempt 可使用一个独立 Docker 容器：非 root UID、只读根文件系统、删除 Linux capabilities、`no-new-privileges`、PID/CPU/内存限制、默认无网络、仅把该 Workspace 挂到 `/workspace`，并只注入策略允许的 Secret。容器 Sandbox 还暴露了 `execute(sandboxId, command)` 这个真实命令边界，供下一小步将 Pi 的内置文件/命令工具完全切换到容器执行。

## 已落地的关键文件

| 目标 | 代码 | 可验证事实 |
| --- | --- | --- |
| API Key → Principal | `src/auth/api-credential-store.ts` | 数据库存 SHA-256 摘要，不存明文；撤销后认证失败。 |
| 受管 Workspace | `src/workspaces/workspace-service.ts` | 路径由服务端在 `HARNESS_WORKSPACE_ROOT/<tenant>/<uuid>` 生成。 |
| Tenant HTTP 边界 | `src/http/harness-http-api.ts` | `/health` 公开；其余 Composition 路由需要 Key；IDOR 返回 404。 |
| 容器策略编译 | `src/sandbox/oci-sandbox-spec.ts` / `src/sandbox/container-runtime-adapter.ts` | OCI 参数与 runtime adapter 分离；磁盘 bind-mount 额度无法可信落实时 fail closed，default 必须取得 runsc inspect 证据。 |
| 持久化 | migration v8 | `api_credentials`、`workspaces` 在 SQLite 中可审计。 |

## 代码导航：从请求到隔离执行

下面不是“文件清单”，而是复盘时应沿着阅读的实际调用链。每次新增能力都在此处补上
入口、输入/输出以及不能绕过的约束。

```text
HTTP Request + Bearer API Key
  -> src/http/harness-http-api.ts: HarnessHttpApi.requirePrincipal()
  -> src/auth/api-credential-store.ts: authenticate()  (SHA-256 digest lookup)
  -> RequestPrincipal { subjectId, tenantId, scopes }
  -> src/workspaces/workspace-service.ts: getForTenant(workspaceId, tenantId)
  -> HarnessApplication / RunQueueCoordinator / RunService
  -> ManagedAgentRuntime.create Sandbox / create Attempt
  -> ContainerSandboxProvider.create()  (docker run hardened flags)
  -> PiAdapter.createGatewayTools(... sandboxId)
  -> Pi Tool -> ToolGateway (PREPARED / checkpoint / replay boundary)
  -> SandboxCommandExecutor.execute(sandboxId, ...) -> docker exec
```

### A. 认证、Tenant 和 HTTP 资源边界

| 文件 / 符号 | 实现内容 | 复盘时应确认 |
| --- | --- | --- |
| `src/storage/migrations.ts` v8 | 新增 `api_credentials` 与 `workspaces`；凭证只保存摘要、Workspace 保存服务端根路径。 | 数据库中没有 API Key 明文，且 Workspace 有 `tenant_id`。 |
| `src/auth/request-principal.ts` | `RequestPrincipal` 与 scope 判断。 | Tenant 的唯一来源是 Principal，不是 HTTP body。 |
| `src/auth/api-credential-store.ts` | `create()` 校验 Key / Tenant 格式并存 digest；`authenticate()` 只接受未撤销凭证。 | 解释为何 Key 不能从数据库反推，撤销为何即时生效。 |
| `src/audit/access-audit-store.ts` | 追加式保存 `ALLOW/DENY`、actor、Tenant、action 与原因。 | 不存 Authorization header 或 API Key；查询只能按 Tenant 聚合。 |
| `src/http/harness-http-api.ts: GET /audit` | 需显式 `audits:read`，再按 Principal Tenant 查询访问审计。 | 审计查询自身的 allow 事实也会被追加，因此返回结果可包含本次查询；不会混入其它 Tenant。 |
| `src/workspaces/workspace-store.ts` | 以 `(workspaceId, tenantId)` 查询 Workspace。 | 此处是 IDOR 的数据访问收口点。 |
| `src/workspaces/workspace-service.ts` | 仅在 `HARNESS_WORKSPACE_ROOT/<tenant>/<uuid>` 下创建目录。 | 外部 API 不接受绝对宿主机目录。 |
| 同文件 `executionUid` provisioning | Container 模式在持久化 Workspace 前检查/交接目录 owner 到 `HARNESS_CONTAINER_USER_ID`（默认 65532）。 | 保持 `0700` 的同时让容器非 root UID 能读写自己的 bind mount；无权限 chown 时 fail closed，不创建不可执行 Workspace。 |
| `src/http/harness-http-api.ts` | 除 `/health` 外，在 Composition 中均要求 Key；提交只收 `workspaceId`；Run 返回前二次检查 Tenant。 | A 知道 B 的 Run ID 时为什么仍是 404，而非 403 或泄露元数据。 |
| `src/app/create-harness-application.ts` | 创建 Store/Service，并将认证与 Workspace 服务注入 HTTP API。 | 认证不是 controller 里的临时 if，而是 Composition 的默认边界。 |

### B. 每 Attempt 的容器边界

| 文件 / 符号 | 实现内容 | 复盘时应确认 |
| --- | --- | --- |
| `src/sandbox/sandbox-provider.ts` | Provider 生命周期合同；`SandboxCommandExecutor` 表示“命令必须去哪个环境执行”。 | 生命周期与命令执行是两个不同但关联的合同。 |
| `src/sandbox/container-sandbox-provider.ts: ContainerSandboxProvider.create()` | 创建 `PROVISIONING → ACTIVE` 记录后运行 Docker；失败保存 `FAILED` 理由。 | Attempt 没有 Sandbox 就不应进入运行态。 |
| `src/sandbox/oci-sandbox-spec.ts: OciSandboxSpecCompiler` | 编译 `--user 65532:65532`、`--read-only`、`--cap-drop ALL`、`no-new-privileges`、`--pids-limit`、`--cpus`、`--memory`、`--network none`、唯一 `/workspace` mount；不把 Secret 值放入 spec。 | 逐个说明这些参数防的是什么攻击；runtime adapter 另行证明实际 runtime。 |
| `src/app/harness-config.ts: HARNESS_CONTAINER_USER_ID` | 将 Workspace provisioning UID 和 Docker `--user UID:UID` 固定为同一个正整数。 | 不允许 root UID；改变 UID 必须同时影响目录所有权与容器身份。 |
| `src/sandbox/managed-local-sandbox.ts: EnvironmentSecretProvider` | `get(tenantId, name)` 只读 `HARNESS_SECRET_<TENANT_UTF8_HEX>_<NAME>`；没有全局同名回退。 | `tenant-a` 与 `tenant_a` 的 namespace 不碰撞；Secret 名称限制为大写环境变量段。 |
| `src/sandbox/container-sandbox-provider.ts` / `managed-local-sandbox.ts` | 创建 Sandbox 时把 `policy.tenantId` 传入 SecretProvider。 | Policy 只决定“可否使用该名称”，Provider 决定“该 Tenant 的值是什么”，两层不能互相替代。 |
| 同文件 `execute()` | `docker exec --workdir /workspace <container>`；Sandbox ID 只能映射到当前进程持有的容器名。 | 工具不拿宿主机 shell，也不能凭路径选择别的容器。 |
| 同文件 `markLost()` | `docker exec` 返回 `No such container` / stopped-container 语义时，ACTIVE Sandbox 转为 LOST、擦除内存 Secret/容器映射并发出生命周期事件。 | 容器消失不再被误归类为普通 Tool 错误；`ManagedAgentRuntime.onSandboxFailure()` 可把它收敛到 Attempt/Run/Instance。 |
| `src/runtime/managed-agent-runtime.ts` | 在 inner Runtime 前创建 Sandbox，并将 `sandboxId` 放入 `RuntimeExecutionContext`；finally 中终止。 | 这是 Attempt / Sandbox 生命周期收敛点。 |
| `src/app/create-harness-application.ts: createPiRuntime()` | 仅当 Provider 实现 `execute` 时，把它注入 PiAdapter。 | ManagedLocal 测试路径保持兼容；容器路径才启用真实 command boundary。 |

### C. Pi Tool 如何避免回到宿主机

| 文件 / 符号 | 实现内容 | 当前边界 |
| --- | --- | --- |
| `src/runtime/pi-adapter.ts: createGatewayTools()` | 从 `RuntimeExecutionContext` 取得 `sandboxId`，连同 ToolGateway 和 executor 传给 Tool 定义。 | Adapter 不自行创建容器，只消费受管执行上下文。 |
| `src/runtime/pi-tool-gateway.ts: createSandboxedPiToolDefinition()` | 把 Pi 的宿主路径转换为容器 `/workspace/...`，并为 `bash/read/write/edit/ls` 注入容器 operations。 | 这五类工具的 I/O 或命令会通过 `docker exec`。 |
| 同文件 `grep/find` 分支 | 使用容器内 `grep/find` 实现最小搜索后端。 | 不调用 Pi SDK 默认的宿主机 `rg/fd`；高级 glob/.gitignore/流式显示待增强。 |
| `src/tools/tool-gateway.ts` | Sandbox 内真正执行前仍先写 `PREPARED`；完成后原子保存 Tool 结果与 Checkpoint。 | 隔离没有取代副作用恢复语义，两层共同存在。 |
| `src/runs/run-output-store.ts` | `text_delta` 按 Run 序号追加到 SQLite，并可拼接成 `finalText`。 | 用户结果在进程重启后仍可读取，不只依赖 WebSocket/内存。 |
| `src/runs/run-service.ts: subscribeToRuntime()` | 收到 `text_delta` 即写入 `RunOutputStore`，不混入控制状态事件。 | 输出时间线与 Run 状态机分离，但同属一个 Run。 |
| `src/http/harness-http-api.ts: GET /runs/:id/output` | 先执行 Tenant-scoped `getRequiredRun()`，再返回 chunks 与最终文本。 | 知道他人 Run ID 也不能读取回答。 |
| `src/workspaces/workspace-snapshot.ts` | 扫描受管 Workspace，生成 SHA-256 文件 manifest，再比较为 added/modified/deleted。 | 忽略 `.git`、`node_modules`、symlink 与超大文件；目录在收尾时已被清理则视为空 manifest，形成删除证据而不阻断 slot/状态收敛。 |
| `src/workspaces/run-workspace-result-store.ts` | 将 `BEFORE/AFTER` manifest 和物化 Diff 分别写入 SQLite。 | 进程重启后仍能回看任务对目录的文件级影响；不保存文件正文。 |
| `src/workspaces/run-artifact-store.ts` | 仅在终态 Run 中，把 Diff 的 added/modified 文件依照已记录 SHA-256 复制到 Artifact Root，并登记 `run_artifacts`。 | 复制前 `lstat` 拒绝 symlink、验证 size/hash；使用 `wx` 不覆盖既有交付物，Workspace 后续修改不会污染 Artifact。 |
| `src/workspaces/run-workspace-result.ts` | `captureBefore()`/`captureAfter()` 负责快照、对比和持久化；内存丢失时从 `BEFORE` manifest 恢复。 | 失败或中断 Attempt 也会产生截至该时刻的 Diff。 |
| `src/runs/run-service.ts: executeQueuedRun()/executeQueuedResume()` | 在 Runtime 调用的 `finally` 中捕获 AFTER；若 Run 为 COMPLETED/FAILED，再固化 Artifact。 | 这不是文件回滚；它是面向用户和面试复盘的结果证据。INTERRUPTED 只保留可继续演进的 Diff，不 prematurely freeze Artifact。 |
| `src/http/harness-http-api.ts: GET /runs/:id/workspace-diff` | 先经过 `getRequiredRun(..., tasks:read)` 再读取持久化 Diff。 | Tenant A 无法靠猜 Run ID 读取 B 的文件修改摘要。 |
| `src/http/harness-http-api.ts: GET /runs/:id/artifacts[/path]` | Artifact 列表与内容下载均先做 Tenant-scoped Run 授权。 | Artifact 不是从当前 Workspace 直接读取，下载的是固化副本。 |
| `src/http/harness-dashboard.ts` | 同源最小 Task Console：API Key 只放 `sessionStorage`，可创建/选择 Workspace、提交任务、轮询 Run/输出/Diff 和中断。 | UI 不接受 `tenantId`，所有数据仍通过正式 HTTP API 和 Principal 授权路径取得。 |
| `src/http/harness-http-api.ts: GET /` | 在与 API 同一 origin 提供 Task Console。 | 避免外部静态页跨域携带 Key，也避免为展示页复制一套鉴权逻辑。 |
| `src/runs/runstore.ts: listForTenant()` | 按创建时间倒序读取一个 Tenant 的最多 50 条 Run。 | 先以 SQL `tenant_id` 收口，HTTP 仅把 Principal 的 Tenant 传入；UI 不能用全局 Run 列表发现其他用户。 |
| `src/http/harness-http-api.ts: GET /runs` | 用 `tasks:read` 返回当前 Principal 的任务历史。 | 它与 `GET /runs/:id` 的资源级二次校验是互补的：列表防枚举，详情防猜 ID。 |

## 本次增量：Pi 容器工具接入

本轮后，Container Provider 不再只是“可创建的空容器”。`ManagedAgentRuntime` 创建
Attempt 后传出 `sandboxId`；`PiAdapter` 用该 ID 构建同名 customTools，Pi 的工具调用
仍先经过 ToolGateway，随后由 `SandboxCommandExecutor` 转换为对该容器的 `docker exec`。
因此 `bash/read/write/edit/ls` 不会再直接调用宿主机文件系统或 shell。

安全上的刻意限制是：Pi SDK 的 `grep/find` 默认会在宿主机执行 `rg/fd`。本轮已用
`createSandboxedPiToolDefinition()` 重写它们：`grep` 以容器内 `grep` 搜索，`find` 以
容器内 `find` 搜索；两者都经 `SandboxCommandExecutor`，没有回退宿主机。实现没有
复用 SDK 的 `.gitignore`、复杂 glob 和 streaming 细节，这些属于后续兼容性增强，而
不是隔离边界的缺口。

## 本轮攻击与验证证据

运行：

```bash
bun run typecheck
bun test tests/http/tenant-boundary.test.ts tests/sandbox/container-sandbox-provider.test.ts
```

补充回归：`bun run typecheck` 通过；`bun run test` 的 186 项非网络受限测试通过，
真实进程 HTTP 测试在允许回环监听的环境中单独通过（受限 sandbox 会以 `EPERM` 阻止
任何端口监听，属于环境限制而非应用断言失败）。

- 伪造请求体 `tenantId: tenant-b` 仍以 Key 所属的 `tenant-a` 创建 Run。
- `tenant-b` 携带一个真实但属于 `tenant-a` 的 Run ID 得到 404。
- 容器启动参数测试断言了只读 root、无 capability、非 root、无网络、CPU/内存/PID 限制和 `/workspace` 挂载；Secret 值不会进入 `sandboxes` 持久化记录。
- Workspace 逃逸路径和无法在 Docker bind mount 上强制的磁盘配额都会被拒绝，不以“看似隔离”冒充安全保证。
- `tests/runtime/pi-tool-gateway.test.ts` 验证 `bash/read/grep` 实际收到 `sandboxId` 对应的容器命令。

### 真机 Docker 验收的当前环境事实

2026-08-17 在当前开发机执行 `docker ps --format '{{.ID}}'` 时，Docker CLI 返回
`unix:///Users/mac/.docker/run/docker.sock` 不存在，说明 Docker daemon 没有运行或当前
会话没有可用 socket。因此本轮没有伪造“真实容器攻击通过”的结论：现有
`tests/sandbox/container-sandbox-provider.test.ts` 证明的是 Docker 参数编译、命令映射与
fail-closed 行为；真实 `--network none`、只读 RootFS、跨 Tenant mount/Secret、PID/内存
和容器清理攻击仍必须在 Linux Docker daemon（优先 A6000 机器）上执行。

同日第一次执行 `bun run smoke:container` 还暴露了 fake Docker 未覆盖的 CLI 语法：
`--mount type=bind,...,rw` 中的裸 `rw` 不合法。已改为标准
`type=bind,src=<workspace>,dst=/workspace`（bind mount 默认读写），并在
`tests/sandbox/container-sandbox-provider.test.ts` 断言该字符串且拒绝 `,rw` 回归。修正后
smoke 的唯一失败为缺失 Docker socket，未产生容器或 Workspace 残留。

已提供 `scripts/container-sandbox-smoke.ts`（`bun run smoke:container`）作为可复现入口：
它使用 `ContainerSandboxProvider` 本身实际创建/终止容器，并验证 UID、Workspace 写入、
只读 RootFS 与 network-none 外连失败。当前机器 daemon 缺失时不能运行，但脚本本身不会
把缺失 daemon 静默跳过；在有 Docker 的环境应保存其 JSON `PASS` 输出作为真机证据。

## 测试文件索引

| 测试 | 对应证明 |
| --- | --- |
| `tests/http/tenant-boundary.test.ts` | 伪造请求体 tenant 不生效；跨 Tenant Run ID 返回 404。 |
| `tests/audit/access-audit-store.test.ts` | 授权 allow/deny 事实按 Tenant 持久化，且不会泄露凭证内容。 |
| `tests/http/tenant-boundary.test.ts` | `/audit` 只能返回请求身份所属 Tenant 的审计事实。 |
| `tests/integration/harness-process-http.test.ts` | 完整 HTTP 进程通过 Key 创建 Workspace、提交并查询任务。 |
| `tests/sandbox/container-sandbox-provider.test.ts` | Docker 隔离参数、Secret 不持久化、命令执行和 fail-closed 分支。 |
| 同上 | 模拟 `docker exec` 的 missing-container 错误，验证 Sandbox LOST 事件发出；Stage 2 集成测试覆盖其后 Attempt/Run/Instance 收敛。 |
| `tests/sandbox/managed-local-sandbox.test.ts` | 全局 `API_TOKEN` 不会被读取；两个易碰撞 Tenant ID 仍解析到不同 Secret 值。 |
| `tests/workspaces/workspace-service.test.ts` | 容器执行 UID 已是 owner 时不多余 chown；新增 Workspace 的 owner 与执行 UID 一致。 |
| `tests/runtime/pi-tool-gateway.test.ts` | Pi ToolGateway 的副作用包装，以及 Sandbox 工具不会回退宿主机。 |
| `tests/runs/run-output-store.test.ts` | 输出片段顺序、持久化与最终回答拼接。 |
| `tests/workspaces/workspace-snapshot.test.ts` | Workspace manifest 忽略规则及新增/修改/删除 Diff。 |
| `tests/workspaces/run-workspace-result.test.ts` | BEFORE/AFTER Diff 和协调器重建后的 SQLite 可读性。 |
| 同上 | Artifact 固化后 Workspace 再修改，下载内容仍为原始交付物。 |
| `tests/http/harness-http-api.test.ts` | `workspace-diff` API 的协议返回。 |
| 同上 | 根路径返回可用的同源 Task Console（`TASK CONSOLE` 标识）。 |
| 同上、`tests/http/tenant-boundary.test.ts` | Tenant-scoped `GET /runs` 只返回 Key 所属 Tenant 的历史。 |
| `tests/integration/stage1-stage2-control-plane.e2e.test.ts` | Attempt、策略、Sandbox 丢失与 Instance/Run 收敛链未因新增接入而回归。 |

## 运行配置与下一步

生产演示需要设置：`HARNESS_BOOTSTRAP_API_KEY`（至少 16 位）、`HARNESS_SANDBOX_PROVIDER=container`、可选 `HARNESS_CONTAINER_IMAGE`。默认 `managed-local` 只保留给历史测试/开发，不应作为多租户演示的执行环境。

用于 UI/控制面现场走查的 `bun run demo:console` 位于
`src/demo/task-console-demo.ts`：它启动真实 HTTP Composition、SQLite、API Key、Workspace、
队列和同源页面，但替换模型 Runtime 和 ResourceObserver 为 `DemoAgentRuntime`/Fake 读数。
`src/demo/demo-agent-runtime.ts` 会发送可持久化的 `text_delta` 作为页面结果示例。它是
“用户旅程和控制链演示”，不是 Container/GPU 证据，不能代替下方 Docker 真机验收。

### 2026-08-17：同源控制台中文乱码修复

现场运行 `src/demo/task-console-demo.ts` 时发现同源控制台把中文渲染为可见的
`\\uXXXX` 字符串。根因不在 HTTP `charset`（`dashboardResponse()` 已明确返回
`text/html; charset=utf-8`），而在 `src/http/harness-dashboard.ts` 中将 HTML 模板包在
`String.raw` 内：Bun 对源码非 ASCII 字面量的转义没有被模板还原，因而被当作普通页面文本。
现已改为普通模板字符串；`tests/http/harness-http-api.test.ts` 同时断言页面含有真实中文
“提交任务，看到它如何结束。”且不含对应的 `\\u` 转义，防止复发。验证：`bun run typecheck`
与 `bun test tests/http/harness-http-api.test.ts tests/http/tenant-boundary.test.ts` 均通过。

### 2026-08-17：Sandbox 技术路线决策（尚未实现）

对现有实现的定位已明确：`src/sandbox/container-sandbox-provider.ts` 是 Docker/runc 的
硬化 Provider，不是 microVM，也不提供独立 Linux kernel。它现有的 `SandboxProvider`、
`SandboxCommandExecutor` 与 `SandboxInstance` 生命周期合同将保留，作为下一迭代替换
runtime 的稳定接口，而不是重写控制面。

下一步的实现决策是：OCI/Docker 保留为镜像、命令和生命周期接口；gVisor/runsc 成为
多租户 `default` profile 的实际运行时；`strict` profile 只预留 Kata/Firecracker/托管
microVM Provider 的路由位置，不在本项目内自研 VMM。必须实现的代码落点是
`src/sandbox/sandbox-provider.ts`（profile/runtime 合同）、
`src/sandbox/container-sandbox-provider.ts`（OCI 参数编译与 runtime adapter 分离）、
`src/app/harness-config.ts`（运行时配置）和
`src/app/create-harness-application.ts`（按 profile 组装 Provider）。

关键不变量：任何 gVisor 不支持的能力不得静默回退到 Docker/runc；策略必须拒绝或路由到
`strict`。下一轮验收也必须记录实际 `runsc` 证据以及跨 Tenant 文件/Secret、宿主路径、
外网、资源耗尽和 Sandbox 丢失攻击结果。

下一迭代先补 Linux 上的 gVisor/runsc 真机 smoke、运行时不允许静默回退至 runc 的证明，以及容器意外消失后的恢复收敛测试；随后补基于真实 API Key 的端到端审计日志、工具时间线和人工恢复操作。当前所有默认 Pi 工具已接到容器；但在真机攻击与恢复证据完成前，仍不应把这称为“生产级隔离”。

### 2026-08-17：P0.5 Sandbox 运行时分级第一步（已实现，真机待验证）

本次没有重写控制面，而是在原有 `SandboxProvider` 生命周期和 Pi 命令边界上增加不可变运行时证据：

| 文件 / 符号 | 本次变更 | 测试 / 边界 |
| --- | --- | --- |
| `src/sandbox/sandbox-profile.ts`：`SandboxProfile`、`SandboxSpec`、`SandboxRuntimeEvidence` | 定义 `development/default/restricted-egress/strict` profile、`managed-local/runsc/runc/...` runtime、每 Attempt 的只读 spec 和实际 runtime 证据。 | 类型检查通过；spec 不包含 Secret 值。尚未在真实 SQLite 旧库升级后做现场验证。 |
| `src/policies/effective-policy.ts`：`sandboxProfile`、`withSandboxProfile()` | profile 进入策略快照；显式策略 profile 优先，进程配置仅作为默认；策略 profile 冲突仍 fail closed。default/restricted/strict 的平台编排默认关闭网络。 | `tests/policies/*` 回归由全量测试覆盖；未在 Bun 不可用的当前会话执行测试。 |
| `src/sandbox/oci-sandbox-spec.ts`：`OciSandboxSpecCompiler` | 只编译 OCI 安全参数和无 Secret 的 `SandboxSpec`；磁盘配额、Workspace 越界、restricted 直连网络和 default 使用非 runsc 均拒绝。 | `tests/sandbox/container-sandbox-provider.test.ts`、`tests/sandbox/sandbox-runtime-profile.test.ts`；只证明确定性编译和 fail-closed。 |
| `src/sandbox/container-runtime-adapter.ts`：`DockerRunscRuntimeAdapter` | OCI 参数编译与实际 runtime adapter 分离；启动参数显式加入 `--runtime runsc`，随后 `docker inspect` 必须观察到 `runsc`，否则清理并将 Sandbox 置为 `FAILED`，绝不回退 runc。 | 新增 runsc 证据、runc 拒绝和 inspect 返回 runc 的测试；没有 Linux Docker/runsc 真机证据。 |
| `src/sandbox/container-sandbox-provider.ts`、`src/sandbox/sandbox-store.ts`、migration v13 | `SandboxRecord` 持久化 profile、runtime、spec 和 `runtimeEvidence`；Secret 仍只持久化名称；LOST/FAILED/TERMINATED 沿原生命周期合同收敛。 | 既有 LOST fake 测试保留；SQLite migration/typecheck 未替代真机清理与 kill 验证。 |
| `src/sandbox/sandbox-provider-router.ts`、`src/app/create-harness-application.ts` | `strict` 路由到显式 `UnavailableStrictSandboxProvider`；Kata/Firecracker/托管 microVM 只保留 Provider 插槽，不自研 VMM。 | strict 无 Provider 时测试确认拒绝；尚未接入真实 microVM。 |
| `src/app/harness-config.ts`、`.env.example` | 容器默认 profile/runtime 为 `default/runsc`；ManagedLocal 明确限制为 `development`，default/restricted 禁止配置 runc。 | `tsc --noEmit` 通过；当前环境缺少 `bun`，所以 `bun run test` 未能执行。 |

当前能说的结论：源码会把 `runsc` 选择和 `docker inspect` 观察结果关联到每个 Sandbox 记录，且 runtime 不匹配会 fail closed。当前不能说的结论：没有 Linux Docker daemon + gVisor/runsc 真机输出，不能声称 default 实际运行在 gVisor，也不能声称跨 Tenant 文件/Secret、宿主路径、外网、fork bomb、资源耗尽或 Sandbox kill 攻击已通过。这些仍是 P0.5 的下一项真机验收。

### 2026-08-17：攻击式真机 smoke 入口已补齐（未执行）

新增 `scripts/container-sandbox-attack-smoke.ts` 与 `bun run smoke:container:attacks`。它只接受真实 Docker 命令，不使用 fake：启动两个 `default/runsc` Sandbox，验证两个 Tenant 的 Workspace/Secret/路径不可见、宿主路径不可见、默认网络不可外连，并以受限 PID/临时文件压力和直接 `docker rm --force` 验证资源边界及 `LOST` 事件。该脚本是验收入口而非已通过的证据；当前环境没有 Bun，也没有 Linux Docker/runsc，因此这些攻击检查尚未执行，脚本中资源压力的实际退出行为仍需在 A6000 Linux 机器记录原始输出。

### 2026-08-17：Sandbox runtime benchmark runner 已补齐（未执行）

新增 `scripts/sandbox-runtime-benchmark.ts`、`bun run benchmark:sandbox` 和
`docs/sandbox-runtime-benchmark-runbook.zh-CN.md`。当前 runner 使用同一 Alpine 镜像、非 root UID、Workspace、CPU/内存/网络策略和每 Attempt 生命周期，分别测 runc baseline 与 runsc 的冷启动、`docker exec` 命令往返、文件/tmpfs I/O 和清理耗时，并保存每轮实际 inspect runtime。结果只输出描述性 P50/P95 和比值，不自动宣称哪个 runtime 更安全或更适合。

Kata/Firecracker 尚无本项目 Provider，因此没有伪造 benchmark 结果；接入 strict Provider 后应直接复用同一结果 schema 和控制变量。当前环境缺少 Bun、Linux Docker 和 runsc，benchmark 尚未执行。

### 2026-08-17：租赁服务器前的部署准备已补齐（已实现，真机待执行）

新增：

- `scripts/server-preflight.sh` / `bun run preflight:server`：检查 Linux/x86_64、CPU、内存、磁盘、Docker daemon、cgroups v2、runsc 注册、真实 `docker --runtime runsc` smoke、Bun 和可选 KVM；FAIL 不会被包装成可部署。
- `docs/linux-server-deployment-runbook.zh-CN.md`：从 Ubuntu Server、非 root 服务用户、容器 UID/Workspace 权属、外部 Model API、环境文件、systemd 到首轮 Workspace/Sandbox 验收的完整步骤。
- `deploy/harness.service.example`：以 `harness` 用户运行 Harness，容器 UID 建议与服务用户 UID 对齐，避免把 Workspace 放宽到 `777` 或让 Harness 以 root 运行。

本次没有新增云端 Workspace 存储；当前 Workspace 仍是服务端受管目录，服务会按 `workspaceId + tenantId` 自动创建，不需要服务器管理员手工创建 Tenant 目录。对象存储、跨机器同步和长期 snapshot 仍不是本项目面试版的前置条件。当前环境只能通过 `bash -n` 和 `tsc --noEmit` 验证脚本/类型，Ubuntu Docker/runsc 真机 preflight 仍待租到服务器后执行。

### 2026-08-17：全仓库交互课程页面已补齐

新增 `docs/repository-course.zh-CN.html`，将现有 `complete-project-detail-course.zh-CN.md`、README、ADR 0009、路线图、P0 实施记录和当前源码入口整合为无需构建依赖的网页课程。页面包含：一次 Run 的 HTTP → Principal → Workspace → Queue/Admission → Attempt/Policy → Sandbox → Pi/ToolGateway → Diff/Artifact 调用链；模块化源码地图；Run/Attempt 生命周期；P0.5 runtime profile 对照；测试/真机证据边界；Linux 部署入口；面试追问速答。页面明确 `ManagedLocal`、runsc 真机待验证和 strict Provider 未实现等边界，不把交互图当作安全证据。

### 2026-08-18：Linux 真机 Sandbox 验收第一轮已通过（ECS 8 vCPU / 32 GiB）

在阿里云 ECS（Ubuntu 24.04.4，x86_64，8 vCPU/30 GiB 可用，Docker 29.7.2，runsc release-20260810.0，无 /dev/kvm）上完成了第一轮真机验收，原始环境与结果保存在服务器 `/data/harness/benchmarks/`（`environment.txt`、`benchmark-2026-08-18.json`）：

- `bun run test`：204 pass / 0 fail / 792 expect，全绿；
- `smoke:container`：PASS，确认 `runsc_runtime_evidence`、non-root UID、Workspace 写入、只读 RootFS、默认无网络；
- `smoke:container:attacks`：PASS，确认跨 Tenant Workspace/Secret 不可见、宿主路径不可见、路径穿越失败、默认网络外连失败、PID 与 tmpfs 限制生效、直接 `docker rm --force` 后 Sandbox 收敛为 LOST；
- `benchmark:sandbox`：runc 与 runsc 均 PASS，runsc 冷启动 P50 163ms（runc 134ms，比值 1.22），命令往返 P50 33ms（runc 40ms，比值 0.83），I/O P50 43ms（持平），cleanup P50 64ms。该数据只描述此 ECS 环境，不泛化为 A6000 或生产结论；
- HTTP 闭环：`/health`、创建 Workspace、提交 Run（QUEUED→COMPLETED）、策略决策 `START/RESOURCE_NORMAL`、输出 `finalText` 全部成功；
- 修复：busybox `dd` 只接受大写单位，`bs=1m` 会导致 benchmark 的 I/O workload 与攻击 smoke 的 tmpfs 检查假阳性；改为 `bs=1M` 后验证为真阳性（128 MiB > 64 MiB tmpfs 由 ENOSPC 限制）。

仍不能声称：没有 `/dev/kvm`，Kata/Firecracker strict 仍未做；A6000/vLLM 的 GPU 准入与真实 Pi→模型链路仍待 GPU 主机；跨架构性能结论不做。

### 2026-08-18：真实 Pi + 外部模型 + runsc Sandbox 端到端已跑通

新增 `scripts/server-model-api-demo.ts`：复用现有 `startHarnessProcess`，注入一个明确的 Fake 资源观察器（NORMAL）后，在服务器启动真实 Pi + 外部 OpenAI 兼容模型 + runsc Sandbox。外部模型 API（opencode/deepseek-v4-flash）不暴露 vLLM `/metrics`，因此默认 VllmResourceObserver 会让所有任务卡在 RESOURCE_UNKNOWN（fail-closed）；这个注入是有意且明确标注的演示，不作为 VRAM 准入的真机证据。

真机验证（ECS，opencode/deepseek-v4-flash）：提交一个要求“创建并读取 hello-real-pi.txt”的任务后，Run 事件时间线完整反映了真实 Agent 循环：RUN_CREATED→RUN_STARTED→MODEL_STARTED(provider=opencode, model=deepseek-v4-flash)→MODEL_COMPLETED(stopReason=toolUse, 2186/171 tokens)→TOOL_STARTED(write)→TOOL_COMPLETED→MODEL_STARTED→MODEL_COMPLETED→TOOL_STARTED(read)→TOOL_COMPLETED→MODEL_STARTED→MODEL_COMPLETED→RUN_COMPLETED。模型真实生成 write/read 工具调用，工具在 runsc Sandbox 的 Workspace 中实际创建文件 `hello-real-pi.txt`（29 字节），workspace-diff 捕获 added 项，服务器文件内容确认为 `Hello from real Pi over runsc`，最终文本正确总结。

这证明：真实模型与 Pi 的模型—工具循环、PiAdapter 到 ToolGateway 的工具治理、以及工具经 runsc Sandbox 命令边界在 Workspace 落盘，都在真机闭环。仍不能声称的边界：资源观察器是 Fake（VRAM/GPU 准入仍待 A6000）；Kata/Firecracker strict 仍待 KVM；外部模型的计费元数据以端点返回为准。
