"use client";

import { useEffect, useMemo, useState } from "react";

type PhaseStatus = "done" | "current" | "next";
type Phase = {
  id: string; index: string; title: string; short: string; status: PhaseStatus;
  intent: string; before: string; outcome: string; next: string;
  deliverables: string[]; evidence: string[];
};

const phases: Phase[] = [
  {
    id: "foundation", index: "00", title: "可靠执行内核", short: "Run、事件、副作用、Checkpoint", status: "done",
    intent: "先证明 Agent 长任务可以被持久化、解释和安全恢复，而不是失败后盲目重跑。",
    before: "Pi 只负责单次 Agent Loop，系统还没有跨进程保存 Run 事实、工具副作用和恢复边界。",
    outcome: "Run/Attempt 状态机、追加事件、ToolGateway、Checkpoint 与恢复决定已经形成闭环。",
    next: "在不破坏恢复合同的前提下，把资源压力和多租户公平性接入执行路径。",
    deliverables: ["AgentRuntime + PiAdapter", "SQLite Run/Event Store", "ToolExecution 副作用分类", "Checkpoint 与安全恢复"],
    evidence: ["状态转换与事务测试", "成功工具结果不重复执行", "未知副作用 fail closed"],
  },
  {
    id: "control-baseline", index: "01", title: "资源与策略基线", short: "公平队列、准入、版本化策略", status: "done",
    intent: "让 GPU/vLLM 事实真正改变任务何时运行，并留下可解释的策略证据。",
    before: "可靠恢复已经具备，但所有任务仍可能同时冲向有限 GPU，单一 Tenant 也可能长期占用 slot。",
    outcome: "资源观测、START/QUEUE 决策、Tenant round-robin、Template/Instance/Capability 与最小策略 Sandbox 已进入主路径。",
    next: "从可信身份开始，把逻辑上的 tenantId 变成真实的安全边界。",
    deliverables: ["ResourceObserver + Admission", "Tenant 公平队列与 slot", "Template / Instance / Attempt", "EffectivePolicySnapshot"],
    evidence: ["CRITICAL/UNKNOWN 触发排队", "Tenant 间非饥饿", "资源恢复自动推进队列"],
  },
  {
    id: "identity", index: "02", title: "可信多租户入口", short: "API Key、Principal、Tenant-scoped API", status: "current",
    intent: "让 Tenant 来自可信认证上下文，而不是客户端可以随意填写的字段。",
    before: "现有 API 仍把请求体 tenantId 和全局 runId 当作外部输入，存在越权读取和操作风险。",
    outcome: "认证后生成 RequestPrincipal，所有外部读取、创建、中断和恢复都按 Tenant 收口。",
    next: "身份边界稳定后，建立服务端受管的 Workspace 和 ExecutionProfile。",
    deliverables: ["高熵 API Key 与摘要存储", "RequestPrincipal + scopes", "Tenant-scoped Store/Service", "授权允许/拒绝审计"],
    evidence: ["A 无法读取 B 的 Run/Event", "A 无法 interrupt/resume B", "跨租户对象统一返回 404"],
  },
  {
    id: "workspace", index: "03", title: "Workspace 与环境契约", short: "受管目录、ExecutionProfile、Secret 引用", status: "next",
    intent: "把用户项目和运行环境变成服务端可验证、可版本化的产品对象。",
    before: "身份已经可信，但客户端若仍能提交任意宿主机路径，Agent 依然可能越过项目边界。",
    outcome: "workspaceId 只映射到 Tenant Root，环境镜像、工具、网络、资源和 Secret 编译成不可变 SandboxSpec。",
    next: "把 SandboxSpec 落实为每个 Attempt 的真实容器，而不是只保存元数据。",
    deliverables: ["Workspace Store 与 Tenant Root", "路径规范化与逃逸防护", "版本化 ExecutionProfile", "Tenant-scoped SecretReference"],
    evidence: ["同名 Workspace 互不冲突", "../、绝对路径、symlink escape 被拒绝", "Secret 只保存引用"],
  },
  {
    id: "sandbox", index: "04", title: "真实容器 Sandbox", short: "每 Attempt 隔离文件、进程、网络与资源", status: "next",
    intent: "让 Agent 的代码和 Shell 工具真正运行在隔离环境内，形成第③层核心能力。",
    before: "ManagedLocal 只能表达生命周期和策略，不能阻止进程读取宿主机上其他用户可见的文件。",
    outcome: "每个 Attempt 创建独立非 root 容器，只挂载本次 Workspace，并限制网络、Secret、CPU、内存和 PID。",
    next: "将容器丢失、超限退出和控制面重启纳入统一的编排收敛链。",
    deliverables: ["ContainerSandboxProvider", "Sandbox Executor", "只读 RootFS + cap-drop", "cgroup / PID / 网络限制"],
    evidence: ["跨 Tenant 文件与 Secret 攻击失败", "任意外连默认失败", "fork bomb 只影响当前容器"],
  },
  {
    id: "orchestration", index: "05", title: "编排与恢复强化", short: "Sandbox 生命周期、slot 收敛、人工确认", status: "next",
    intent: "把身份、策略、Sandbox、资源和恢复串成同一条可靠任务链。",
    before: "容器提供了隔离，但创建失败、被 kill 或服务重启时仍可能遗留 Run、slot 或未知副作用。",
    outcome: "Attempt 只在 Sandbox ready 后运行；失败、丢失、超限和重启都能重建状态并安全恢复。",
    next: "将内部可靠性能力转化为用户能看懂、能操作、能取得结果的任务体验。",
    deliverables: ["Sandbox/Attempt 状态映射", "幂等 slot 释放", "REVIEW_REQUIRED", "重启队列与恢复重建"],
    evidence: ["kill Sandbox 不泄漏 slot", "恢复重新经过身份与准入", "危险副作用不自动重放"],
  },
  {
    id: "product-loop", index: "06", title: "用户任务闭环", short: "任务界面、实时过程、Diff 与 Artifact", status: "next",
    intent: "让用户使用的是一个完整 Agent 任务服务，而不是内部状态机和资源控制 API。",
    before: "底层执行已经可信，但用户仍需要理解 RunStore、PolicyDecision 和 SandboxProvider。",
    outcome: "用户可以创建 Workspace、提交任务、看排队与实时输出、处理中断，并取得回答、Diff 和 Artifact。",
    next: "在真实 A6000/Linux 环境中用压力、攻击和故障实验验证所有承诺。",
    deliverables: ["Workspace / Task API", "任务列表与详情", "实时文本和工具时间线", "Result / Diff / Artifact"],
    evidence: ["新用户完成端到端流程", "失败原因与恢复建议可理解", "完成态包含可消费结果"],
  },
  {
    id: "validation", index: "07", title: "真实验收与项目交付", short: "A6000、攻击测试、故障注入、演示材料", status: "next",
    intent: "用可复现证据证明隔离、公平、恢复和用户价值，而不是依靠架构图自证。",
    before: "本地 Fake 测试可以证明语义，但不能证明容器隔离、GPU 收益和真实模型兼容性。",
    outcome: "形成固定任务集、原始数据、攻击矩阵、一键演示、架构说明和诚实限制。",
    next: "根据岗位要求与真实瓶颈，再决定是否进入多 Worker、异构 Runtime 或 vLLM 深化。",
    deliverables: ["Direct Pi vs Harness 对照", "多租户攻击矩阵", "故障注入报告", "三分钟演示与追问材料"],
    evidence: ["公平顺序可复现", "重复外部副作用为 0", "无证据时不宣称性能或生产级隔离"],
  },
];

const statusLabel: Record<PhaseStatus, string> = { done: "已完成", current: "当前阶段", next: "待推进" };

const finishCriteria = [
  "用户能够完成 Workspace → Task → Result 的端到端流程",
  "Tenant 身份来自认证上下文，而不是客户端自报 tenantId",
  "Agent 的文件和 Shell 操作真实发生在每 Attempt 独立容器中",
  "不同 Tenant 的数据、文件、进程、Secret 和权限攻击测试通过",
  "GPU/vLLM 压力真实改变任务执行，公平顺序可查询、可复现",
  "Sandbox/Agent 故障后状态、slot 与工具副作用安全收敛",
  "完成态交付最终回答、Diff、测试结果和 Artifact",
  "README 与演示明确当前保证、威胁模型和不做的范围",
];

const threatRows = [
  ["伪造 tenantId / 猜测对象 ID", "Principal 派生 Tenant；所有外部查询 Tenant-scoped", "跨租户读取与操作返回 404"],
  ["路径穿越 / symlink escape", "workspaceId 映射 Tenant Root；规范化后校验", "../、绝对路径与链接逃逸全部失败"],
  ["恶意 Prompt 诱导工具越权", "Effective Policy + ToolGateway + Sandbox 三层强制", "模型输出不能扩大调用者权限"],
  ["读取其他文件与 Secret", "每 Attempt 独立 mount；按 Run 注入 Secret", "容器内探测攻击无法获取其他 Tenant 数据"],
  ["网络外传", "默认无网络；模型请求走受控入口", "任意外连失败，授权模型调用可用"],
  ["fork bomb / 内存耗尽", "PID、CPU、内存、超时限制", "只终止当前 Sandbox，slot 正确释放"],
  ["Sandbox kill / 服务重启", "事件、Checkpoint、队列重建与恢复决定", "不泄漏 slot，不重复危险副作用"],
];

export default function Home() {
  const [activeId, setActiveId] = useState("identity");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const activePhase = useMemo(() => phases.find((phase) => phase.id === activeId) ?? phases[2], [activeId]);
  const activeItems = [...activePhase.deliverables, ...activePhase.evidence];
  const activeChecked = activeItems.filter((item) => checked[`${activePhase.id}:${item}`]).length;

  useEffect(() => {
    const stored = window.localStorage.getItem("vh-project-atlas-progress-v1");
    if (stored) {
      try { setChecked(JSON.parse(stored) as Record<string, boolean>); return; } catch { /* use baseline */ }
    }
    const baseline: Record<string, boolean> = {};
    phases.filter((phase) => phase.status === "done").forEach((phase) => [...phase.deliverables, ...phase.evidence].forEach((item) => { baseline[`${phase.id}:${item}`] = true; }));
    setChecked(baseline);
  }, []);

  function toggleItem(key: string) {
    setChecked((current) => {
      const next = { ...current, [key]: !current[key] };
      window.localStorage.setItem("vh-project-atlas-progress-v1", JSON.stringify(next));
      return next;
    });
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="返回顶部"><span className="brandMark">VH</span><span>VRAM-Aware · Project Atlas</span></a>
        <nav aria-label="页面导航"><a href="#mission">项目定义</a><a href="#roadmap">阶段路线</a><a href="#architecture">系统结构</a><a href="#finish-line">完成标准</a></nav>
      </header>

      <section className="hero shell" id="top">
        <div className="heroCopy">
          <p className="eyebrow">PROJECT FLIGHT DECK · AUG 2026</p>
          <h1>从共享模型，到一个<br /><em>真正可交付的 Agent 服务</em></h1>
          <p className="heroLead">这是一份伴随开发推进的技术地图。每完成一个阶段，都从这里回看此前建立的合同、当前必须交付的证据，以及下一阶段为什么可以开始。</p>
          <div className="heroActions"><a className="primaryButton" href="#roadmap">查看当前阶段</a><a className="textButton" href="#mission">先理解项目边界 <span>↘</span></a></div>
        </div>
        <aside className="missionCard" aria-label="当前项目状态">
          <div className="missionTop"><span className="pulseDot" /><span>NOW BUILDING</span><b>02 / 07</b></div>
          <h2>可信多租户入口</h2><p>从 API Key 生成可信 Principal，让 Tenant 成为真实授权边界。</p>
          <div className="missionMeta"><div><span>已经具备</span><strong>可靠执行内核</strong></div><div><span>本阶段出口</span><strong>跨租户操作全部失败</strong></div><div><span>随后进入</span><strong>Workspace 与环境契约</strong></div></div>
        </aside>
      </section>

      <section className="missionSection" id="mission"><div className="shell missionGrid"><div><p className="sectionLabel">01 · PRODUCT DEFINITION</p><h2>我们具体要做什么？</h2></div><p className="definition">构建一个供团队共享本地大模型的<strong>多租户 Agent 任务服务</strong>：用户在独立 Workspace 中提交任务、观察过程并获得回答、代码 Diff 和 Artifact；系统为每个 Attempt 分配隔离容器，依据 GPU/vLLM 状态公平调度，并通过副作用记录与 Checkpoint 实现安全恢复。</p></div></section>

      <section className="roadmapSection shell" id="roadmap">
        <div className="sectionHeading"><div><p className="sectionLabel">02 · STAGE NAVIGATOR</p><h2>完成一段，再回到这里确认方向</h2></div><p>选择阶段，查看它承接什么、要交付什么、怎样算完成。</p></div>
        <div className="roadmapLayout">
          <div className="phaseRail" role="tablist" aria-label="项目阶段">
            {phases.map((phase) => <button key={phase.id} className={`phaseButton ${activeId === phase.id ? "active" : ""} ${phase.status}`} onClick={() => setActiveId(phase.id)} role="tab" aria-selected={activeId === phase.id}><span className="phaseIndex">{phase.index}</span><span className="phaseTitle"><b>{phase.title}</b><small>{phase.short}</small></span><span className="phaseStatus">{statusLabel[phase.status]}</span></button>)}
          </div>
          <article className="phaseDetail" role="tabpanel">
            <div className="detailHeader"><div><span className={`statusPill ${activePhase.status}`}>{statusLabel[activePhase.status]}</span><span className="detailIndex">PHASE {activePhase.index}</span></div><h3>{activePhase.title}</h3><p>{activePhase.intent}</p><div className="progressLine"><span style={{width:`${(activeChecked / activeItems.length) * 100}%`}} /></div><small className="progressText">个人复盘进度 {activeChecked} / {activeItems.length} · 勾选记录仅保存在当前浏览器</small></div>
            <div className="continuityGrid"><div><span>此前建立</span><p>{activePhase.before}</p></div><div className="outcome"><span>本阶段完成后</span><p>{activePhase.outcome}</p></div><div><span>随后进入</span><p>{activePhase.next}</p></div></div>
            <div className="detailLists"><div><h4>必须交付</h4><ul>{activePhase.deliverables.map((item) => { const key=`${activePhase.id}:${item}`; return <li key={item}><button className={checked[key] ? "checkItem checked" : "checkItem"} onClick={() => toggleItem(key)} aria-pressed={Boolean(checked[key])}><span>{checked[key] ? "✓" : ""}</span>{item}</button></li>; })}</ul></div><div><h4>完成证据</h4><ul>{activePhase.evidence.map((item) => { const key=`${activePhase.id}:${item}`; return <li key={item}><button className={checked[key] ? "checkItem checked" : "checkItem"} onClick={() => toggleItem(key)} aria-pressed={Boolean(checked[key])}><span>{checked[key] ? "✓" : ""}</span>{item}</button></li>; })}</ul></div></div>
          </article>
        </div>
      </section>

      <section className="architecturePreview" id="architecture"><div className="shell"><p className="sectionLabel">03 · SYSTEM CONTRACT</p><div className="architectureTitle"><h2>用户看到任务闭环，内部专注第③与第④层</h2><p>Pi 和 vLLM 是依赖；隔离环境与可靠编排才是我们的核心实现。</p></div><div className="stackFlow" aria-label="项目系统结构"><div className="stack user"><span>用户产品</span><b>Identity · Workspace · Task · Result</b></div><div className="stack focus"><span>④ Execution / Orchestration</span><b>Policy · Queue · Run / Attempt · Recovery</b></div><div className="stack focus"><span>③ Environment / Sandbox</span><b>Filesystem · Process · Network · Secret · cgroup</b></div><div className="stack dependency"><span>复用能力</span><b>Pi Agent Runtime · ToolGateway · vLLM / GPU</b></div></div></div></section>

      <section className="journeySection shell">
        <div className="sectionHeading"><div><p className="sectionLabel">04 · ONE TASK, END TO END</p><h2>一条用户任务必须穿过的完整链路</h2></div><p>任何阶段的实现，都要能指出它改变了这条链路中的哪一个边界。</p></div>
        <div className="journeyFlow">
          {[ ["01","认证入口","API Key → Principal"], ["02","项目空间","Tenant Workspace"], ["03","任务编排","Run → Admission → Queue"], ["04","隔离执行","Attempt → Container"], ["05","Agent 工作","Pi → Tools → vLLM"], ["06","结果与恢复","Diff · Artifact · Checkpoint"] ].map(([n,title,copy]) => <div className="journeyStep" key={n}><b>{n}</b><span>{title}</span><small>{copy}</small></div>)}
        </div>
        <div className="objectMap">
          <div className="objectRoot"><span>TENANT</span><b>身份、策略、配额与审计归属</b></div>
          <div className="objectBranch"><span>Member / ApiCredential</span><span>ExecutionProfile</span><span>Workspace</span><span>Quota / SecretReference</span></div>
          <div className="objectPath"><span>Workspace</span><i>→</i><span>Session</span><i>→</i><span>Run</span><i>→</i><span>Attempt</span><i>→</i><span>SandboxInstance</span><i>→</i><span>Result</span></div>
        </div>
      </section>

      <section className="threatSection">
        <div className="shell"><div className="sectionHeading"><div><p className="sectionLabel">05 · THREAT MODEL</p><h2>隔离不是“开了一个新进程”</h2></div><p>控制面鉴权、数据收口与容器执行隔离必须同时成立，任何一层都不能替代另外两层。</p></div>
          <div className="threatTable"><div className="threatHead"><span>风险</span><span>强制边界</span><span>通过证据</span></div>{threatRows.map(([risk,boundary,proof]) => <div className="threatRow" key={risk}><b>{risk}</b><span>{boundary}</span><span>{proof}</span></div>)}</div>
          <p className="honestLimit"><strong>诚实边界：</strong>第一版防御同机、不互信 Tenant 之间的应用级与容器级越权，不声称抵御宿主机内核漏洞、容器逃逸、恶意管理员或物理攻击。</p>
        </div>
      </section>

      <section className="reviewSection shell">
        <div className="sectionHeading"><div><p className="sectionLabel">06 · REVIEW RITUAL</p><h2>每完成一个阶段，都做一次五步复盘</h2></div><p>阶段不是按“文件写完”关闭，而是按合同、证据和下一阶段前置条件关闭。</p></div>
        <div className="reviewSteps">
          {[ ["01","回看前置合同","确认没有破坏上一阶段的状态机、事务、隔离或恢复语义。"], ["02","逐项核对交付","在上方阶段卡中勾选真实进入主路径的能力，不把接口或枚举当成完成。"], ["03","保存完成证据","记录测试、攻击、日志、指标、配置与失败样本；Fake 结果不替代真实环境结论。"], ["04","更新事实来源","同步 README、ADR、路线图和本页状态，明确“已经完成”与“仍是目标”。"], ["05","确认下一步可开始","只有退出条件全部成立，才进入下一阶段；否则继续补最短缺口。"] ].map(([n,title,copy]) => <article key={n}><b>{n}</b><h3>{title}</h3><p>{copy}</p></article>)}
        </div>
        <div className="sourceTruth"><div><span>当前产品决策</span><b>ADR 0009</b><small>产品是什么、为什么聚焦③④层</small></div><div><span>唯一实施顺序</span><b>multi-tenant-agent-task-service-roadmap.zh-CN.md</b><small>每阶段任务与退出条件</small></div><div><span>不可破坏基线</span><b>stage0-mvp-baseline.zh-CN.md</b><small>状态、事务、恢复与调度合同</small></div><div><span>项目入口</span><b>README.md</b><small>真实能力、当前进度与运行方式</small></div></div>
      </section>

      <section className="scopeSection"><div className="shell scopeGrid"><div><p className="sectionLabel">07 · SCOPE GUARDRAIL</p><h2>为了做深，明确不做什么</h2><p>暂停异构不等于删除可替换接口；保留多租户，因为它直接产生身份、Workspace、隔离、公平和审计的真实约束。</p></div><ul><li>不接第二 Agent Runtime，不建设 Adapter 市场</li><li>不做 Kubernetes、多节点与完整云平台</li><li>不扩张为通用 MCP / RAG / Memory / Workflow / Eval 平台</li><li>不做企业 SSO、复杂 RBAC、计费与组织管理</li><li>不做 MicroVM 与任意域名级网络策略</li><li>不自研推理引擎，不在无数据时深改 vLLM Scheduler</li></ul></div></section>

      <section className="finishPreview shell" id="finish-line"><p className="sectionLabel">08 · FINISH LINE</p><h2>最终不是“代码写完”，而是八项承诺被证据证明</h2><div className="finishGrid">{finishCriteria.map((criterion,index) => <div key={criterion}><b>{String(index+1).padStart(2,"0")}</b><span>{criterion}</span></div>)}</div><div className="demoScript"><span>最终代表性演示</span><p>Tenant A / B 创建同名 Workspace → GPU 繁忙触发 A1 → B1 → A2 公平推进 → 两个 Attempt 获得不同容器、目录与 Secret → 跨租户攻击全部失败 → kill B1 Sandbox → slot 与状态安全收敛 → 恢复不重复危险副作用 → 用户取得最终回答、代码 Diff 与 Artifact。</p></div></section>
      <footer><span>VRAM-Aware Agent Harness · Build Reference</span><span>当前规范：ADR 0009 · 多租户 Agent 任务服务路线图</span></footer>
    </main>
  );
}
