# Module 1: 项目定位与全局图景

## Teaching Arc
- **Metaphor:** 物业公司 vs 房客。Agent（Pi）是房客——会自己做饭、洗澡、接待客人（思考、调模型、用工具）；Harness 是物业公司——决定谁能进楼、哪间房给谁用、水电超载要限流、出了事故怎么善后、最后把干净的房子交还用户。物业不替房客过日子，但没有物业的楼是危楼。
- **Opening hook:** 面试官问"介绍一下你的项目"，你的前 30 秒决定了后面 30 分钟聊什么。这个模块给你那 30 秒，以及它背后的整张地图。
- **Key insight:** 这个项目不是"又一个 Agent"，而是 Agent 之外的控制面：行为平面归 Pi，控制平面归 Harness，基础设施平面提供沙箱/GPU/模型。控制面不替模型做工具选择，但必须在副作用发生前有最终否决权。
- **Why should I care:** 面试的第一题必然是"这是什么"。答错层次（把它说成 Agent 应用）会让后面所有深挖都失去支点。

## 必讲内容（面试话术级）

### 一句话定位（必须原文背下）
> **VRAM-Aware Agent Harness 是一个支持团队共享本地大模型的多租户 Agent 任务服务。** 用户在独立 Workspace 中提交任务、观察 Agent 执行并获得最终回答、文件 Diff 和 Artifact；系统负责可信租户身份、隔离运行环境、公平调度共享 GPU、工具权限与副作用治理，以及故障后的安全恢复。

### 四个系统难题（项目的骨架，后续模块逐一展开）
1. **副作用感知的可靠执行与恢复** — 工具是对外部世界的真实改变；动手前先记账（双复写 PREPARED→SUCCEEDED）；崩溃后只重放安全副作用 → Module 3
2. **资源感知的准入与背压** — 读 vLLM /metrics + GPU 状态 → 分类 NORMAL/BUSY/CRITICAL/UNKNOWN → START/QUEUE 决策落库；观测失败=QUEUE（fail-closed）→ Module 4
3. **工具治理** — 每次工具调用过权限、超时、副作用分类、可重放性判断 → Module 3/7
4. **可解释决策** — 模型调用、工具执行、资源快照、策略版本、理由、usage 全部落库，事后可回放"为什么" → 贯穿全部

### 七层 Agent Infra 坐标（差异化定位）
| 层 | 内容 | 本项目 |
|---|---|---|
| ①② | Agent Runtime / Tool 接入 | 复用 Pi，ToolGateway 处接入 |
| **③ Environment/Sandbox** | 租户隔离执行环境 | **自建重点** |
| **④ Execution/Orchestration** | 身份、策略、调度、生命周期、恢复 | **自建重点** |
| ⑤ | 事件与指标 | 只做证明隔离/调度/恢复所需的部分 |
| ⑥ | 回归验收 | 测试与真机 smoke |
| ⑦ | vLLM + GPU | 外部依赖，不接管 token 级调度 |

关键表述："项目不重新实现模型—工具循环。Agent 负责'动脑'，本系统负责'安排与安保'。"

### 技术栈一句话
Bun + TypeScript + SQLite（单机控制面）· Pi SDK 0.80.10（Agent Runtime，依赖倒置接口 AgentRuntime）· runsc/gVisor 容器沙箱 · 自托管 vLLM（OpenAI 兼容）· RTX A6000 48GB 基线 / T4 真机验证。

### 量化数字（30 秒电梯稿要用）
254 tests pass / 0 fail · 9 项沙箱攻击真机 PASS · T4 120 并发→CRITICAL→QUEUE 落库 · runc vs runsc 冷启动 1.22x · 15 个 schema migration · 8 个 HTTP 端点。

### 30 秒电梯稿（原样给出）
> 我做了一个多租户 Agent 任务控制面。Agent 负责"动脑"，我的系统负责"安排与安保"：多租户身份、GPU 资源准入与背压、runsc 沙箱隔离、工具副作用记账与崩溃恢复，以及执行评测、观测驾驶舱和 LLM 路由网关三个深化方向。254 个测试全绿，并在 T4 GPU 上做了 120 并发的真机验证。

### 3 分钟版结构
起源观察（真实任务不能只靠 Agent 自己）→ 四个系统难题 → 技术选型与理由 → fail-closed 设计哲学 → A/B/C 差异化 → 诚实边界（不是生产级）。

## Interactive Elements
- [ ] **Pattern cards** — 四个系统难题四张卡（每张注明对应模块号）
- [ ] **Interactive architecture diagram** — 三平面图（Behavior=Pi / Control=Harness / Infrastructure=vLLM+GPU+Docker），点击组件显示职责与"不负责什么"
- [ ] **Quiz** — 3 题：(1) 场景题：面试官说"你这不就是封装了 LangChain 吗"，最佳回应角度是什么；(2) 本项目自建的是七层中哪两层；(3) "控制面不替模型做工具选择，但必须在副作用发生前有最终否决权"——这句话对应的架构决策是什么
- [ ] **Callout** — "为什么诚实边界是护城河"：主动说"这不是生产级"比被追问出来好得多
- [ ] **Icon rows** — 技术栈五件套（Bun/Pi/runsc/vLLM/SQLite）各一句"为什么选它"

## Reference Files to Read
- `references/content-philosophy.md` → 全文
- `references/gotchas.md` → 全文
- `references/interactive-elements.md` → Multiple-Choice Quizzes, Interactive Architecture Diagram, Pattern/Feature Cards, Callout Boxes, Icon-Label Rows, Glossary Tooltips
- `references/design-system.md` → Color Palette, Module Structure

## Connections
- **Next module:** Module 2 用"一次任务的一生"把这张静态地图变成动态旅程。
- **Tone/style notes:** 全课程中文；代码保留英文原名；术语首次出现加 tooltip（如 backpressure、control plane、fail-closed）；actor 配色：Pi=actor-2 teal，Harness=actor-1 accent，vLLM/GPU=actor-4 golden，Sandbox=actor-5 forest。
