# Run 分步时间线（trace）与一次真机发现

> 接口：`GET /runs/:id/trace`（`tasks:read`，租户内可见）
> 实现：`src/runs/run-trace.ts`（纯只读聚合，不写任何状态）
> 数据源：既有 RunEvent 流（`MODEL_*` / `TOOL_*` / `SANDBOX_ACQUIRED` / `CONTROL_PREPARED` / `SESSION_INITIALIZED` / 生命周期事件）

## 返回什么

```json
{
  "runId": "...",
  "status": "COMPLETED",
  "steps": [
    { "kind": "sandbox", "name": "SANDBOX_ACQUIRED", "durationMs": 92, "detail": { "warmHit": true } },
    { "kind": "model", "name": "deepseek-v4.1-flash", "durationMs": 115,
      "detail": { "inputTokens": 2274, "outputTokens": 46, "costTotal": 0.0003 } },
    { "kind": "tool", "name": "bash", "durationMs": 30 },
    { "kind": "lifecycle", "name": "RUN_COMPLETED" }
  ],
  "totals": {
    "wallMs": 4689, "queueWaitMs": 2, "sandboxMs": 92, "modelMs": 116,
    "toolMs": 30, "lifecycleMs": 8, "unaccountedMs": 4443,
    "modelCalls": 2, "toolCalls": 1, "totalTokens": 4368,
    "cacheReadTokens": 2048, "costTotal": 0.000375
  }
}
```

`unaccountedMs = wallMs − sandboxMs − modelMs − toolMs − lifecycleMs`。
**这个数大，说明有性能问题还没被观测到。**

## 一次真机运行（172.17.43.193，opencode-go）

```
wallMs=4689  queueWait=2  sandbox=92  model=116  tool=30  lifecycle=8
unaccountedMs=4443（95%）
steps: RUN_STARTED → CONTROL_PREPARED(2ms) → SANDBOX_ACQUIRED(92ms)
       → SESSION_INITIALIZED(6ms) → model(115ms) → tool bash(30ms)
       → model(1ms) → RUN_COMPLETED
```

时间线把 4.7 秒拆开后，立刻暴露两个未被归因的空档（用事件时间戳可直接定位）：

| 空档 | 位置 | 约 |
|---|---|---|
| A | `SESSION_INITIALIZED` → 首次 `MODEL_STARTED` | **~2.7s**（Pi 会话初始化 / 工具注册 / 首轮 prompt 组装） |
| B | `TOOL_COMPLETED` → 下一次 `MODEL_STARTED` | **~1.2s**（工具结果回填 / 下一轮准备） |

也就是说：**沙箱 + 模型 + 工具只占 5%，95% 的墙钟在 Agent Runtime 内部**。
这是下一步优化的入口（Pi 会话复用、工具注册缓存、首轮预组装），而不是继续调调度器。

## 设计取舍

- **只读聚合**：不新增事件类型、不改状态机，任何历史 Run 都能立刻出 trace。
- **配对靠 ID**：`MODEL_STARTED/COMPLETED` 用 `modelCallId`、`TOOL_STARTED/COMPLETED|FAILED` 用 `toolCallId`；没有配对的事件标 `pending`，用来定位"卡在哪一步"。
- **成本归因**：直接取 provider 返回的 `usage.cost.total`，不自行定价。
- **不做的**：不导出 OpenTelemetry、不做跨 Run 聚合、不做 trace 存储——数据本来就在事件流里，按需聚合即可。
