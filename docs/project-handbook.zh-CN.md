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
