# 接入新的 Agent Harness：运行时适配契约

> 背景：平台定位是**宿主层**（准入 / 调度 / 隔离 / 溯源），agent loop 属于 runtime。
> 当前实现是 `PiAdapter`（Pi Agent SDK）；未来可能接入 DeepSeek Harness（dsh）、
> Claude Code、Codex CLI 或自研 loop。
> 本文记录"接入一个新 runtime 需要满足什么"，以及本次对 dsh 的调研结论。

## 1. 平台对 runtime 的唯一契约

代码位置：`src/runtime/agent-runtime.ts`

```ts
interface AgentRuntime {
  start(request: RuntimeStartRequest): Promise<void>;
  resume(request: RuntimeResumeRequest): Promise<void>;
  interrupt(runId: string): Promise<void>;
  subscribe(runId: string, handler: RuntimeEventHandler): () => void;
}
```

`RuntimeStartRequest` 会带上：
- `run`：runId / tenantId / harnessSessionId / workspacePath / thinkingLevel
- `input`：本轮用户输入
- `execution`：sandboxId、capability token、sandboxMountRoot、runtimeConfig（provider/model/tools/skills）

**平台不关心 runtime 内部怎么循环**，只要求它把过程变成标准事件。

## 2. 必须产出的事件（最小集）

| RuntimeEvent | 必要性 | 用途 |
|---|---|---|
| `agent_started` | 必须 | 建立 runtime session 引用 |
| `text_delta` | 必须 | 最终回答 / 流式输出 |
| `model_started` / `model_completed` | 必须 | **usage（token/cost）** → trace 成本归因 |
| `tool_started` / `tool_completed` / `tool_failed` | 必须 | 工具耗时、错误率、trace 时间线 |
| `thinking_delta` | 可选 | 推理过程展示 |
| `agent_completed` | 必须 | 判定 Run 终态（缺了 Run 会一直 RUNNING） |
| `agent_failed` | 必须 | 失败归因 |

事件约束：
- `toolCallId` 必须稳定，`tool_started` 与 `tool_completed` 才能配对；
- `modelCallId` 同理；
- `usage.cost` 缺失时**不要伪造**，trace 显示 null；
- 时间戳必须单调、可解析。

> 踩坑记录：我们早期实现过一个只 `await sleep` 但不发 `agent_completed` 的假 Runtime，
> 结果 Run 永远停在 RUNNING——`agent_completed` 是终态的唯一信号。

## 3. 六个隐藏耦合（接入检查清单）

| # | 耦合 | 要求 | 不满足的后果 |
|---|---|---|---|
| 1 | **工具治理** | 所有有副作用的工具必须经 `ToolGateway`（策略白名单、PREPARED 账本、副作用分类、幂等/重放） | 绕过副作用账本 = 丢掉项目最核心的恢复语义 |
| 2 | **会话恢复** | `runtimeSessionRef` 能 resume 同一会话；checkpoint 在工具边界保存 | 恢复退化成"重跑"，可能重复副作用 |
| 3 | **用量/成本** | 透出 provider usage（input/output/cache/cost） | trace 与每租户成本归因缺失 |
| 4 | **取消/超时** | 支持 `interrupt`；不支持时由 `SupervisedAgentRuntime` 强杀进程并回收沙箱 | 僵尸进程占槽、沙箱泄漏 |
| 5 | **MCP / 自定义工具** | 能注入平台提供的工具（MCP server） | 工具生态无法扩展 |
| 6 | **隔离假设** | runtime 必须跑在平台沙箱内（无网卡、工作区由平台挂载），不得自带网络/凭据 | 隔离边界被绕过 |

## 4. 接入步骤（新 runtime 的 checklist）

1. **调研**：确认上面 6 件事，尤其是"能否禁用 runtime 自带工具、只挂 MCP 工具"
2. **写 Adapter**：实现 4 个方法；spawn 子进程或走 SDK 协议
3. **事件映射表**：runtime 事件 → `RuntimeEvent`（逐条对照第 2 节）
4. **接工具治理**：MCP server 暴露 `ToolGateway` 工具；禁用内置 bash/file
5. **注册**：`src/app/create-harness-application.ts` 里按配置选择 runtime
6. **契约测试**：新 runtime 必须通过共享的 adapter 契约套件（见下）
7. **真机 smoke**：`scripts/p0-e2e-smoke.ts` + 一个真实任务

## 5. 建议补的"适配器契约测试"（尚未实现）

目前每个 adapter 各自有测试，但没有**共享契约套件**。建议新增
`tests/runtime/adapter-contract.test.ts`，用同一组断言跑所有 runtime：

- start → 收到 `agent_started` → 至少一条 `text_delta` → `agent_completed`
- 工具调用：`tool_started` 与 `tool_completed` 的 `toolCallId` 能配对
- usage：`model_completed` 带 token 字段（缺失则显式标记 unsupported）
- interrupt：调用后 run 在超时内进入终态
- 工具必须经过 `ToolGateway`（用 fake gateway 断言被调用）
- 不产生任何越界路径（workspace 外读写 → 拒绝）

这样"接新 harness"从"重写一遍再祈祷"变成"跑套件直到全绿"。

## 6. 本次调研：DeepSeek Harness（dsh）

结论：**暂不接入，继续用 Pi**；但记录下它的适配面，方便以后评估。

| 项 | 事实 |
|---|---|
| 版本 | `dsh` v0.1.5-rc.1（本地 `~/.local/bin/dsh`） |
| 编程入口 | `dsh --profile sdk`（JSON-RPC over stdio）、`--profile acp`、`--profile headless` |
| 协议 | `initialize` → `session/prompt`（返回 messageId）→ 流式 `session.event` / `session.status` |
| 限制 | **无 per-session close、无 prompt-cancel、无 per-prompt result** → 天然适合"每 Run 一个进程，取消=杀进程" |
| 插件 | `dsh-agent-loop`、`dsh-bash-sandbox`、`dsh-authorization`、MCP 支持、session controller |
| 风险 | RC 版本协议可能变；**自带 bash/file 工具会绕过我们的 ToolGateway** |

估算：完整接入 4–6 天（其中工具治理 2–3 天），弱化工具治理 2–3 天。
本次决策：**不接**，原因是我们已经有可用的 Pi 链路，且切换的主要成本在工具治理，
与"收尾"阶段的目标（稳定、可讲清）不一致。

## 7. 一句话总结

> 平台的可替换性由 **`AgentRuntime` 接口 + 事件契约 + 六个耦合检查表** 保证；
> 接入新 harness 的工作量 = 事件映射（小） + 工具治理与恢复语义（大）。
> 没有共享契约测试之前，"支持多 runtime"只是口号。
