# 主流多租户 Agent 管理调研（我们该对标谁）

> 一手资料来源（2026-08 真实抓取）：
> - Google Cloud Architecture Center —「多租户智能体 AI 系统」参考架构（2026-06-18 审阅）
> - Microsoft Learn —「多租户解决方案中 AI/ML 的架构方法」
> - E2B Docs —「Projects」「Sandbox lifecycle」
> 其余（托管平台 / 编排框架 / Daytona 开源）为领域通常做法，标注后未逐一爬取。

---

## 一、调研到的四大主流模式

### 模式 1：云厂商「枢辐 + 租户=独立基础设施」（Google Cloud 参考架构）

- **租户模型**：每个业务部门 = 一个**独立的 Google Cloud 租户项目**（Tenant Project）。
- **结构**：中央 Hub（外部负载均衡 + WAF/Model Armor 防提示注入 + IAP 零信任身份 + 前端路由引擎）→ 路由到隔离的 Spoke（每个租户一张 PAB Principal Access Boundary 硬边界）。
- **租户隔离**：项目级 + IAM + **PAB 边界（Principal 只能访问其获批边界内的资源）+ 独立数据存储的数据主权**。即使代理身份被攻破，也访问不到别人的资源。
- **工具/数据访问**：通过 **MCP 服务器** 访问租户数据存储；RAG 只在租户自己库里做。
- **资源管控**：IAM 配额 + 云原生计量；边缘 Model Armor 做 PII 遮掩。
- **适合**：大企业、多部门、预算充足、要强数据主权与合规。

### 模式 2：托管 Agent 平台（OpenAI AgentKit / Assistants、Azure Agent Service、Bedrock Agents、LangGraph Platform）

- 平台托管 **agent 生命周期 / session / 有状态编排 / 工具 / 运行时**。
- 多租户通常体现为：**账户 / 组织 / API key 隔离与配额**，平台侧做计量、额度（credit）、并发与速率限制。
- 沙箱多为**平台托管执行环境**（可信代码），用户不可控底层。
- 资源管控 = 平台级配额 + 额度计费，较少暴露「沙箱隔离边界」给租户。
- **适合**：要 API 直接调、不想自建控制面的开发者。

### 模式 3：沙箱即服务（E2B / Daytona / Modal）

- **E2B 的租户模型**最典型：**Project（原 Teams）= 资源/额度/隔离的边界**。
  - 每个 API key 只 scoped 到 **一个** project；project 决定沙箱、模板、计费、限额。
  - 限额按 project 计：并发沙箱数、持续运行时长、磁盘大小。
  - **sandbox 生命周期**：timeout、运行时 `setTimeout` 续期、**pause/resume（保留完整状态，无限期恢复基准）**、`kill`。
- **做的是"执行环境 API"**：不附带策略 / 工作流 / 副作用恢复。隔离做到 project 级，执行环境很薄。
- **适合**：要可靠、可扩缩、可计费的 AI 代码执行环境。

### 模式 4：开源 / 自建控制面（OpenHands、Cline、我们这类）

- 自带或多租户化的控制面：调度、Workspace、工具网关、审计。
- 隔离通常靠容器：GKE Sandbox 用 **gVisor/runsc**（Google 生产也在用，与我们 default 同款）；我们也沿此路线。
- 弹性大、可控、成本低（单控制面 + 共享池）；但隔离/资源管控/可靠性的工程深度要靠自己补。

---

## 二、各家一致的"多租户 Agent 管理"共性

1. **身份/租户 -> 资源边界**：一律是「key / 身份 -> 租户 -> 资源池与限额」的映射。E2B 的 project、Google 的 tenant project、各平台的 org 都如此。
2. **隔离是分层硬边界**：数据/项目隔离（Google PAB、E2B project、各家 IAM）+ 执行隔离（沙箱/microVM）。
3. **额度与计量是资源管控的主形态**：并发上限、时长、磁盘、GPU 按时计费；几乎没有人做"租户级策略驱动的 Fair-Share + 资源核算账本"。
4. **沙箱都有命周期管理**：造、跑、超时暂停/续期、保留状态恢复、杀死。
5. **可观测/审计是关键**：各家都强调日志汇聚到中央（Google Cloud Logging、平台 telemetry）。

---

## 三、和我们的项目逐条对照

| 能力 | Google（重） | E2B（薄） | 我们（VRAM-Harness） | 差距/机会 |
|---|---|---|---|---|
| 租户边界 | 独立 GCP 项目 | **Project（key 映射+限额）** | Tenant + ApiCredentialStore（key→tenant） | ✅ 已具雏形 |
| 执行隔离 | 项目级+PAB | microVM/沙箱 | **runsc 容器级**（strict 预留 microVM） | ◐ 差 microVM 证据 |
| 资源管控 | IAM/云计量 | **project 限额（并发/磁盘/时长）** | DeterministicPolicy+ResourceLimits+vLLM 准入 | ⚠ **最大空白：无租户级 Fair-Share/预算/账本** |
| 沙箱生命周期 | 云原生 | **timeout/pause/resume/kill** | create/terminate + **kill→LOST** | ◐ 缺 pause/resume |
| 工作流/策略 | 有（编排码） | 无 | **Run/Attempt/Checkpoint/Recovery/Policy** | ✅ 我们的强项 |
| 副作用恢复 | 一般 | 无 | **ToolGateway 记账 + 恢复** | ✅ 差异化亮点 |
| 可观测/审计 | 中央日志 | 计费报表 | AccessAuditStore + PolicyDecisionStore + Evidence | ◐ 可做深 |
| 成本模型 | 重（租户=基建） | 按沙箱计量 | **单控制面 + 共享池** | ✅ 我们的优势 |

---

## 四、结论：哪个最适合我们？

**我们的卡位不在"重"也不在"薄"，而在中间那条空白带：**
> 主流要么像 Google 那样「每个租户 = 一套独立基础设施」（重、贵，非我们能做），要么像 E2B 那样「租户 = 一个执行环境 + 计费 project」（薄，不做策略/恢复）。
> 我们是**「单控制面 + 共享资源池 + 强多租户隔离 + 完整 agent 生命周期」**——正是这两者之间没人做深的地方。

**最值得对标/借鉴的是 E2B 的 project 模型**（租户=资源额度边界 + 沙箱生命周期 + 限额），因为：
1. 它的「租户 → key → 资源限额」映射和我们的 ApiCredentialStore/Tenant 完全同构——**我们的差异化就是把它的"计费限额"升级成"策略驱动的租户级资源管控"**。
2. 它的 sandbox timeout/pause/resume 提醒我们可补「暂停恢复」生命周期。

**要形成真正的差异化（而不是抄），聚焦三件别人没做深的事：**
1. **租户级资源预算 + Fair-Share + 核算账本**（把"限额"升级为"可审计的资源会计"）——学界/业界主流只有额度计费，没有策略化 Fair-Share + 账本。
2. **策略 → 沙箱安全边界的确定性编译 + 可验证证据链**（我们的 OciSandboxSpecCompiler + SandboxRuntimeEvidence 深化）。
3. **隔离的"行为边界"**（借鉴 Google PAB 思想：每次 attempt 的沙箱只能访问本 Run 的 workspace/secret，key 只认一个租户）——把这做成一等公民证据。

这三件**全都不需要 GPU/KVM 就能在本机做深**，且正好落回我们已有基座（Tenant、ApiCredentialStore、OciSandboxSpecCompiler、SandboxRuntimeEvidence、ToolGateway、PolicyDecisionStore）。

---

## 参考

- Google Cloud Architecture Center: Multi-tenant agentic AI system（枢辐 + PAB + MCP）
- Microsoft Learn: Architectural approaches for AI/ML in multitenant solutions（silo/pool/shared/tuned models）
- E2B Docs: Projects（project=key/sandbox/billing/limits 边界）、Sandbox lifecycle（timeout/pause/kill）
- 本项目：`src/auth/api-credential-store.ts`、`src/sandbox/`、`src/resources/`、`src/policies/`、`src/checkpoints/`
