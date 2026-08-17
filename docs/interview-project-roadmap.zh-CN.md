# 多租户 VRAM-Aware Agent Harness：秋招面试项目路线图

> **历史路线，不是当前产品入口。** 本文由 ADR 0009 取代。它保留了真实实验和
> 可复现交付要求，但把面试目的误当成产品定位，并把真实 Sandbox 延后。当前路线见
> [多租户 Agent 任务服务路线图](multi-tenant-agent-task-service-roadmap.zh-CN.md)。

> 决策日期：2026-08-12  
> 上位决策：[ADR 0008](adr/0008-focus-on-single-node-multi-tenant-interview-project.md)  
> 文档性质：历史面试交付路线

## 1. 项目目标

秋招前交付一个可以在五分钟内演示、在三十分钟技术追问中讲深的系统项目：

> **面向单机共享 GPU 环境的多租户、资源感知、可恢复 Agent Harness。**

当前部署组合固定为 Pi + 自托管 vLLM + 单机 NVIDIA GPU。项目不重新实现 Agent
Loop，也不建设通用多 Runtime 平台；它解决多个 Tenant 共享有限推理资源时的任务
公平性、资源背压、工具副作用、崩溃恢复和执行审计。

## 2. 面试主叙事

项目必须围绕四个相互连接的系统问题展开：

1. **多租户公平调度**：Tenant 内 FIFO、Tenant 间 round-robin，全局与单 Tenant
   并发上限共同防止资源垄断和永久饥饿；
2. **资源感知准入与背压**：vLLM Metrics、GPU 状态和 slot 真正改变
   `START / QUEUE`，资源恢复后自动推进；
3. **副作用感知的安全恢复**：工具意图先持久化，根据只读、幂等写和未知副作用
   判断复用、重放或人工处理，不能把 Agent 失败简单等价为重试；
4. **策略与审计**：Tenant 有效策略进入 Pi、ToolGateway 和 Sandbox，资源快照、
   决策、Attempt、工具和恢复事实形成可查询时间线。

资源过滤只是其中一个环节，不能单独作为项目亮点。

## 3. 保留与暂停的范围

| 范围 | 决策 | 原因 |
| --- | --- | --- |
| Tenant 归属、公平队列、并发限制 | 核心保留 | 让共享 GPU 的资源竞争问题成立 |
| Run/Attempt、事件、事务 | 核心保留 | 支撑生命周期、一致性与审计 |
| ToolGateway、Checkpoint、Recovery | 核心保留 | Agent Infra 最有辨识度的可靠性问题 |
| GPU/vLLM Observer、Admission、slot | 核心保留 | 形成真实资源反馈闭环 |
| Effective Policy、Template | 保留 | 证明 Tenant 差异进入执行路径 |
| Instance、Capability、Sandbox | 最小保留 | 作为部署能力、执行环境和安全边界，不继续平台化 |
| Claude Adapter、第二 Runtime | 暂停 | 不能优先补足当前证据缺口 |
| 异构 ResourcePool | 暂停 | 当前只对单机 GPU/vLLM 作真实承诺 |
| PostgreSQL、多 Worker、Kubernetes | 秋招后 | 属于生产化演进，不是当前演示必要条件 |
| UI、RAG、Memory、Multi-Agent | 不做 | 会稀释可靠执行主线 |

## 4. 代表性演示

最终演示必须覆盖同一条真实应用链：

```text
Tenant A 提交 A1、A2；Tenant B 提交 B1
  → GPU/vLLM 处于 CRITICAL，三个 Run 持久化排队
  → 资源恢复为 NORMAL
  → 受限并发下按 A1 → B1 → A2 公平推进
  → A1 完成工具调用并保存结果与 Checkpoint
  → 注入 Harness/Runtime 中断
  → 重启后重建 Run 和队列，恢复任务重新经过资源准入
  → 已完成工具结果被复用，不重复产生副作用
  → 不确定写副作用进入 MANUAL_REVIEW
  → API 输出资源、策略、Attempt、工具与恢复时间线
```

演示通过不仅要求任务最终完成，还必须证明：

- Tenant B 没有被 Tenant A 的连续任务永久压后；
- `CRITICAL` 时没有绕过准入启动 Runtime；
- 重启后 slot、队列和 Run 状态没有泄漏；
- 已提交工具副作用没有重复执行；
- 无法证明安全的写操作没有被自动重放；
- 每个关键决定都有持久化理由和证据。

## 5. 秋招前实施顺序

### P0：冻结可信仓库基线

任务：

- 审查并整理当前修改、删除和未跟踪文件；
- 明确根项目与独立 explorer 项目的边界；
- 保留一个清晰 README、一张架构图和一键验收入口；
- 增加 CI，执行顶层测试、TypeScript 检查和 Fake 演示；
- 在用户确认后形成能够追溯的基线提交。

退出条件：新环境按 README 能安装、测试并运行 Fake 演示；仓库首页不再以异构
Runtime 作为当前承诺。

### P0：真实 A6000 基线

使用固定任务比较直接 Pi → vLLM 与 Harness → Pi → vLLM，至少记录：

- 成功/失败/超时数量；
- 端到端、排队和执行 p50/p95；
- Harness 增加的绝对与相对开销；
- input/output token、吞吐与峰值并发；
- GPU 显存、利用率、vLLM running/waiting 和 KV cache；
- 重复工具执行次数。

退出条件：仓库中存在原始结果、运行配置、汇总表和诚实结论；没有数据时不声明
Harness 提升性能或 GPU 利用率。

### P0：多租户故障演示

在现有 Day 7 Fake 闭环基础上补齐代表性演示，优先使用真实 Pi；无法稳定自动注入的
外部故障可以保留确定性 Fake 对照，但必须区分真实证据与模拟证据。

至少注入：

- 资源从 `CRITICAL` 恢复到 `NORMAL`；
- Runtime 启动失败；
- Agent 执行中断或进程重启；
- 已成功工具结果后的恢复；
- `PREPARED + UNKNOWN_EFFECT` 工具恢复。

退出条件：一个命令生成结果摘要和完整审计证据，演示总时长适合面试现场。

### P1：小型 Benchmark 与结果页

建立 20–30 个固定任务，覆盖无工具、只读工具、多步工具、失败恢复和危险写操作。
输出机器可读结果及 Markdown 汇总，至少包含：

- task/tool success rate；
- queue、execution、end-to-end latency；
- trajectory 长度和 token usage；
- 自动恢复、人工处理和失败的数量；
- 重复副作用次数；
- Tenant 启动顺序和最大等待时间。

这不是论文 Benchmark，不追求大规模或统计显著性；目的是让简历中的数字可复查。

### P1：面试交付

- 三分钟录屏：问题、架构、演示、指标、限制；
- 一页架构图：提交、调度、Runtime、工具、恢复、审计；
- 一份项目追问清单：事务边界、exactly-once、slot 竞态、公平性、fail closed、
  SQLite 限制和生产化方案；
- 简历描述只写已经有证据支持的规模和结果。

## 6. 暂停条件

秋招前不因以下事项阻塞交付：

- 第二 Runtime；
- 通用 ResourcePool；
- 容器编排或多节点部署；
- 管理 UI；
- Agentic Scheduling、KV Residency 和深度 vLLM Scheduler 修改。

只有真实实验明确暴露当前实现无法解决的瓶颈时，才能提升其中某项优先级，并记录
新的 ADR 或实验决策。

## 7. 完成定义

项目在秋招前完成，必须同时满足：

1. 一个命令可以运行确定性测试和多租户恢复演示；
2. A6000 上有真实 Pi/vLLM 数据，而不是只有 Fake Runtime；
3. Demo 同时证明公平调度、资源背压和副作用安全恢复；
4. README 明确区分当前保证、逻辑隔离和生产化非目标；
5. 面试者可以用持久化证据解释任一 Run 为什么排队、启动、拒绝或恢复；
6. 仓库结构、提交记录和结果文件允许第三方复现核心结论。

## 8. 秋招后的可选演进

如果面试项目已经完成，可按岗位方向二选一，不默认全部实施：

- **Agent 平台方向**：第二 Runtime、真实容器 Sandbox、Trace/Eval、成本治理；
- **AI Infra 方向**：PostgreSQL lease、多 Worker、Kubernetes/Ray、vLLM 请求归因和
  有数据支撑的调度优化。

历史异构控制面方案保留在
[`heterogeneous-harness-control-plane-roadmap.zh-CN.md`](heterogeneous-harness-control-plane-roadmap.zh-CN.md)，
但不再代表当前实施顺序。
