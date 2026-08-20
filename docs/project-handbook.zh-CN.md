# 项目手册（Project Handbook）

> **本文件是项目唯一技术主文档。** 从这份开始读，读懂了这份，就能看懂整个项目。  
> 最后同步：2026-08-19（项目已完成第一阶段闭环）。  
> 面试准备另有 `docs/interview-prep-guide.zh-CN.md`；完成度对账见 `docs/completion-status.zh-CN.md`；对外展示网页见 `docs/course/index.html`。  
> 历史设计/中间产物已归档到 `docs/archive/`，需要时可查，不必通读。

---

## 1. 一句话定位

**一个多租户 Agent 任务服务（Agent Task 控制面）。**

Agent（Pi）负责"动脑"——思考、调模型、用工具；本系统负责"安排与安保"——谁能执行、在哪执行、何时执行、失败后如何安全继续，以及用户最终拿到什么。

作用在 Pi 之外的三个平面：**行为（Behavior）** 由 Agent 负责；**控制面（Control）** 由本 Harness 负责；**基础设施（Infrastructure）** 提供沙箱、GPU、模型服务。

控制面不替模型做工具选择，但必须在副作用发生前有最终否决权。

---

## 2. 数据对象链

```
Tenant → Workspace → Session → Run → Attempt → Sandbox → ToolExecution → Result / Diff / Artifact
```

| 对象 | 是什么 |
|---|---|
| **Tenant** | 身份、数据、策略、资源、审计归属的一等边界（来自认证，非客户端自报）。 |
| **Workspace** | 租户下的工作区，服务端生成目录。 |
| **Session** | 对话关系（Pi 的 AgentSession）。 |
| **Run** | 一次受控任务。 |
| **Attempt** | Run 的一次实际执行（每次真实执行独立 Attempt）。 |
| **Sandbox** | 每 Attempt 的隔离执行环境（runsc 容器）。 |
| **ToolExecution** | 一次工具调用及副作用记账。 |
| **Result / Diff / Artifact** | 用户拿到的最终回答、文件改动、固化产物。 |

---

## 3. 一次任务的一生（端到端）

```text
用户在 UI 提交 workspaceId + userInput
  → HTTP 层验 API Key，解出 Principal（Tenant 不可伪造）
  → 任务持久化为 QUEUED
  → 资源准入决策：START 或 QUEUE
  → 调度器 claim + 占 slot，公平队列（Tenant 内 FIFO、Tenant 间 round-robin）
  → 创建 Attempt + Sandbox（runsc 容器，只挂 workspace）
  → Pi 在沙箱里思考、调模型、用工具
  → 每个工具调用：先记账(PREPARED)→授权决策→执行→SUCCEEDED
  → 完成后返回最终回答 + Diff + Artifact
```

四个系统难题贯穿其中：**副作用可靠性、资源准入背压、工具治理、可解释决策**。

---

## 4. 四个系统难题

### 4.1 副作用感知的可靠执行与恢复
- 工具 = 对外部世界的真实改变，动手前先记账（双复写：PREPARED → SUCCEEDED）。
- `ToolEffect` 三分类：`READ_ONLY` / `IDEMPOTENT_WRITE` / `UNKNOWN`。
- 只有 `PREPARED + READ_ONLY` 才能自动重放；未知副作用进入人工确认（fail-closed）。
- `Checkpoint` 是稳定引用，不是内存 dump。
- 崩溃恢复：`RecoveryService.scanInterruptedRuns` 建计划 → `RecoveryExecutor` 恢复，已成功的工具不重复。

### 4.2 资源感知的准入与背压
- 读 vLLM `/metrics` + GPU 状态 → `ResourceSnapshot` → 分类 `NORMAL/WARNING/CRITICAL`。
- 分类 + 并发上下文 → 执行策略 → `START / QUEUE` 决策并持久化（`policy_decisions`）。
- **fail-closed**：资源不可观测 = 不盲目开工，默认 QUEUE。

### 4.3 工具治理
- 一次工具调用要过：权限、超时、副作用分类、可重放性判断。
- `ToolGateway.execute` 在真实执行前，先有授权决策 + PREPARED 意图证据。

### 4.4 可解释决策
- 保存模型调用、工具执行、资源快照、策略版本、理由、usage、结果。
- 任何决策（准入、工具、路由）都可在事后回放为什么。

---

## 5. 沙箱隔离（P0.5 分级）

| 等级 | 手段 | 能防什么 | 不能防什么 |
|---|---|---|---|
| P0 | 无沙箱 | — | — |
| **P0.5（当前）** | runsc gVisor + 默认 seccomp | 文件/网络/进程隔离 | 共享内核漏洞、strict VM 级隔离 |
| P1 | Kata/Firecracker | 独立内核 | 需 KVM、成本高 |

- 底层用现成 **runsc/gVisor**，亮点在上层控制面三环（策略边界、租户管控、可验证证据）。
- **诚实边界**：没有 KVM 就不声称 strict 隔离通过。

---

## 6. 真机验证证据

| 验证 | 环境 | 结果 |
|---|---|---|
| 沙箱隔离攻击 | ECS 真机 runsc | 9 项攻击 PASS（跨租户、宿主路径、穿越、Secret、网络、PID、tmpfs、kill→LOST） |
| 资源背压 | AutoDL Tesla T4 + vLLM 0.7.3 | 120 并发 → CRITICAL → QUEUE 落库 |
| 隔离性能 | runc vs runsc | 冷启动开销约 1.22x |
| 端到端 | 真实 Pi + runsc | Run 事件链 COMPLETED → workspace diff → finalText |
| 自动化测试 | bun test | **254 tests pass / 0 fail** |

---

## 7. 差异化深化（A/B/C）

在基础闭环之上，为 agent infra 岗位加的三个方向。

### A · 执行质量评测闭环（Eval）
任务能跑不代表跑得好。`src/eval/evaluation-aggregator.ts` 复用已有落库数据，**零新增采集**，算两类指标：
- 行业标配：成功率、完成度、Token、成本、延迟 P95。
- 控制面护城河：背压触发率、无人值守率、危险拦截率、cache 命中率。
输出：`scripts/eval-report.ts` 文本报表 + `GET /eval` JSON。

### B · 观测驾驶舱（Observe）
独立只读页 `/observe`，和任务操作台 `/` 解耦，多租户切换，数据来自 `GET /eval`。
可视化：状态环形图、完成度渐变条、租户对比条形、资源背压堆叠条、任务明细表。

### C · LLM 路由网关（LLM Gateway）
在 Pi 和真实模型后端之间加 OpenAI 兼容代理：
- 主备回退（网络错/超时/429/5xx），连续失败熔断。
- 每次选择记录 `RouteDecision`。
- **Agent、控制面、沙箱都不变**，只改 `models.json` 的 `baseUrl` 指向网关。
- 配置：`LLM_BACKENDS` 环境变量。

**诚实边界**：C 第一步完成（网关逻辑 + mock 测试 10 个 + 端到端冒烟）；第二步（Pi 真实调用经网关）未完成，决策记录未持久化。

---

## 8. 完成度（roadmap 完成定义 8 条已闭合）

1. 端到端：Workspace→任务→过程→结果 ✅
2. Tenant 身份来自认证上下文 ✅
3. 文件/Shell 操作发生在独立 Sandbox ✅
4. 两租户隔离攻击通过 ✅
5. 共享 GPU 压力真实改变执行 ✅
6. 故障后状态/slot/副作用安全收敛 ✅
7. 用户拿到最终回答 + Diff/Artifact ✅
8. README 明确保证/威胁模型/非目标 ✅

---

## 9. 诚实边界（面试陈述时不越界）

- **不是生产级**：单机、单数据库、无 K8s/多机/高可用、无企业 SSO/计费。
- **不用 runsc/Kata strict**：无 KVM，不声称 MicroVM 隔离通过。
- **LLM 网关**：第一步完成，第二步未完成，决策记录未持久化。
- **外部模型 Fake observer**：明确标注"非 VRAM 证据"；真机证据来自真实 vLLM 链路。
- **A6000 性能结论**：真机在 T4 完成，未在 A6000 重复验证。

---

## 10. 面试导航

- 语速过快被追问？→ `docs/interview-prep-guide.zh-CN.md` 有 30 分钟 / 2 小时 / 半天三种准备路线、话术模板、诚实边界清单。
- 需要逐条对账给证据？→ `docs/completion-status.zh-CN.md`。
- 要给人看项目门面？→ 打开 `docs/course/index.html`。

---

## 11. 文档结构速览

**当前要看的（约 4 份）：**
| 文档 | 作用 |
|---|---|
| `README.md` | 项目门面 + 技术重点 |
| `docs/project-handbook.zh-CN.md` | **唯一技术主文档（本文件）** |
| `docs/interview-prep-guide.zh-CN.md` | 面试准备 |
| `docs/completion-status.zh-CN.md` | 完成度对账 |

**对外展示：** `docs/course/index.html`（课程网站，发链接用）

**其余全部历史/中间产物** → `docs/archive/`（ADR、旧 roadmap、旧 runbook、讲解 HTML 等），需要时再查，不必通读。

---

## 12. 后续演进（待办笔记 · 未实现）

> 本节记录方向性结论与落点，**均已设计确认但尚未实现**，实现时以本节为准再同步回正文。

### 12.1 账号登录 + 会话（Web 优先）

**结论**：项目面向网页产品（用户多网页工作、少 CLI），应走向**用户账号 + 会话登录**；这不是“替换”现有的静态 API Key，而是**在同一个身份主干（域1）上加第二种认证器**：

```
Web 用户浏览器 ──cookie/会话──┐
                            ├─▶ RequestPrincipal(域1) ──▶ requirePrincipal ──▶ 策略/准入/沙箱
程序/CI ──────Bearer API key─┘          （同一身份主干，认证器可插拔）
```

- **网页/真人 → 会话登录**（主通道：短时效 token、refresh、登出、CSRF、HttpOnly/Secure/SameSite cookie）。
- **程序/CLI/CI → API Key**（次通道：保留，无状态、一把 key 一种作用域）。
- 两者都产出同一个 `RequestPrincipal`，`requirePrincipal` 是统一强制点，**现在的脊柱完全不用动**——只是新增一个 `SessionAuthenticator` 接到现有插口上。
- **现有 `api_credentials` 不丢弃**：将来演进为“挂在用户账号下的 scoped key”；`RequestPrincipal` + `requirePrincipal` + 审计就是将来登录体系的底座。

### 12.2 为什么网页优先要会话（关键理由）

1. **撤销与失效**：现在 API Key 无 TTL（schema 只有 `created_at`/`revoked_at`），泄露即永久有效；会话用短时效 token + refresh，泄露窗口小、可登出。
2. **浏览器安全**：`HttpOnly`/`Secure`/`SameSite`、CSRF 防护，API Key 给不了。
3. **多租户账号基本盘**：账号、密码、组织、每用户权限。
4. **与 12.3 协同**：账号是“用户自带云 key 并绑定身份”的自然落点。

### 12.3 云端模型 BYO（极薄透传，非重点）

- 云端不是项目重点（用云端就丢掉了资源感知这个立身之本），因此**不做域3计量/准入**，也不做服务端持有密钥的加密存储。
- 若未来需要：请求头 `X-Backend-BaseUrl` + `X-Backend-Key` **无状态透传**，网关不过夜、不落库；服务端天然无跨用户回退问题。
- **当前实现状态**：域1 已铺到网关两扇门（见 12.4），云端 BYO 后续再做。

### 12.4 网关入口域1（已实现）

本次改动已落地，实现状态标注见 `src/http/harness-http-api.ts` 与配套测试：
- `POST /v1/chat/completions` → `requirePrincipal(request, "models:generate")`
- `GET /llm-gateway/stats` → `requirePrincipal(request, "models:observe")`
- 无 `accessControl`（纯单测/演示）时降级 legacy Principal，与其它路由一致。
- 测试：`tests/http/harness-http-api.test.ts` 覆盖无 key→401 / 无效→401 / 缺 scope→403 / 合法→放行且真正转发 / 统计端点同样鉴权。

---

## 14. 第二阶段走读（鉴权后→队列→资源准入→START/QUEUED）

> 记录日期：2026-08-20。上一阶段（§12）定的是「鉴权/身份主干（域1）」。
> 本节定的是：任务**通过鉴权之后**、真正开始执行之前——从**系统查看资源到 START/QUEUED 决策**这段发生的内容。
> 状态：**仅走读/设计结论，均未实现**。实现时以本节为准再同步回正文。

### 14.1 分段职责与调用链

```
POST /runs
  └─ requirePrincipal("tasks:write")          ← 域1 鉴权，tenantId 不可由客户端自报
  └─ workspaceService.getForTenant()          ← 归属校验，不存在也 404（anti-enumeration）
  └─ coordinator.submit
       └─ runService.createQueuedRun          ① 持久化 QUEUED + RUN_CREATED(seq1)（同事务）
       └─ scheduler.enqueue                   ② 入内存公平队列（AWAITING_SCHEDULING）
  └─ queuePump.tick()                         ③ 立即触发一轮 drain，不等轮询周期

drain → attemptNext
  └─ scheduler.claimNext()                    ④ 公平选一个并占 slot（全局+租户双上限）
  └─ 构造 admissionRequest（减掉自己占的 slot）
  └─ ResourceAdmissionService.evaluate        ⑤ 观测→分类→策略→落库（见 13.2）
       ├─ QUEUE  → release → 按 reasonCode 重新 enqueue → DEFERRED
       └─ START  → executeQueuedRun → runtime.start（见 13.3）
```

涉及文件：`runs/{run-service,runstore,run-state-machine}`、`scheduling/{run-queue-coordinator,tenant-run-scheduler,run-queue-pump,queued-run-recovery-service}`、`resources/{resource-admission-service,resource-classifier,execution-policy,policy-decision-store}`、`control-plane/default-pi-control-plane`、`runtime/managed-agent-runtime`。

### 14.2 资源准入（系统查看资源 → 决策）

`ResourceAdmissionService.evaluate` 三段式：
1. **观测** `observer.observe()` → vLLM `/metrics` + GPU → `ResourceSnapshot`。
   - 观测失败 → **直接 QUEUE(`RESOURCE_OBSERVATION_FAILED`)，fail-closed**，不伪造 Snapshot。
2. **分类** `classifyResource(snapshot, thresholds)` → `NORMAL / BUSY / CRITICAL / UNKNOWN`。
   - 任一指标够到临界即升级；无可信信号才 `UNKNOWN`（`INSUFFICIENT_DATA`）。
3. **策略** `DeterministicExecutionPolicy.decide` → `START / QUEUE + reasonCode`；预算装饰器可再降级 `TENANT_BUDGET_EXCEEDED`。

每次准入都把 `policy_decisions + resource_snapshots` **同事务落库**（一个 run 反复被 defer 时保留多次决策历史）。

### 14.3 派发执行

`executeQueuedRun`：校验 `QUEUED` → `captureBefore` → 写 `RUNNING + RUN_STARTED`（同事务）→ 订阅 runtime → `runtime.start()`。

`ManagedAgentRuntime.execute`：
- 控制面归属一致性二次校验（template/instance/session ↔ run.tenantId）
- 5 层有效策略（platform/tenant/template/workspace/run）+ 编译 + 能力校验（不满足即 `REJECTED`，fail-closed）
- 创建 Attempt → 创建 Sandbox（runsc，只挂 workspace）→ 启动真实 Pi
- `agent_started` → `bindRuntimeSession`（harnessSessionId ↔ 真实 runtimeSessionRef）
- 工具经 `ToolGateway`：PREPARED → 授权 → SUCCEEDED（副作用记账）
- 事件回写 `COMPLETED/FAILED/INTERRUPTED`；finally 里 `captureAfter`/`captureArtifacts` 并 `scheduler.release` 释放槽

### 14.4 关键不变量

- **Tenant 来自鉴权、不来自客户端**，贯穿到策略/准入/沙箱。
- **fail-closed**：资源不可观测=QUEUE；能力/策略不符=REJECTED。
- **双复写**：run 快照 + run_events 同事务；policy_decisions + resource_snapshots 同事务。
- **可解释决策**：每次准入（含被 defer）都落 policy_decisions。
- **槽位双保险**：scheduler `claimNext` 硬上限 + admissionRequest 减去自身 slot 后的策略软上限，算术自洽。

### 14.5 已识别的设计缺口 / 待定（未实现）

| # | 缺口 | 影响 | 结论倾向 |
|---|---|---|---|
| ① | **harnessSessionId 由客户端自选/自报**（body 缺省才随机） | 会话固定/抢注：任意客户端可占某 sessionId，撞车即互相触发「归属不匹配」→ 对指定 id DoS | **服务端鉴权后签发 session id**，与 §12.1 的 域1→RequestPrincipal 闭环；run 引用服务端 id，再 bind 真实 Pi runtimeSessionRef |
| ② | **队列 reasonCode 仅存内存** | 重启后一律以 `AWAITING_SCHEDULING` 重新入队，`GET /queue` 的排队原因不可复现 | 队列事实入 `policy_decisions`/run 记录，恢复时可还原 reason |
| ③ | **run_events 缺 `RUN_DEFERRED/REQUEUED` 事件类型** | 反复被 defer 的 run 其"排队—再试"过程在 run 事件链上是空白 | 补 `RUN_DEFERRED` 事件，携带 reasonCode，使「一次任务的一生」事件链完整 |
| ④ | **TOCTOU 归档窗口**：claimNext 与 release+re-enqueue 之间崩溃，run 从内存队列消失但 DB 仍 QUEUED | 需等待下次进程重启的 recovery 才回队（进程内不会自动补） | 记录为已知边界；低风险 |
| ⑤ | **准入是 point-in-time**：决策 t0、派发 t1，中间资源可变 | — | 明确为「去耦的准入点」而非「实时保证」 |

---

## 13. 健壮性与信任边界（defense-in-depth 细节）

> 本节把“只有踩过坑才知道要注意”的细节**主动**写清，供吃透项目与写新代码时对照。
> 每类都标注：**已实现** / **当前短板 / 未做**，避免把现状当完美。

### 13.1 归因链：请求 → 用户/租户（已实现）

“任务匹配到谁”的完整链路（不是独立路由器，而是认证层职责）：

```
HTTP 请求 (Authorization: Bearer <key>)
  → requirePrincipal(request, scope)            // src/http/harness-http-api.ts
  → ApiCredentialStore.authenticate(digest)      // src/auth/api-credential-store.ts
  → 命中凭证行 { subjectId, tenantId, scopes }   // key 在创建时就绑定死归属
  → RequestPrincipal
  → submitRun：tenantId = principal.tenantId     // 写入 agent_runs.tenant_id，固化
  → 下游(调度/沙箱/策略/查询)永远用 run.tenantId，不再“猜归属”
```

- **任务请求体永不参与身份匹配**：body 里的 `tenantId`/`workspaceId` 只是 legacy/演示时兜底，正常路径一律忽略（见 `submitRun` 三元表达式）。
- 归属在入口一次定死并落库，这是“防串”的地基。

### 13.2 信任边界：每层信谁、不信谁（已实现）

| 层 | 信谁 | 目标 |
|---|---|---|
| HTTP 层 | 信 API key → 解出 Principal | 入站身份 |
| Service/RunStore | 信 `run.tenantId`（来自 DB，已被认证固化） | 归属与隔离 |
| 策略/工具守卫 | 信“策略快照”（不可变、绑定 runId） | 授权 |
| **Agent Runtime** | **不信——它是被隔离的对象** | 沙箱/Pi 本身    |

关键认知：**Agent 运行时代码是“敌方”，不是“可信基础设施”**。所以它对用户权限、文件、网络的访问，都必须经过外面包着的 ToolGateway + 策略 + 沙箱来拦截和限制；不能因为“它是我写的循环”就放权。

### 13.3 六道防串防线（已实现）

多租户.跨用户防串不是单靠一处，而是叠了六层：

1. **tenant 只来自身份**：`submitRun` 用 `principal.tenantId`，忽略请求体。
2. **归属链一致性校验**：`ManagedAgentRuntime.execute()` 的四元组校验（instance.tenantId、templateVersionId、session.tenantId、session.instanceId 与 run 全对得上）——任何一环不一致直接拒绝，不给 Runtime 启动机会。
3. **Session 复用校验**：`DefaultPiControlPlane.resolve()` 对已存在 session 检查 tenant/instance 归属，防复用别人 session。
4. **查询侧按 tenant 收口**：`RunStore.listForTenant(tenantId)`（WHERE tenant_id）、`WorkspaceService.getForTenant(id, tenantId)`（双参数）——服务端从不信任客户端自称归属。
5. **IDOR/枚举防御**：`getRequiredRun` 里跨租户返回 **404**（和“不存在”不可区分）而不是 403，堵枚举。
6. **数据库约束兜底**：外键、`UNIQUE`、`CHECK` 拒绝孤儿/非法状态。

> **写新代码的检查清单**（新手最易漏，务必逐条过）：
> - [ ] 新路由有没有过 `requirePrincipal` + 明确 scope？
> - [ ] 所有查询都按 `principal.tenantId` 过滤了吗（别只看请求参数）？
> - [ ] 跨租户访问统一回 404 而不是 403？
> - [ ] 错误信息会不会泄露“资源存在性/归属”？（应不可区分）
> - [ ] 新表是否带 `tenant_id` 列、是否有外键/唯一约束？
> - [ ] 该动审计吗（`access_audit_events`）？

### 13.4 默认拒绝 / fail-closed（已实现）——宁可失败也不放行的地方

出问题时，系统要“宁可拒绝”而不是“放行再看”：

- **资源观测失败** → 决策强制 `QUEUE` + `UNKNOWN`，且要求 snapshot 为 null、携带失败原因（migration v4 的 CHECK 双重保证）。
- **策略快照缺失/不匹配** → 工具调用直接拒绝（`PersistentToolPolicyGuard` 抛错）。
- **bash 无法证明不越界/无网络**（开发 profile）→ 按策略拒绝。
- **strict profile 的沙箱不可用** → `UnavailableStrictSandboxProvider` fail-closed，而不是降级到弱沙箱。

原则：**对“未知/不可证明安全”的路径，默认 deny**；安全是从“不允许”起步，逐条放行，而不是从“全允许”收窄。

### 13.5 并发与竞态（已实现）——多进程/多写入不会乱

- **Run 更新用了乐观锁**：`RunStore.update` 的 `UPDATE ... WHERE id=$id AND status=$previousStatus`，`changes !== 1` 即抛错——“过期快照覆盖新状态”被挡。
- **事件去重**：`UNIQUE(run_id, dedupe_key)` 让同一 Runtime 事实重复投递被幂等吞掉（`appendEventIfNew`）。
- **Slot 预留**：调度器 `claimNext()` 先占并发 slot 再启动，`release()` 在退出时归还。
- **启动重建**：进程重启后，内存调度队列从 `listQueuedRuns()`（持久化的 QUEUED 行）重建；`listActiveRuns()` 把陈旧 RUNNING 转 INTERRUPTED 再决定恢复。
- **事件-状态同事务**：`RunStore.create/update` 在同一个 SQLite 事务里写 Run 快照 + 事件，避免“状态变了但历史没记”。

### 13.6 幂等、重放与恢复的归属约束（已实现）

- **Checkpoint 绑定 runId**：`queueResume/executeQueuedResume` 校验 `checkpoint.runId === runId` 且 checkpointId 匹配，不属于当前 Run 的 Checkpoint 不能用来恢复。
- **工具重放只对安全副作用**：`ToolGateway` 仅当历史 `status=PREPARED` 且 `effect` 可安全自动重放时才复用结果；否则抛错等人工（见 `canAutomaticallyReplay`）。
- **策略快照绑定 runId**：工具守卫要求 `snapshot.runId === input.runId`，杜绝拿别人 Run 的策略做裁决。

> 恢复是**防串的一个隐蔽死角**：如果恢复时不校验 Checkpoint/策略快照的 runId 归属，就可能“用 A 的恢复数据去驱动 B”。上面三处都是靠 runId 强绑定堵住的。

### 13.7 状态机 + 数据库约束双重保险（已实现）

- 应用层：`assertValidTransition(from, to)` 拒绝非法状态迁移。
- 数据库层：`CHECK` 约束（如状态枚举、fail-closed 组合）在存储层再挡一次。
- 目的：**同一规则在两层都强制**，单点疏漏不会放行。

### 13.8 威胁清单与当前短板（诚实标注）

| 威胁 | 现状 | 缺口说明 |
|---|---|---|
| 冒充/伪造 tenant | ✅ 已防 | tenant 只来自身份 |
| 跨租户 IDOR | ✅ 已防 | 404 + 查询收口 |
| Session 劫持/复用 | ✅ 已防 | 归属校验 |
| **API key 泄露** | ⚠️ 弱点 | **无 TTL**，泄露即长期有效；见 12.1 |
| **网关 DoS/无配额** | ⚠️ 缺口 | 网关已锁域1，但**没有 per-tenant 限流/配额**；恶意调用可消耗共享 GPU |
| **浏览器会话** | ⏳ 未做 | 尚无会话/CSRF（因为没有 Web 会话，故现阶段不适用） |
| 文件系统逃逸 | ⚠️ 开发profile弱 | 默认 `managed-local`/`development` 隔离弱；产品化须 container/`strict` |
| **跨用户回退到他人云 key** | ✅ 设计上消除 | 本地无 per-user key；云端若做 BYO 则按 12.3 无状态透传，天然无跨用户 |

---

### 13.9 一句话总结这套“防串 + 健壮性”骨架

> **身份一次认证、归属一路固化**（13.1）；**每层明确信谁、Agent 是不被信的对象**（13.2）；**六层防线叠着防跨租户**（13.3）；**未知即拒绝、多写一致、恢复必校归属、双层强制状态**（13.4–13.7）；**剩余短板集中在 key 无TTL、网关无限流、开发级沙箱**（13.8）。写新代码时对着 13.3 的检查清单逐条跑一遍，能挡掉大部分“想不到”的坑。
