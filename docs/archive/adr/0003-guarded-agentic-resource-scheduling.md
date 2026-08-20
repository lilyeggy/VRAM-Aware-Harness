# ADR 0003：演进到受硬约束保护的 Agentic 资源调度

## 状态

已接受为候选研究路线；是否启动由 ADR 0006 规定的基线证据决定

## 背景

第一周 MVP 计划由 `ResourceObserver` 采集 GPU 事实，再由固定阈值的
`ExecutionPolicy` 决定新 `AgentRun` 启动或排队。这个方案可预测、可测试，
也能在模型不可用时工作，但只能表达开发者预先编码的少量场景。

真实资源决策还可能依赖：

- 当前 GPU 状态及其时间趋势；
- 活跃 Run、排队时长和预计工作量；
- Tenant 配额、优先级与 SLO；
- 历史 OOM、延迟和吞吐结果；
- 可选模型、上下文长度和工具阶段。

Scheduling Agent 可以综合这些信息提出更有上下文的决策。不过，让 LLM
独占准入控制会引入不确定输出、决策延迟和循环依赖：当承载 Agent 的 GPU
已经过载时，调度 Agent 本身也可能无法运行。

## 决策

如果真实基线证明确定性策略遗漏了有价值、且可由任务语义解释的场景，候选方向是
**Guarded Agentic Scheduling**，并且只能按以下阶段演进：

1. **Deterministic Baseline**：第一周 MVP 使用配置化规则，建立安全回退和实验基线。
2. **Agent Shadow Mode**：Scheduling Agent 读取相同的 `AdmissionContext` 并给出建议，但不控制真实调度。
3. **Offline Evaluation**：比较规则决策、Agent 建议和真实结果，验证收益。
4. **Guarded Control**：只有通过 `PolicyValidator` 和硬约束校验的 Agent 建议才能执行；否则使用确定性回退。

观测层只提供事实，不做判断：

```text
ResourceObserver + RunStore + Queue + Tenant/SLO
                         ↓
                  AdmissionContext
```

Scheduling Agent 输出结构化建议：

```text
action: START | QUEUE | DEFER
reason
confidence
validUntil
evidenceRefs
```

最终决定必须经过不可由 Agent 修改的硬约束：

- 观测数据过期或采集失败时不得假设资源充足；
- 绝对显存安全线、全局并发上限和 Tenant 硬配额不可突破；
- 不因资源压力粗暴终止正在执行的工具；
- Agent 超时、不可用、低置信度或输出不合法时回退到确定性策略；
- 若 Scheduling Agent 与工作负载共享同一 GPU，过载时不得依赖它完成安全决策。

每次决策都要持久化：

- 使用的策略类型和版本；
- `AdmissionContext` 或其不可变引用；
- Agent 建议、置信度和理由；
- Guardrail/Validator 的校验结果；
- 最终执行的决定和回退原因。

## 不选择的方案

### 在没有基线数据时预先承诺永久固定阈值或 Agentic Policy

两者都不预先选择。固定策略先作为安全基线和回退；若真实结果证明资源趋势、
任务特征、SLO 或历史结果能够显著改善决策，再按本 ADR 评估 Agentic Policy。

### 让 LLM 独占资源准入控制

不选择。LLM 可能不可用、超时或输出不一致，也可能与被调度工作负载争用同一 GPU；
生产安全边界不能依赖一次自由文本推理。

## 后果

好处：

- 保留可预测的安全底线，同时允许 Agent 做上下文感知优化；
- 可以用 Shadow Mode 量化 Agent 是否真的优于规则；
- 所有建议、否决和回退均可解释、可审计；
- `ExecutionPolicy` 接口可替换，当前 MVP 不需要返工。

限制：

- 需要定义稳定的 `AdmissionContext` 和结构化输出协议；
- 需要额外的决策延迟、模型成本和可用性预算；
- 需要防止提示注入、过期观测和不可信工具数据影响调度；
- 在完成基线和评估前，不能宣称 Agentic Policy 优于确定性策略。

## 评价指标

- OOM 与资源安全线违规率；
- Run 吞吐量和 GPU 利用率；
- 平均、P95 排队时间与端到端延迟；
- Tenant 公平性与 SLO 违规率；
- Agent 建议被 Guardrail 否决或回退的比例；
- 决策延迟、模型成本和可用性。
