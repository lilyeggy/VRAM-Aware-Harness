# VRAM-Aware-Harness 全场景测试指南

> 编制日期：2026-09-10。依据当前工作区的代码、配置和测试编写，包含尚未提交的实现。
> 本文是**待执行的测试方案，不是通过报告**。本次编写未运行压测、故障注入或真机验收。
> 目标：从用户完成真实任务的过程出发，验证结果质量、体验、并发、公平性、资源背压、隔离和恢复，并找出系统可承诺的容量边界。

## 1. 怎么使用这份指南

建议按“基线 → 用户闭环 → 单边界 → 复合场景 → 容量 → 长稳 → 恢复复验”执行。不要一开始把所有故障和最大负载同时打开，否则很难解释失败原因。

全套包含 **74 个基础场景 + 12 个复合剧本**。表中的“必查结果/通过”是验收要求，不表示当前实现已经满足；发现差距时按实际结果登记。

- 首轮必跑：§5 的基础命令、U01–U08、C01–C05、Q01–Q06、R01–R05，以及 X01、X02、X03、X05。
- 完整验收：执行 §7 全部适用场景、§8 的 12 个复合剧本、§9 的容量和长稳计划。
- 容器隔离验收：必须在 Linux + Docker/runsc 环境单独执行；开发模式结果不能替代。
- 单个用例按照“前置条件 → 操作 → 用户可见结果 → 后端事实 → 清理”记录。§7 每行是用例入口，沿用 §3、§4 的公共前置与判定；复合用例有独立详细步骤。

阅读导航：

1. [验收原则与真实边界](#2-验收原则与当前真实边界)
2. [环境、账号和数据](#3-测试环境与隔离准备)
3. [指标与通过标准](#4-统一指标与判定规则)
4. [可执行入口](#5-已有命令与-api-操作入口)
5. [任务与输入样本](#6-固定任务样本与输入长度)
6. [场景矩阵](#7-场景矩阵)
7. [复合场景剧本](#8-复合场景详细剧本)
8. [容量与长稳](#9-容量测试与长时间稳定性测试)
9. [证据、排期与结项](#10-证据采集与报告格式)

## 2. 验收原则与当前真实边界

### 2.1 一次任务要有三份结论

| 维度 | 判断问题 | 例子 |
| --- | --- | --- |
| 系统正确性 | 状态、归属、调度、恢复和清理是否正确？ | 任务超时后释放 Worker 和槽位，其他用户能继续 |
| 任务能力 | 用户要求是否真正完成？ | 测试通过、文件内容和下载物正确，不能只看 COMPLETED |
| 用户体验 | 用户能否知道发生了什么、拿到结果并继续操作？ | 浏览器重开能找到任务，停止可生效，失败有解释 |

例如：模型输出错误代码但正常结束，可能是系统生命周期通过、任务能力失败；系统正确阻止未知副作用重放，但界面只显示“出错”，可能是恢复正确性通过、体验失败。三个结果分开记，不能互相抵消。

### 2.2 已从当前代码核实的边界

| 边界 | 对测试的影响 | 代码入口 |
| --- | --- | --- |
| 当前为单控制进程 + SQLite；默认 Worker 为 `process` | 单 Worker 故障与控制面崩溃分开测；多控制节点 HA 属范围外 | `src/main.ts`、`src/app/harness-config.ts` |
| `/app` 是用户工作台，`/` 是平台页；输出约每 1600ms 轮询 | 不能用 SSE/WebSocket 的预期判断 UI；网关的模型 SSE 是另一条链路 | `src/http/harness-user-console.ts` |
| 同一 HarnessSession 串行，不同对话可共享一个 Workspace | 同会话压测不能代表 GPU 并发；不同对话同文件写入要单独测冲突 | `src/scheduling/tenant-run-scheduler.ts` |
| 后续对话通过 Runtime Session 引用续接 | 必须真实 Pi 多轮验证，Fake 注入引用不能证明记忆内容正确 | `src/runtime/pi-adapter.ts`、`src/runtime/managed-agent-runtime.ts` |
| 默认全局/单租户并发为 30/10，但 `.env.example` 显式设为 2/1 | 每轮冻结最终生效配置，不能把源码默认值当现场容量 | `src/app/harness-config.ts`、`.env.example` |
| 默认队列 TTL 300000ms，执行超时 1800000ms，中断宽限 10000ms | 长任务需单独提高执行超时；TTL 测试使用短配置；停止可能经过两段宽限等待 | `src/app/harness-config.ts`、`src/runtime/supervised-agent-runtime.ts` |
| 队列对账发生在 drain；控制面停止时无法推进 TTL | 停机期间不用期待实时超时，恢复后的第一次有效对账必须处理过期任务 | `src/scheduling/run-queue-coordinator.ts` |
| 恢复取决于 Checkpoint 与未完成工具副作用 | 无 Checkpoint 或不安全 PREPARED 需要人工处理；不要求所有中断任务自动恢复 | `src/checkpoints/recovery-decision.ts` |
| 预算默认以活跃 Run 数为单位 | `weight/maxUnits` 不是金额、token 预算或 GPU 时间公平保证 | `src/resources/budget-aware-policy.ts` |
| Workspace 快照跳过 symlink、`.git`、`node_modules`、`.DS_Store` 和大于 2 MiB 的单文件 | Diff/Artifact 不是完整目录备份；边界用例分别记录实际文件与可见结果 | `src/workspaces/workspace-snapshot.ts` |
| 资源采样、部分路由观测为有界内存数据 | 长稳期间定期导出，重启前导出；采样是主机级，不是单 Run 独占 GPU 用量 | `src/resources/run-observation.ts`、`src/llm-gateway/model-router.ts` |
| `managed-local/development` 没有生产容器隔离保证 | 路径、进程、网络、Secret 攻击的通过证据要求真实 container/runsc | `src/sandbox/container-sandbox-provider.ts` |

历史 [A6000 报告](a6000-deployment-report.zh-CN.md)可以帮助选择回归点，但不能替代本轮代码和环境的证据。该报告使用开发沙箱，并列出缓存字段、完整恢复等证据边界；不要把标题中的通过结论推广到本文全部场景。

本轮特别关注 [已知问题](known-issues.zh-CN.md)中涉及的 Worker 工具治理、真实多轮、网关主链路、排队启动/中断竞态，以及仍未关闭的 Secret argv 暴露等风险。已知问题命中后仍记实际失败，不能因为“已知”而记 PASS。

## 3. 测试环境与隔离准备

### 3.1 三层环境

| 环境 | 组成 | 证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| E0 确定性环境 | Fake Runtime/Observer、SQLite、真实 HTTP；部分用例是真子进程 | 状态机、调度顺序、竞态、账本和故障边界 | 模型质量、真实 GPU 吞吐、容器隔离 |
| E1 真实任务环境 | Pi + 网关 + vLLM + GPU + process Worker | 工具任务、多轮、输出、真实背压、容量 | 如果使用 managed-local，就不能证明 OS 隔离 |
| E2 隔离环境 | E1 + Linux + container + runsc + 已验证镜像 | 多租户实际执行隔离、资源上限、容器故障传播 | 多机 HA、无限负载、任意逃逸防护 |

每条结果附 `E0/E1/E2`，并注明 `REAL / SIMULATED`。在 E1 上注入模拟 worker 仍是模拟模型行为，不能改标为真实 Pi。

### 3.2 环境清单

每次 campaign 使用唯一编号，例如 `scenario-20260910-01`。准备独立的：

- SQLite、Workspace 根目录、Artifact 根目录、Pi 会话目录、日志目录、端口和测试账号。Artifact 当前位于 Workspace 根目录的上级目录下 `artifacts`，所以应隔离整个 campaign 父目录。
- 模型名、模型权重版本、context window、最大输出配置、tool parser、chat template、Pi models.json 路由、vLLM 版本、GPU/驱动、Bun 版本。
- 全局与租户并发、pump/TTL/执行超时/宽限、压力阈值、预算、工具白名单、网络策略、镜像 digest、runsc 版本、warm pool 配置。
- 本轮 checkout 的 commit、dirty 状态与受控源代码快照摘要。当前目录有未提交更改，单独记录 commit 不足以复现。

只记录脱敏配置；不要把 token、密码、models.json 内嵌 API key、实际 Secret 写进公开证据。

E1/E2 启动后，除了 `/health`、`/ready`，还要确认网关模型发现、真实一次推理、一次工具调用、资源观测成功。当前健康接口主要表示应用已经启动，不能证明 GPU/模型可用。

破坏性实验只作用于本轮测试实例：用记录的 PID/container ID 选择目标；磁盘满用受限卷/容器 tmpfs，网络故障用独立代理或隔离网络。不要用 `pkill bun`、填满宿主磁盘或停掉共享 GPU 服务来构造故障。

### 3.3 账号与项目分布

| 身份 | 准备 | 用途 |
| --- | --- | --- |
| 用户 A | 独立注册登录，A1/A2 两个 Workspace，每个至少两个对话 | 重载、连续修改、同租户跨 Workspace |
| 用户 B | 独立注册登录，B1 | 正常短请求、隔离、受邻居干扰程度 |
| 用户 C | 独立注册登录，C1 | 长输入/慢工具/故障制造者 |
| 用户 D | 独立注册登录，D1 | 重连、过期、停止和恢复 |
| 只读测试凭证 | 使用测试夹具经 CredentialStore 创建有限 scope 凭证 | 验证读写权限；不假设存在凭证管理 HTTP API |
| 管理/采集身份 | 本轮独立 bootstrap 凭证 | 采集获准的资源/网关信息，不能替代真实用户做隔离测试 |

高并发逐步扩展到 2/5/10/20 个独立账号。一个账号开 20 个标签页仍然是一个租户。

### 3.4 固定 Workspace 夹具

准备一个小型、可离线运行的代码项目：README、含明确缺陷的函数、固定单元测试、JSON 数据、输出目录。每轮从相同快照复制，并保存文件 SHA-256。

- 基准项目：10–30 个小文件，测试在正常机器上几秒内结束，无联网依赖。
- 大目录项目：1000/10000 个小文件，外加 1 MiB、2 MiB、2 MiB+1 byte、8 MiB 文件。
- 故障项目：失败测试、只读文件、退出码非零的命令、可控等待脚本。
- 隔离项目：A/B 各有唯一的无敏感随机哨兵；宿主测试目录另有 HOST 哨兵。不能用真实用户数据作为泄露探针。

当前没有通用上传/导入项目 HTTP 入口。由测试管理员使用受管 Workspace 的真实 rootPath 在服务端投放固定夹具，或者先通过真实任务创建简单文件；记录准备方式，准备耗时不算进任务延迟。对容器工具任务，镜像必须具备夹具需要的解释器/测试运行器，不能把缺依赖误判为模型失败。

## 4. 统一指标与判定规则

### 4.1 结果状态

- `PASS`：执行过且全部必需断言有证据。
- `FAIL`：已经触发场景，实际行为违反合同或本轮预先冻结的体验目标。
- `BLOCKED`：缺 GPU、容器、测试夹具等前置条件。
- `INCONCLUSIVE`：已尝试但未抓到故障窗口、样本不足或证据缺失。
- `NOT_RUN`：还未执行。
- `OUT_OF_SCOPE`：明确超出单节点产品承诺；记录原因，例如多控制面主动接管。

未观察到瞬时 `WAITING_TOOL` 不能直接 FAIL：使用有序事件/账本检查实际工具过程；反过来，只有页面字样也不足以证明工具治理有效。

### 4.2 指标口径

| 指标 | 定义与采集 |
| --- | --- |
| 提交响应时间 | 客户端发出请求至收到 202/错误响应；拒绝与接受分组统计 |
| 用户首反馈 | 点击发送至出现任务、状态或可理解错误；浏览器录屏/自动化计时 |
| 首轮队列等待 | `RUN_CREATED → 首次 RUN_STARTED`；恢复队列分 Attempt/恢复段另算 |
| 初始化时间 | `RUN_STARTED → MODEL_STARTED`，用 CONTROL_PREPARED、SESSION_INITIALIZED、SANDBOX_ACQUIRED 拆分 |
| 模型 TTFT | 同一次模型调用 `MODEL_STARTED → MODEL_FIRST_TOKEN`；没有 token 的调用不填 0 |
| 用户可见首字 | 点击发送到页面首次显示回答字符；不能用模型 TTFT 代替 |
| E2E | 提交至结果可查询/可下载；同时记录 Run 终态时间与结果可用时间差 |
| 完成率/正确率 | 完成 Run 数、经外部验收的正确任务数分别除以相应合法任务总数 |
| 有效吞吐 | 单位墙钟时间内通过任务验收的任务数；另报 token/s 和原始完成量 |
| 队列与公平 | 每租户 queue wait p50/p95/max、开始顺序、活跃数、最长未获得服务时间 |
| 停止/恢复 | 点击停止至状态收敛、进程消失、槽位释放；故障解除至继续调度/结果返回 |
| 资源 | Master RSS、Worker RSS 总和、CPU、FD、子进程/容器数、SQLite/WAL、Artifact、Pi Session 大小、GPU/KV/请求数 |
| 可观测完整性 | 可关联 runId 的事件/工具/Checkpoint/结果证据占比；usage 缺失独立计数 |

保存客户端单调时钟的时长和服务器时间戳；比较不同主机前校时。同一 Run 多次模型/恢复事件不能全部套用第一次 MODEL_STARTED。当前 `/observability` 的摘要是便捷观测，严谨统计需从事件重建每段。

### 4.3 硬性不变量

以下任一违反均为阻断问题，不允许靠平均成功率掩盖：

1. 跨租户读取、修改、恢复或下载成功，或 Secret/会话内容泄露。
2. 同一 Run 出现并行实际执行、同一 Session 并发打开、终态被迟到回调错误覆盖。
3. 不安全副作用未经有效裁决自动重放；人工“继续”绕过阻断检查。
4. 已接受的任务在无记录情况下消失，持久记录损坏，或文件/Artifact 被错误归属。
5. 任务结束后资源长期不释放，最终导致正常用户无法提交/推进。
6. 系统明知任务失败仍显示成功、返回其他任务的结果，或将不完整输出伪装为完整结果。

### 4.4 建议体验目标（测试目标，尚非现有 SLA）

先做单用户基线，再在执行计划中固定目标，不能测试后为了通过随意移动门槛。

| 项目 | 首轮建议门槛 |
| --- | --- |
| 正常负载提交/查询 API | p95 ≤ 1s、p99 ≤ 3s；登录密码推导单独统计 |
| 用户首反馈 | 点击到反馈 ≤ 2s；服务不可用时给出错误而非永久等待 |
| 输出同步 | 已持久化片段在正常网络下 2 次 UI 轮询内可见，建议预算 5s |
| 停止 | ≤ `2 × interruptGraceMs + 5s` 完成物理清理与状态收敛；另记 Worker 启动/工具阶段差异 |
| 资源恢复后推进 | 合格队首任务在 `3 × pumpIntervalMs + 一次资源观测超时 + 5s` 内获得新决策；结果完成另外计时 |
| 正常固定任务 | 系统无故失败率 ≤ 1%；任务正确率建议 ≥ 95%，所有安全不变量 100% |
| 并发退化 | 固定任务和配置下短任务 p95 E2E 建议不超过单用户基线 3 倍；超过即报告容量/公平性边界 |
| 长稳 | 预热后空闲窗口 Master RSS/FD/存活 Worker 无持续爬升；初筛 RSS 增幅 ≤ 20%，超出需解释缓存与回收 |

p99 至少尽量积累 1000 个有效样本；小批量只报样本数、p50/p95/max，不作稳定 p99 承诺。故障注入的预期失败、超上下文输入和用户主动中断单列，不混入正常成功率；同时报告它们对正常用户的影响。

## 5. 已有命令与 API 操作入口

### 5.1 先跑现有基础验证

在仓库根目录运行；下列命令确实存在，但本次编写未执行：

```sh
bun run test
bun run typecheck
bun run demo:day7
bun run scripts/user-console-smoke.ts
```

`bun run test` 定向运行 `tests`；`demo:day7` 和用户工作台 smoke 使用 Fake，后者检查 HTTP 流程与页面内容，**没有实际操作浏览器**。若 localhost 监听遇到 EPERM，应在允许监听的正常主机/CI 复跑并注明环境阻塞。

优先复用的确定性回归集合：

```sh
bun test ./tests/runs/run-service-queued-start-race.test.ts ./tests/runs/run-service-tool-phase.test.ts
bun test ./tests/scheduling/queue-ttl.test.ts ./tests/scheduling/queue-reconcile.test.ts ./tests/scheduling/queued-run-recovery.test.ts
bun test ./tests/checkpoints/recovery-hardening.test.ts ./tests/runtime/execution-hard-kill.test.ts
bun test ./tests/integration/worker-tool-governance.e2e.test.ts ./tests/integration/blast-radius-isolation.e2e.test.ts
bun test ./tests/http/tenant-boundary.test.ts ./tests/http/session-squatting.e2e.test.ts
bun test ./tests/llm-gateway ./tests/workspaces ./tests/conversations
```

真实服务已启动后可运行：

```sh
# 在 shell 中预先设置本轮测试实例地址和测试 token；不要把 token 写入命令历史。
# HARNESS_BASE_URL 与 HARNESS_API_KEY 由本轮测试配置提供。
HARNESS_SMOKE_USER_INPUT='请创建 hello.txt，内容为 scenario-smoke，然后读取确认。' bun run smoke:http
```

此 smoke 会创建新 Workspace。原默认提示词读取 README，新 Workspace 不保证已有 README，因此上面明确覆盖输入。它仍主要判断生命周期；需要另查 output、Diff、Artifact 及文件内容。

E2 的基础沙箱验证：

```sh
bun run smoke:container
bun run smoke:container:attacks
```

攻击 smoke 会执行有界 PID/tmpfs 压力并删除它自己创建的测试容器。它验证 Provider 边界，后续 S 类用例还要从真实 Pi 工具入口验证没有旁路。

### 5.2 启动配置的最小核对

基于 `.env.example` 建立本轮独立配置，使用 Bun 的显式 env 文件入口，例如：

```sh
# /tmp/harness-scenario.env 须先按 §3 填好；此行不是开箱即用部署脚本。
bun --env-file=/tmp/harness-scenario.env run src/main.ts
```

必查 `VLLM_MODEL_ID`、`VLLM_BASE_URL`、`VLLM_METRICS_URL`、`PI_MODELS_PATH`、`HARNESS_PORT`、`HARNESS_DATABASE_PATH`、`HARNESS_WORKSPACE_ROOT`、两类 API key、`LLM_BACKENDS` 和容器配置。Pi 的 baseUrl 应指向本轮 Harness 的 `/v1`，网关后端指向真实 vLLM，不能反向形成路由环。Pi Session 的实际保存位置也要检查与隔离。

为了先证明排队，建议显式 `HARNESS_MAX_ACTIVE_RUNS=2`、`HARNESS_MAX_ACTIVE_RUNS_PER_TENANT=1`；后续容量再逐档增加。对资源 CRITICAL 的服务盲目提高并发不会证明容量增加。

### 5.3 当前 API 合同速查

所有受保护请求使用 `Authorization: Bearer <本轮 token>`。字段名按表使用；不是 `/api/...` 路径。

| 动作 | 方法与路径 | 请求体/响应要点 |
| --- | --- | --- |
| 注册/登录 | `POST /auth/register`、`POST /auth/login` | `{email,password}`；注册 201，登录返回 token/tenantId |
| 退出 | `POST /auth/logout` | 当前 Bearer 会话撤销；无效/重复撤销为 401 |
| 退出全部设备 | `DELETE /auth/sessions` | 需要 `auth:revoke` |
| 创建/列项目 | `POST /workspaces`、`GET /workspaces` | `{name}`；创建返回 `workspace.id` |
| 创建/列对话 | `POST /workspaces/:id/conversations`、`GET /workspaces/:id/conversations` | `{title}` 可选；返回 conversation |
| 发消息/看对话 | `POST /conversations/:id/messages`、`GET /conversations/:id` | `{userInput,thinkingLevel?}`；发消息 202 `{run}` |
| 独立提交 | `POST /runs` | `{workspaceId,userInput,sessionId?}`；身份从 token 派生 |
| 列任务/详情 | `GET /runs`、`GET /runs/:id` | 详情 `{run,decisions}` |
| 输出与事件 | `GET /runs/:id/output`、`GET /runs/:id/events` | 输出含 chunks/finalText；事件按 sequence 判读 |
| 结果 | `GET /runs/:id/workspace-diff`、`GET /runs/:id/artifacts` | `{diff}` 与 `{artifacts}` |
| 下载 | `GET /runs/:id/artifacts/:encodedPath` | 整个文件相对路径用 `encodeURIComponent(path)`，包括目录分隔符 |
| 停止/恢复 | `POST /runs/:id/interrupt`、`POST /runs/:id/resume` | `{}`；恢复可选 continuationInput，202 不代表已经执行 |
| 队列与观察 | `GET /queue`、`GET /resources`、`GET /runs/:id/observability` | 资源需要 `resources:read`，为主机级遥测 |
| 评估/审计 | `GET /eval`、`GET /audit?limit=100&offset=0` | 按权限和租户查看；审计使用分页 |
| 模型/路由 | `GET /v1/models`、`GET /llm-gateway/stats` | 分别需要 `models:generate`、`models:observe` |

`COMPLETED / FAILED` 是终态；`INTERRUPTED` 是本次等待结束但可能恢复的状态；`WAITING_TOOL` 仍在执行。不要写“不是 QUEUED/RUNNING 就算完成”的轮询条件。

### 5.4 可复制的单用户真实闭环客户端

将以下代码存为本轮证据目录的 `journey.ts`，预先设置 `HARNESS_BASE_URL`、`SCENARIO_EMAIL`、`SCENARIO_PASSWORD` 后用 Bun 运行。邮箱须为本轮新账号。脚本不打印凭证，**仅负责创建与采集，不替代任务质量验收**。

```ts
const base = process.env.HARNESS_BASE_URL?.replace(/\/$/, "");
const email = process.env.SCENARIO_EMAIL;
const password = process.env.SCENARIO_PASSWORD;
if (!base || !email || !password) throw new Error("缺少测试地址或测试账号");
let token = "";
async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}
await api("/auth/register", "POST", { email, password });
token = (await api("/auth/login", "POST", { email, password })).token;
const { workspace } = await api("/workspaces", "POST", { name: "scenario-journey" });
const { conversation } = await api(`/workspaces/${workspace.id}/conversations`, "POST", { title: "文件任务验收" });
const { run } = await api(`/conversations/${conversation.id}/messages`, "POST", {
  userInput: "请创建 hello.txt，内容恰好为 scenario-ok，然后读取验证，最终回答文件路径和内容。",
});
console.log(JSON.stringify({ workspaceId: workspace.id, conversationId: conversation.id, runId: run.id }));
const deadline = performance.now() + 600_000;
let state;
while (performance.now() < deadline) {
  state = await api(`/runs/${run.id}`);
  if (["COMPLETED", "FAILED", "INTERRUPTED"].includes(state.run.status)) break;
  await Bun.sleep(1600);
}
const evidence: Record<string, unknown> = { state };
for (const suffix of ["events", "output", "workspace-diff", "artifacts"]) {
  evidence[suffix] = await api(`/runs/${run.id}/${suffix}`);
}
await Bun.write(`journey-${run.id}.json`, JSON.stringify(evidence, null, 2));
if (state?.run.status !== "COMPLETED") {
  // 客户端截止不是服务器取消：记录 runId 后按计划查询/中断并核对清理。
  throw new Error(`任务未完成：${run.id} ${state?.run.status}`);
}
console.log("证据已保存；继续校验 hello.txt 与下载 Artifact 的实际内容。");
export {};
```

长时任务须相应提高客户端截止与服务端执行超时。对提交超时不能无脑重试 POST：服务端可能已经接受；先查本轮任务清单和唯一输入标记。当前没有已确认的通用请求幂等键合同。

## 6. 固定任务样本与输入长度

### 6.1 任务族与外部验收器

每个样本加唯一 `caseId`，但重复前缀实验要固定 system/tool 前缀。除专门测试随机性外，固定模型、sampling、工具、输入数据和结果验收规则。

| 样本 | 用户任务示例 | 外部验收，不依赖模型自评 |
| --- | --- | --- |
| T1 短问答 | “计算 17×23，只返回整数。” | 归一化输出等于 391，无文件修改 |
| T2 读项目 | “读取 README 和指定函数，说明输入输出，列出对应文件。” | 结论与固定夹具一致，未修改文件 |
| T3 创建文件 | “将指定 JSON 写入 result.json，随后读取验证。” | JSON parse 成功、字段和值精确匹配、Artifact 哈希一致 |
| T4 修复与测试 | “修复夹具中的边界错误，运行测试，说明修改。” | 用独立测试运行器验证公开+保留测试，Diff 只含允许文件 |
| T5 多轮修改 | 第一轮建函数，第二轮“保持原接口，增加负数支持” | 上下文约束和旧测试均保留，新测试通过 |
| T6 数据汇总 | “读取固定 orders.json，按类别汇总并输出 summary.json。” | 使用独立实现计算期望值，不只检查文件存在 |
| T7 工具密集 | “按顺序读取 20 个文件，修复 5 个文件并运行验证。” | 检查实际工具轨迹/文件与顺序要求，不能仅按提示词宣称完成 |
| T8 可控慢任务 | “执行夹具 slow-job，每阶段写独立进度文件，最终汇总。” | 外部脚本有时间上限，阶段序号完整、不重复，结束后无后台进程 |
| T9 输出密集 | “生成含 200 个固定编号条目的报告和文件。” | 编号/尾标记完整；页面、output 与 Artifact 相互一致 |
| T10 失败与自修复 | “运行固定失败测试，根据错误修复后重跑。” | 先有真实失败证据、再有通过证据；最终结果符合规范 |

T8 不使用无限循环。在已验证的受限容器中部署 `slow-job`，参数支持阶段数和每阶段等待，例如 5×10s、20×30s、60×60s。提示词不能保证模型会执行它；未观察到指定工具调用时重试或记 INCONCLUSIVE。长时间行为也可以由 E0 确定性工具夹具触发，但不作为真实 Agent 能力证据。

### 6.2 输入长度矩阵

长度以**当前模型 tokenizer 计数**；字符数、字节数另报。不能把“1 万汉字”等同于“1 万 token”。

| 档位 | 目标 | 内容变化 |
| --- | --- | --- |
| L0 | 空字符串、空白、缺字段、错误类型 | 校验与错误体验 |
| L1 | 32–128 tokens | 短中英文、数字、emoji |
| L2 | 512–2048 tokens | 常规任务、混合代码与说明 |
| L3 | 约 25% 可用输入预算 | 多文件、重复与非重复段落 |
| L4 | 约 50% 可用输入预算 | 长文档，关键约束放开头/中间/末尾 |
| L5 | 约 80%、95%、100% 可用输入预算 | 边界、截断、压缩与工具上下文累积 |
| L6 | 超预算 1 token、10%、100% | 有界失败、错误解释、不拖垮其他用户 |

可用输入预算约为 `模型上下文上限 − system/tool schema − 已有历史 − 预留输出`，必须用实际序列化后的 prompt 核对。首轮不超限不代表下一次工具结果加入后仍不超限。

每个非空长度档至少三种输入：①真实长文/代码；②高重复内容；③大量唯一词段。对 L4/L5 使用已知答案的“首/中/尾各放一个标记，要求输出三者”任务，并用独立答案表判断检索能力。避免只用重复字符造长输入，因为它不能代表真实 KV/缓存与注意力负担。

长输出另外分 128/512/2048/接近模型最大输出 token 档。UI 与网关分别检查末尾标记、Unicode 分片、Markdown/code fence 完整性和截断原因。

## 7. 场景矩阵

记号：`P0` 每次发布必跑，`P1` 完整验收必跑，`P2` 能力探索。`现成` 表示 §5/§11 有相关入口，**不表示现成测试已经覆盖本行所有组合**；`浏览器` 表示必须操作真实页面；`夹具` 表示执行前需准备可控输入/故障装置，不能凭空使用未实现接口。

### 7.1 用户旅程与体验（U）

| ID | 级别/环境/入口 | 场景与操作 | 必查结果 |
| --- | --- | --- | --- |
| U01 | P0/E1/浏览器 | 新用户注册→登录→新 Workspace→新对话→执行 T3→下载 | 每步反馈清楚，输出/文件/下载一致，无人工查库才能完成的必经步骤 |
| U02 | P0/E1/浏览器 | 同一对话按 T5 连续修改 5 轮 | 后续理解“刚才的文件”，保留既有约束，顺序正确 |
| U03 | P0/E1/浏览器 | 任务执行中刷新、关页，30s 后重新打开 | 不丢任务、不重复提交；能看到已有输出和后续进度 |
| U04 | P0/E1/浏览器 | A1/A2 项目与不同对话频繁切换 | 迟到轮询响应不覆盖当前页，不串输出/按钮目标 |
| U05 | P0/E1/浏览器 | 停止排队、推理中、工具中的任务，再提交新任务 | 明确停止对象与结果，清理后新任务可推进 |
| U06 | P0/E1/浏览器 | 失败任务、无 Checkpoint 中断任务、安全可恢复任务 | 失败原因可读；恢复按钮与可恢复性一致，拒绝不伪装成功 |
| U07 | P0/E1/浏览器 | 长文本粘贴、中英文输入法 Enter/Shift+Enter、连续双击发送 | 无误触提交、空请求或不知情重复任务；记录是否缺防重 |
| U08 | P0/E1/浏览器 | 输出滚动中查看旧内容、复制代码、下载嵌套路径文件 | 不被频繁强制拉到底部，复制/下载可用，长行不破坏布局 |
| U09 | P1/E1/浏览器 | 20 个标签页打开执行中/长历史对话 | 轮询压力下 UI/API 可用，无多重轮询泄漏 |
| U10 | P1/E1/浏览器 | 断网 30/120s，恢复；慢网/乱序响应 | 错误可见、自动重新同步；不把旧状态当新状态，不补发重复任务 |
| U11 | P1/E1/浏览器 | 登出后后退/重新开页；另一设备撤销所有会话 | 后续受保护请求拒绝，旧数据不在新身份页面继续可见 |
| U12 | P1/E1/浏览器 | Chrome 与另一浏览器，1440/768/390px，键盘操作 | 主按钮、错误信息和结果入口可达，焦点/滚动正常 |

### 7.2 任务能力、输入与上下文（C）

| ID | 级别/环境/入口 | 场景与操作 | 必查结果 |
| --- | --- | --- | --- |
| C01 | P0/E1/API+浏览器 | T1–T4 在 L1/L2 各跑 3 次 | 外部验收通过，工具过程与最终回答一致 |
| C02 | P0/E1/API | L0、非法 JSON、数组请求体、错误 thinkingLevel | 明确 4xx，不创建无意义 Run，不影响下一次合法提交 |
| C03 | P0/E1/夹具 | L3–L5，标记置于首/中/尾 | 不静默丢关键约束；错误/压缩行为可解释，统计答案正确率 |
| C04 | P0/E1/夹具 | L6 超上下文，与 B 的 T1 同时执行 | 超限明确失败或被拒绝，B 正常；不能无限重复请求模型 |
| C05 | P0/E1/夹具 | T4/T10 先运行失败测试、修复再验证 | 不把失败测试说成通过，不靠最终文本伪造结果 |
| C06 | P1/E1/夹具 | 单轮小输入，但工具返回很长文本 | 后续模型超限/截断有界，工具内容不会使主进程失控 |
| C07 | P1/E1/浏览器 | 同会话 10/30/100 轮，周期性复述早期约束 | 实际记录 token 和压缩情况；不串 Session，给出记忆保留率 |
| C08 | P1/E1/API | 长输入×长输出、短输入×长输出、长输入×短输出 | 分别测 TTFT、解码、E2E，避免把全部退化归为排队 |
| C09 | P1/E1/浏览器 | emoji、组合 Unicode、中文文件名、代码块和 HTML 文本 | 数据不损坏；输出按文本处理，不能执行注入脚本 |
| C10 | P1/E1/夹具 | 互相矛盾/缺参数的任务、要求访问不存在文件 | 能给出限制/澄清或有界失败，不捏造已经执行 |
| C11 | P1/E1/API | thinkingLevel off/low/high，在支持与不支持模型上 | 输出/思考区归属正确，不支持时有明确行为；分别记录成本 |
| C12 | P2/E1/夹具 | 高重复/高唯一度等 token 输入，冷/热前缀对照 | 分开报告延迟与 cache 字段可用性，字段缺失不等同命中率为零 |

### 7.3 并发、公平与背压（Q）

| ID | 级别/环境/入口 | 场景与操作 | 必查结果 |
| --- | --- | --- | --- |
| Q01 | P0/E0+E1/现成 | 独立会话同时提交 1/2/4/8/16/32 个 T3 | 请求数、接受数、完成数对账；运行并发不超过配置 |
| Q02 | P0/E0+E1/现成 | 单租户多会话，单租户上限 1，全局上限 4 | TENANT_CONCURRENCY_LIMIT 可解释，B 可获得服务 |
| Q03 | P0/E0+E1/现成 | 多租户独立会话，全局上限 1 | GLOBAL_CONCURRENCY_LIMIT 可解释，释放后继续 |
| Q04 | P0/E0+E1/现成 | 同对话一次提交 10 个不同标记任务 | SESSION_SERIALIZATION、同会话不并发，处理顺序可核对 |
| Q05 | P0/E1/夹具 | A 持续大量提交，B 每 5s 一个短任务 | B 无永久饥饿；记录轮转机会与尾延迟，不要求完成顺序轮转 |
| Q06 | P0/E0+E1/现成 | 正常→资源 BUSY/CRITICAL→恢复 | 新任务准入随真实事实变化；解除后自动推进且不重复启动 |
| Q07 | P1/E1/夹具 | A 的同会话长任务在租户队头，后面是 A 的独立短对话 | 测出队头阻塞，不能误当跨租户饿死；报告 A 的体验损失 |
| Q08 | P1/E0+E1/夹具 | 分别设置等权/不同 weight/maxUnits，完成/中断后再提交 | 预算限制与释放正确；权重不声称等价 token 公平 |
| Q09 | P1/E0+E1/现成 | 排队超过 TTL；pump 暂停后恢复；控制面重启 | FAILED/QUEUE_TIMEOUT，有原因，队列和槽位不泄漏 |
| Q10 | P1/E1/夹具 | metrics 超时/断连/缺字段/过期，再恢复 | 策略保守且可解释；未知不当正常；正常观测后回到可服务状态 |
| Q11 | P1/E1/夹具 | 每 5s 在压力阈值两侧切换 20 轮 | 不形成重复入队/启动风暴，记录吞吐和原因切换频率 |
| Q12 | P1/E1/压测客户端 | 固定到达率 0.5λ*/λ*/1.2λ*/2λ* | 过载行为、TTL与恢复有界；不因闭环客户端降速而隐藏队列 |

单原因场景先让其他资源与预算限制宽松，仅改变一个约束；复合时再检查原因优先级及变化。不要要求所有阻塞原因都出现在同一个字段里。

### 7.4 长任务、生命周期与恢复（R）

| ID | 级别/环境/入口 | 场景与操作 | 必查结果 |
| --- | --- | --- | --- |
| R01 | P0/E1/夹具 | T8 持续 1/5/15min，同时 B 做 T1 | 长任务有进度，B 可服务；不把无新 token 等同死锁 |
| R02 | P0/E0+E1/现成 | 排队任务被 claim 的同时用户 interrupt，重复 100/1000 次 | 不出现 INTERRUPTED→RUNNING 非法覆盖；pump 持续工作 |
| R03 | P0/E0+E1/现成 | Worker 推理中异常退出，其他用户持续请求 | 故障限制在对应任务，主进程存活、槽位释放 |
| R04 | P0/E0+E1/夹具 | 安全 Checkpoint 后中断/重启并恢复 | 原始任务语境保留、Attempt 可追踪、已确认结果合理复用 |
| R05 | P0/E0+E2/夹具 | 未知副作用已开始、完成确认未落库时崩溃 | 不自动重放；不将文件存在当作安全重放证明 |
| R06 | P1/E0+E1/现成 | Worker 不响应中断，短 execution timeout | 宽限后强杀与清理；无永远 RUNNING/WAITING_TOOL |
| R07 | P1/E1/夹具 | T8 30/60min；执行超时设 75min，单工具超时也核实 | 实际完成、资源无累积；不能用默认 30min 配置期待 60min 成功 |
| R08 | P1/E0+E1/夹具 | interrupt/resume 各重复点击，两个客户端同时操作 | 唯一合法执行，拒绝有说明，不重复副作用 |
| R09 | P1/E1/夹具 | 控制面正常关闭/强杀，混有 QUEUED/RUNNING/WAITING_TOOL | DB 恢复、队列对账、人工处理分类正确，不丢接受任务 |
| R10 | P1/E0+E1/夹具 | 丢失/损坏 Pi 会话文件或 Checkpoint 引用 | 有界拒绝与可诊断证据，不回退到无历史任务并声称恢复 |
| R11 | P1/E1/夹具 | 恢复入队后 GPU 再变忙、控制面再次重启 | 恢复输入/原因可重建，不能启动一个没有原任务的全新 Run |
| R12 | P1/E0+E1/现成 | 完成/中断后迟到 TOOL_COMPLETE、重复 runtime 事件 | 不覆盖终态，事件与工具结果去重/保留正确 |

### 7.5 文件、结果、隔离与权限（S）

| ID | 级别/环境/入口 | 场景与操作 | 必查结果 |
| --- | --- | --- | --- |
| S01 | P0/E1/API | B 遍历 A 的 run、events、output、diff、artifacts、conversation、workspace | 均不返回 A 数据；跨租户已存在资源按合同不可枚举 |
| S02 | P0/E1/API | B 中断/恢复 A Run、使用 A Workspace、伪造 tenantId | 无副作用、归属不变；不能凭客户端字段切租户 |
| S03 | P0/E0+E1/现成 | 跨租户抢 sessionId、同租户复用 | 跨租户拒绝，同租户合法续接；不劫持历史 |
| S04 | P0/E1/API | 只读凭证提交/中断、模型专用 key 读任务、无效/过期 token | 按 scope 拒绝，不因前端隐藏按钮而放松后端权限 |
| S05 | P0/E2/现成+真实Pi | read/bash 尝试读 B/HOST 哨兵、父目录与链接 | 真实工具边界阻断，API 测试通过不足以替代 |
| S06 | P0/E2/夹具 | A/B 不同假 Secret；检查容器、Worker argv/日志/结果 | 未授权 Secret 不可见；已知 argv 风险如复现必须 FAIL |
| S07 | P1/E2/夹具 | 工具尝试禁用网络、访问测试外部端点，夹具含提示注入 | 权限由系统实施，不能因模型“选择不做”而判隔离通过 |
| S08 | P1/E2/现成+夹具 | 限额 CPU/内存/PID/tmpfs；C 超额同时 B 执行 | C 受限且可解释，B 不被带崩，容器/进程最终清理 |
| S09 | P0/E1/夹具 | 文件新增/修改/删除，嵌套与中文路径 | Diff 分类与外部清单一致；下载哈希正确；删除不伪造下载物 |
| S10 | P1/E1/夹具 | 2 MiB−1/2 MiB/2 MiB+1 文件及忽略目录/链接 | 准确记录快照覆盖边界；重要文件不可下载时登记产品缺口 |
| S11 | P1/E1/夹具 | 两个对话同 Workspace 并发改同文件/不同文件 | 查覆盖丢失、Diff归因和Artifact稳定性；不预设有文件锁/合并能力 |
| S12 | P1/E1/夹具 | 1000/10000 文件、Artifact 抓取中源文件被改/删/换链接 | 不泄露、不混存哈希、不挂住终结与槽位清理 |
| S13 | P0/E1/夹具 | 第一轮 Artifact 生成后第二轮修改同文件 | 第一轮下载仍是当时内容，不能返回最新工作区文件 |
| S14 | P1/E1/浏览器 | Workspace 名、任务输出含 HTML/脚本/异常路径文本 | 只作数据展示，无脚本执行、DOM 注入或路径越界 |

### 7.6 模型网关、依赖与运维（G）

| ID | 级别/环境/入口 | 场景与操作 | 必查结果 |
| --- | --- | --- | --- |
| G01 | P0/E1/现成 | Pi 模型发现→多轮模型/工具→流式回答 | 请求确经网关，无递归路由；成功流 usage 能采集或明确缺失 |
| G02 | P1/E0+E1/夹具 | 首后端连接失败/5xx，第二个正常 | 首字节前可回退；输出来自明确后端，失败次数有界 |
| G03 | P0/E1/夹具 | 已返回部分 SSE 后断流 | 不拼接第二模型答案，不把残缺输出当完整成功；Worker可收敛 |
| G04 | P1/E0+E1/夹具 | 401/429/400、无效 JSON、坏 SSE、usage 缺失/重复 | 错误分类与流完整性正确，不无界重试，usage 不重复计费式累计 |
| G05 | P1/E1/夹具 | 所有后端不可用，恢复其中一个 | 不无限占用 Run/连接；探活、熔断与回退有记录，恢复后可服务 |
| G06 | P1/E1/夹具 | 同逻辑模型多个后端；priority/round-robin/least-active | 按配置分流，慢流/断流后 active 计数释放；一后端不算多后端验收 |
| G07 | P1/E1/夹具 | 登录并发 1/10/50 与任务/轮询同时进行 | 密码计算不拖死任务接口；错误登录不泄漏账号差异，记录延迟分布 |
| G08 | P1/E1/隔离卷 | SQLite 忙/只读/磁盘写失败，恢复空间/权限 | 无伪成功与不可解释丢失，状态/结果写入失败可诊断，下一任务可恢复 |
| G09 | P1/E2/夹具 | 容器启动失败、镜像缺失、运行中容器消失 | Run/Sandbox 收敛，资源释放，主进程可继续服务 |
| G10 | P1/E0+E2/现成 | warm pool 冷/热启动，使用后再分配另一租户 | 冷热延迟分别报，旧文件/env/Secret 不残留 |
| G11 | P1/E1/备份副本 | 干净目录启动、旧 DB 副本迁移、备份恢复后运行 | 数据可读、版本一致、产物/Session 可访问，不能只备份 SQLite |
| G12 | P1/E1/压测客户端 | 2/8/24h 混合负载，大量查询/eval/Artifact 下载 | 无持续内存/FD/队列泄漏；历史查询和当前任务均可用 |

## 8. 复合场景详细剧本

这些剧本验证多个机制同时工作。每个都先跑无故障对照组，再运行实验组；保存任务清单和时间线。除 X09 外，故障解除后必须再提交一个全新 T3，证明服务真正恢复。

### X01：团队高峰期“重载用户不拖垮正常用户”

**组合**：多租户 + 长输入 + 工具密集 + 公平队列 + 页面轮询。E1，P0。

1. 全局/租户并发先设 4/2；5 个租户，每租户独立 Workspace/Session，确认资源正常。
2. A 一次提交 20 个 T7；C 提交 5 个 L4 的 T6；B/D/E 每 5s 各交一个 T1/T3，共 5min。
3. 打开 B 的工作台观察排队原因；另开 10 个只查询标签页模拟真实围观。
4. 停止新提交，等待排队完成或触发预设 TTL，统计每租户正确任务吞吐与 p95/max 等待。

**通过**：并发限制有效，B/D/E 能持续获得服务，队列最终收敛，回答/文件无串租户。等价短任务公平试验中，各持续有资格租户每轮都有启动机会；混合长短任务只要求启动机会与预设延迟，不要求 GPU 时间均分。

**证据**：每次提交及 runId、启动顺序、QUEUE_BLOCKED/decision、每租户延迟、模型/工具时间分解、正常用户 UI 录屏。到达率过高导致合法 TTL 失败需记容量边界，不能宣称全量服务成功。

### X02：长会话 + 页面重连 + 后续修改

**组合**：真实 Pi 记忆 + 文件结果 + 多轮 + 浏览器断线。E1，P0。

1. A 建一个对话，首轮 T4，要求固定接口名并放一个唯一约束。
2. 做 10 轮递进修改；第 5 轮执行时刷新，第 7 轮关闭页面 60s。
3. 第 11 轮只说“沿用刚才的接口和约束，加上空输入处理”，不重新贴旧代码/约束。
4. 同时 B 在另一个对话使用相反约束，检查 A 不受影响。
5. 独立跑保留测试，下载第 1/5/11 轮 Artifact 并核对其各自内容。

**通过**：Session 实际续接、早期约束仍满足、旧 Artifact 不变、无重复提交；页面恢复历史与当前状态。记录 session ref/文件证据但不公开完整私人会话内容。

### X03：排队→即将启动→用户停止→继续提交

**组合**：队列竞态 + interrupt + 状态机 + 槽位清理。E0 后 E1，P0。

1. 全局/租户并发 1/1，T8 占槽，另交一个 T3 排队。
2. 在占槽任务结束释放时，从独立客户端向排队 Run 发 interrupt。
3. E0 在 claim 后/开始前设置可控 barrier，确定性命中窗口；E1 用重复交错请求补验，不依赖一次随机抢中。
4. 重复至少 100 轮，扩展至 1000 轮；每 10 轮提交一个新 T1 检查队列可推进。

**通过**：停止与启动只有一个合法结果；若已经启动则停止它，不能出现非法状态回跳、双 Worker、pump 反复报错或僵尸槽位。E1 未命中窗口记 INCONCLUSIVE，不抵消 E0 的必要性。

### X04：安全恢复后又遇到资源不足

**组合**：Checkpoint + 原任务记忆 + 恢复排队 + 重启。E0/E1，P1。

1. 夹具保证存在有效 Checkpoint，且所有未完成工具均可安全重放；记录原始目标与当前已完成步骤。
2. 中断目标 Run，确认实际退出；将测试资源观测变为 CRITICAL。
3. 通过 resume 提交恢复，确认只是 QUEUED；此时重启测试控制面。
4. 资源恢复 NORMAL，观察恢复任务重新推进，随后验证原始任务结果。

**通过**：恢复前后 runId/Checkpoint 归属一致、Attempt 有序、恢复输入保留原始目标；无不安全重放、重复执行或永远遗留队列。内存观测丢失符合边界，但持久队列原因/任务证据不能丢。

### X05：不确定写入 + Worker 崩溃 + 人工恢复尝试

**组合**：真实副作用 + IPC 工具账本 + fail-closed + 用户操作。E0 后 E2，P0。

1. 准备 append-once 测试工具：向本轮私有文件追加唯一 marker；另外先产生一个安全 Checkpoint。
2. 在 Master 已保存 PREPARED、工具实际追加完成、但 COMPLETE 尚未提交时，用夹具暂停回执并杀死该 Worker。
3. 重启/扫描恢复，保存 tool_executions、Checkpoint、Run 事件及 marker 次数。
4. B 同时提交正常任务；A 在页面尝试恢复，检查后端再次校验，不允许按钮直接绕过副作用阻断。

**通过**：marker 恰好一次，恢复停在需人工处理的边界，B 正常。人工处理必须先核对外部效果；如果没有安全消解该状态的产品流程，就记录体验缺口，不能改库伪造 SUCCEEDED 来宣布闭环完成。

**夹具说明**：现成 `tool_after_prepare` 注入证明 PREPARED/UNKNOWN_EFFECT 留存，但模拟回调没有真实写盘，不能代替本剧本第 2 步。真实写入与延迟 COMPLETE 的 barrier 需新增测试夹具，未准备时记 BLOCKED。

### X06：长输入超限 + 正常用户短任务 + 网关故障

**组合**：context 边界 + 错误隔离 + 首字节前回退。E1，P1。

1. B 每 5s 提交 T1；A 连续提交 L5 和 L6，分别使用真实文档和唯一内容。
2. 通过本轮独立代理让首后端在响应前返回 503，备用后端保持正常。
3. 观察 L6 是输入被拒/Run 失败还是模型压缩；检查 B 的正常请求不被污染。
4. 解除故障，分别统计超限失败、网关失败、正常任务结果。

**通过**：超限与后端失败有明确来源，不无限重试、不伪造成功，B 保持预设体验目标。若备用后端上下文更小，应准确暴露限制，不能认为回退必然解决输入超限。

### X07：模型输出中断 + 浏览器断网 + 回来取结果

**组合**：模型 SSE + UI 轮询 + 部分结果 + 清理。E1，P1。

1. 提交 T9，独立代理在真实流已经发出若干 token 后断开上游。
2. 浏览器同时断网 30s；恢复网络后重新打开当前对话。
3. 检查 output 已持久化部分、Run 错误、网关请求计数、Worker 退出和连接释放。

**通过**：部分回答明确标为失败/不完整，不拼接备用模型继续冒充同一成功流；恢复浏览器不会重发任务。无 usage 时记录缺失，不拿 0 token 当真实消费。

### X08：同 Workspace 并发修改 + Artifact 历史稳定性

**组合**：多对话 + 文件竞争 + Diff + 快照下载。E1，P1。

1. A 同一 Workspace 建两个对话，固定输入版本。
2. 两对话先同时改不同文件，验收各自 Diff；再复位夹具，两对话同时改同一函数，使用互斥需求。
3. 用工具 barrier 确保两个任务都读到旧版本后才写，避免恰好串行而漏测。
4. 下载两个任务的 Artifact；在第三轮再改该文件后重新下载旧结果。

**通过**：任何已承诺成功的结果均可追溯；不能静默丢失另一个用户修改且界面完全无提示。当前 Session 串行不等于 Workspace 锁，此场景可能暴露实际产品缺口；不要把“设计未做”直接算通过。第一轮不同文件也要检查目录级快照是否把另一 Run 的修改归入自己。

### X09：业务日长稳 + 负载波峰 + 夜间静默

**组合**：混合任务 + 历史累积 + 轮询 + 资源回收。E1/E2，P1。

1. 按 §9 混合比例运行 2h，升级 8h，再运行 24h；每小时插入 5min 的 1.5λ* 峰值。
2. 每 30min 新建部分 Workspace/Session，另一部分持续使用旧会话；保持一组页面常开。
3. 每小时停止新提交 5min，观测积压/子进程/RSS/FD；不通过重启掩盖增长。
4. 最后排空，空闲 15min，重新执行 U01/T4。

**通过**：正常任务质量与尾延迟无持续恶化，队列可排空，无泄漏型增长；持久数据增长按任务量解释。记录 Artifact/会话/事件磁盘增长斜率和可支撑天数，不能要求它们自动归零。

### X10：邻居工具资源耗尽 + 正常交互

**组合**：容器限额 + Worker 隔离 + 共享服务。E2，P1。

1. 用受限容器为 C 设置 CPU/内存/PID/tmpfs 限额，B 持续 T1/T3。
2. C 分别执行有界 CPU、内存、进程数和临时盘压力，每个单独完成再组合两种压力。
3. C 压力中断时检查子进程树与容器；B 继续交互/下载。

**通过**：限制确实由运行环境执行，C 错误能解释、B 无跨任务崩溃；不只看 Docker 创建成功。压力工具若因命令语法错误退出，不能算资源限制生效。

### X11：控制面突然退出 + 活跃、工具中和排队任务混存

**组合**：持久性 + 恢复分类 + 队列重建 + TTL。E0 后 E1/E2，P1。

1. 准备 R-A 正在推理、R-B 在安全工具阶段、R-C 有不安全 PREPARED、R-D 普通排队、R-E 即将超过 TTL；每个保存 ID。
2. 用 barrier 固定各阶段后杀死本轮 Master，停机超过短 TTL。
3. 用同一数据目录重启；核查旧 Worker/容器、会话文件、Checkpoint、队列和恢复分类。
4. R-E 应在恢复对账时超时；R-D 按实际排队年龄判断；不安全 R-C 不能自动重放。

**通过**：所有接受任务都能对账到可解释状态，无双执行；安全恢复与人工处理分开。正常 shutdown 与 SIGKILL 各跑一次。普通时序未能同时构造这些状态时减少任务并使用夹具，不伪造“全覆盖”。

### X12：登录流量 + 历史查询 + 新任务 + 会话撤销

**组合**：认证 CPU + SQLite 读写 + 用户轮询 + 凭证撤销。E1，P1。

1. 预置 1000/10000 个历史 Run（E0 可生成，数据须符合真实 schema），持续执行正常新任务。
2. 并发 10→50 个登录请求，同时查询长会话、`/eval`、`/runs`、分页审计与 Artifact 下载。
3. 撤销 D 的所有会话，在其旧标签页继续查询/操作；其他用户保持在线。

**通过**：撤销只影响对应身份，新任务和查询不被认证计算/全量历史拖死；不出现缓存跨身份复用。当前多处列表全量返回，若性能不达标，记录分页/增量查询需求，不假设接口已有游标。

## 9. 容量测试与长时间稳定性测试

### 9.1 两种负载必须都做

**闭环并发**：固定 C 个客户端，每个任务完成后再发下一个。适合测“同时多少用户操作仍顺畅”。

**开环到达率**：按固定或带抖动的时间表发送，不等上一任务完成。适合测“请求持续涌入是否积压”。闭环在系统变慢时自动减少提交，会掩盖过载。

客户端必须记录：计划发送时间、实际发送时间、响应时间、202/拒绝/网络错误、runId、输入长度、租户/Workspace/Session、任务族、最终状态、验收结果。额外报告负载机 CPU/事件循环延迟，区分系统容量与发压机瓶颈。

### 9.2 负载组合

| 比例 | 任务 | 输入/行为 |
| --- | --- | --- |
| 25% | T1/T2 | 短输入，交互敏感 |
| 30% | T3/T4/T10 | 常规写文件、修复和验证 |
| 20% | T6 | L3/L4 长输入 |
| 15% | T7 | 多工具、I/O 密集 |
| 10% | T8 | 1–5min 长任务 |

先分别测各任务族，再混合；否则无法判断慢来自模型、工具、初始化还是队列。负向输入、故障注入、主动中断各开独立实验组，不混入上表的正常基准。

### 9.3 分阶段加压

| 阶段 | 参数 | 时长/样本 | 产出 |
| --- | --- | --- | --- |
| 空闲/预热 | 无负载→各任务族预热 | 5–10min | 初始资源、冷启动与热启动差异 |
| 单用户 | C=1 | 每族≥10；重点族≥30 | 基线 TTFT/E2E、正确率 |
| 并发阶梯 | C=2/4/8/16/32，稳定后考虑 64 | 每档≥10min 且足够完成样本 | 第一次违反目标的并发档 |
| 稳定吞吐 | 在满足目标的档位运行 | ≥30min | 得到经验持续吞吐 λ*，单位任务/s |
| 到达率阶梯 | 0.5/0.8/1.0/1.2/2.0 × λ* | 每档≥10min，档间排空 | 队列增长、拒绝/TTL、恢复能力 |
| 突发 | 1s 内提交平时 5 倍任务，再停止 | 3 轮，轮间排空 | 突发接纳与排空时间 |
| 热点租户 | A 占 80% 到达，其他租户均分 20% | ≥20min | 正常用户受影响程度 |
| 耐久 | 正常负载约 0.7λ*，插入峰值 | 2h→8h→24h | 内存/FD/磁盘/尾延迟趋势 |

C 是客户端在途任务数，不是 Harness activeRunCount，更不是 vLLM running_requests。分别记录三者。长任务所占比率同时按“任务数”和“总运行时间”报告。

到达率实验设置最大提交总量、最大队列长度的**客户端停止阈值**和总时长，避免在无限排队中烧资源；不要把这个客户端阈值写成系统已有队列上限/429 能力。

### 9.4 发压器实施约束（待实现，不是现成工具）

建议独立测试驱动支持以下结构；本仓库当前没有覆盖本文全部需求的统一发压命令：

```text
读 campaign 配置、任务样本与账号（固定 seed）
准备用户 / Workspace / Conversation，记录 ID，不计入任务执行延迟
启动独立采样器，每 1–5s 写 append-only 资源和延迟日志
生产者按闭环 C 或开环计划发请求，每个请求具有唯一 caseId
记录全部请求结果；POST 超时进入“接受情况未知”队列，禁止自动重发
集中 poller 按 1.6–5s 查询，抖动错峰，限制查询并发
COMPLETED/FAILED/INTERRUPTED 后采集事件、输出、Diff、Artifact 并运行外部验收
到达停止阈值后停止提交，继续有界排空；未收敛任务逐个记录/中断
汇总全量分母与异常清单，最后执行新任务探针
```

不要为每个排队任务每 100ms 开一个轮询循环，除非该轮就是“轮询风暴”实验。正常发压与 UI 压力分别命名，便于归因。

### 9.5 停止条件与清理

立即停止新增压力并保留证据：跨租户泄露、不安全重放、DB 损坏、宿主资源逼近危险阈值、控制面持续失联超过 60s、队列超过本轮预设上限、30s 内内存异常跃升且持续增长。

单档位未满足体验目标就记录拐点；仅在资源仍安全时继续一档用于测过载恢复，不为了“覆盖 64 并发”强行拉满。

清理顺序：停止生产者→撤销故障/代理规则→记录剩余任务→通过 API 中断本轮残留→验证 Worker/容器/槽位→导出证据与备份→停止本轮服务。清理后比较 PID/容器清单和磁盘清单；不要删除原项目或其他任务目录。客户端超时的 Run 也必须纳入清理。

## 10. 证据采集与报告格式

### 10.1 建议目录

```text
campaign-id/
  manifest.json                 # 代码摘要、环境、配置摘要、数据种子、时间、操作者
  plan.md                       # 本轮范围、门槛、已知限制、最大资源预算
  requests.jsonl                # 计划/实际发送、HTTP状态、runId；不含 token
  resources.jsonl               # 定期导出，避免重启/环形缓冲覆盖
  process-samples.jsonl         # Master/Worker/FD/容器/WAL/磁盘
  faults.jsonl                  # 故障目标、触发事实、注入/解除时间
  cases/U01/...                 # 页面截图/录屏、网络错误、人工记录
  runs/<runId>/
    run.json
    events.json
    output.json
    workspace-diff.json
    artifacts.json
    artifact-hashes.json
    acceptance.json             # 外部测试结果、期望/实际差异
  server-logs/                  # 脱敏 Harness/vLLM/容器日志
  recovery/                    # 脱敏账本、Checkpoint、Attempt和重启对账
  report.md
```

每 5s 导出资源/网关摘要，每 30–60s 采样进程与磁盘；故障前后提高采样频率，避免提高全程查询压力。route decision 缓冲可能短于 5s，若请求率高则提高采集频率或使用专门测试观测 sink，并注明改动。

SQLite 的热备份用 SQLite backup 能力或停服后按完整数据集复制；不能运行中只复制主 `.sqlite` 而遗漏 WAL。备份也要包含 Artifact 和 Pi Session，恢复副本与原实例不能共用可写目录。

工具账本/Checkpoint/Attempt 暂无通用公开查询 API，使用测试管理员只读查询或现有 Store 的测试接口采集，不虚构 `/checkpoints`、`/tools` 路由。长稳压力下避免反复全表扫描。

### 10.2 单场景记录模板

```markdown
### X05 / repeat-01
- 状态：NOT_RUN
- 环境与证据等级：E2 / REAL；夹具版本：
- 代码/配置/模型摘要：
- Tenant / Workspace / Conversation / Run / Attempt IDs：
- 前置条件、样本、种子：
- 预期系统行为 / 用户行为 / 结果验收：
- 实际步骤与时间：
- 故障已命中的证据：
- 实际状态、输出、文件、日志：
- 系统正确性：；任务能力：；用户体验：
- 指标：样本数、p50/p95/max、错误数及分母：
- 证据路径：
- 未完成/不确定项：
- 清理与新任务复验：
- 问题链接、严重度、下一步：
```

### 10.3 最终报告必须回答

1. 本轮实际覆盖了哪些环境、配置、模型、任务族和复合场景？哪些未执行？
2. 用户能可靠完成哪些任务？正确率多少？哪些结果看似完成但实际不可用？
3. 可承诺的正常并发/到达率区间是多少？拐点首先出现在队列、模型、工具、SQLite 还是 UI？
4. 长任务/长会话能持续多久？到时是正确完成、可解释超时还是静默挂起？
5. 过载与故障时，正常用户受影响多少？故障解除后能否自动继续服务？
6. 是否存在跨租户泄露、不安全重放、重复执行、结果丢失或资源泄漏？
7. 本轮剩余阻断问题和 Backlog 是什么？不把 BLOCKED/INCONCLUSIVE 算通过。

统计至少列出：计划发送、实际发送、202 接受、明确拒绝、接受未知、完成、失败、中断、仍排队/运行、正确任务数。满足守恒关系；未知接受先对账，不能直接从分母删除。

## 11. 场景与现有实现/测试映射

路径用于定位与复用，不表示对应场景已经在真机或浏览器通过。

| 测试主题 | 实现入口 | 相关现有验证 |
| --- | --- | --- |
| 用户闭环/身份/对话 | `src/http/harness-http-api.ts`、`src/http/harness-user-console.ts` | `tests/http/user-console.test.ts`、`scripts/user-console-smoke.ts`、`tests/conversations/conversation-store.test.ts` |
| 认证撤销/租户归属 | `src/auth/api-credential-store.ts` | `tests/auth/api-credential-store.test.ts`、`tests/http/tenant-boundary.test.ts`、`tests/http/session-squatting.e2e.test.ts` |
| 排队/公平/竞态 | `src/scheduling/tenant-run-scheduler.ts`、`src/scheduling/run-queue-coordinator.ts` | `tests/scheduling/tenant-run-scheduler.test.ts`、`tests/scheduling/queue-reconcile.test.ts`、`tests/runs/run-service-queued-start-race.test.ts` |
| GPU/预算/TTL | `src/resources/resource-admission-service.ts`、`src/resources/budget-aware-policy.ts` | `tests/resources/budget-policy-wiring.test.ts`、`tests/scheduling/queue-ttl.test.ts`、`tests/integration/day7-recovery-resource.e2e.test.ts` |
| 工具/硬杀/故障传播 | `src/worker/worker-tool-gateway.ts`、`src/runtime/supervised-agent-runtime.ts` | `tests/integration/worker-tool-governance.e2e.test.ts`、`tests/runtime/execution-hard-kill.test.ts`、`tests/integration/blast-radius-stress-challenge.e2e.test.ts` |
| 恢复与安全重放 | `src/checkpoints/recovery-executor.ts`、`src/checkpoints/recovery-decision.ts` | `tests/checkpoints/recovery-hardening.test.ts`、`tests/checkpoints/recovery-executor.test.ts`、`tests/scheduling/queued-run-recovery.test.ts` |
| Pi 多轮接线 | `src/runtime/pi-adapter.ts`、`src/runtime/managed-agent-runtime.ts` | `tests/integration/stage1-stage2-control-plane.e2e.test.ts`；真实上下文内容需 C07/X02 补验 |
| 文件与不可变结果 | `src/workspaces/workspace-snapshot.ts`、`src/workspaces/run-artifact-store.ts` | `tests/workspaces/workspace-snapshot.test.ts`、`tests/workspaces/run-workspace-result.test.ts` |
| 真容器隔离 | `src/sandbox/container-sandbox-provider.ts` | `scripts/container-sandbox-attack-smoke.ts`、`tests/sandbox/container-warm-pool.test.ts`；真实 Pi 入口需补验 |
| 网关/usage/cache | `src/llm-gateway/llm-gateway.ts`、`src/llm-gateway/model-router.ts` | `tests/llm-gateway/stream-usage.test.ts`、`tests/llm-gateway/load-balancing.test.ts`、`tests/llm-gateway/prefix-cache.test.ts` |

## 12. 执行排期与交付门槛

| 批次 | 建议时间预算 | 内容 | 进入下一批的条件 |
| --- | --- | --- | --- |
| A 基线 | 0.5天 | E0、环境冻结、账号/项目夹具、U01真实闭环 | 无基础阻断，真实模型和工具链能跑 |
| B 用户能力 | 1天 | U/C/S 文件结果，多轮、长输入、真实浏览器 | 所有 P0 闭环有证据，结果可验 |
| C 稳定性 | 1天 | Q/R 单边界，X01–X05、X08 | 队列、停止、恢复、归属硬不变量通过 |
| D 故障与隔离 | 1天 | E2 S 类，X06/X07/X10/X11/X12 | 故障可收敛，受影响边界清楚 |
| E 容量 | 0.5–1天 | 单用户、并发/到达率阶梯、突发 | 找到满足目标的稳定负载区间 |
| F 长稳与回归 | 2–3天墙钟 | 2h→8h→24h，修复复验、报告 | 无阻断问题，未测边界清晰 |

时间是已有测试环境可用时的预算；统一发压器、故障 barrier、浏览器自动化和外部验收器尚需准备，不能把“写了计划”算作已经具备自动化能力。

建议阻断交付：P0 硬不变量失败、普通用户主流程失败、常规任务持续挂起/丢失、正常负载无法满足本轮冻结目标。优先修复并重跑最小复现、相关回归和受影响的复合场景。

建议进入 Backlog：已明确范围外的多节点 HA、未承诺的超大文件交付、缓存性能优化、更多模型兼容性等。但只要这些缺口破坏了当前承诺的用户流程，就升级为阻断，而不是用 Backlog 回避。

本轮交付物应包含：执行报告、机器可读结果、可复用夹具/驱动、故障复现步骤、容量曲线、长稳资源曲线和问题清单。本文先提供完整的测试指导；每次执行后的事实另写报告，保留方案与结果的区别。
