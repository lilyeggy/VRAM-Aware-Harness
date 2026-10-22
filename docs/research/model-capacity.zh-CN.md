# 外部模型服务并发容量实测（能不能撑 10–20 人）

> 问题：10–20 人同时用，模型服务能不能保证**速度**和**质量**？
> 环境：172.17.43.193，provider `opencode-go`，模型 `deepseek-v4.1-flash`，2026-10-22
> 脚本：`scripts/model-capacity-probe.ts`（小请求容量）、`scripts/model-ttft-probe.ts`（2k prompt + 8 tools 的 TTFT）、`scripts/load-test-runs.ts`（端到端 N 并发）

## 结论（先看这个）

1. **当前外部服务撑不住 10–20 人并发。** 10 个并发 Run 全部成功，但单 Run 墙钟 **p50 75s / p95 155s**（单跑只要 4.7s）。
2. **瓶颈在 provider 的 TTFT（首字延迟），不在 Harness。** 一次 10 并发 Run 的事件时间线显示：`SESSION_INITIALIZED` → 首次 `MODEL_STARTED` 之间有 **69.6s**，而模型实际生成只用了 0.5s。
3. **安全并发约 2–3。** 带 tools schema 的真实 payload 下，c=3 时 TTFT p95 已到 4.3–5.8s；c≥5 波动到 10s+，c=10 出现过 41s。
4. **质量不受并发影响，但可靠性受影响。** 并发下偶发连接失败（`ConnectionRefused`）与超时；超时/重试会截断回答，看起来像"模型变笨了"。
5. **Harness 侧不需要改代码就能缓解**：`HARNESS_MAX_ACTIVE_RUNS` 本身就是模型并发闸门，把它调到 **4–6**，其余排队；但要给用户可见的排队等待（ETA），否则就是"悄悄等 70s"。

## 测量一：直连 provider（小请求，16 token 输出）

| 并发 | 成功率 | TTFT p50 | p95 |
|---|---|---|---|
| 1 | 2/2 | 1.3–3.0s | — |
| 5 | 10/10 | 2.0–3.0s | 4.4s |
| 10 | 20/20 | 1.4–1.5s | 2.3–3.8s |
| 20 | 40/40 | 1.5–2.7s | 2.0–6.0s |

小请求下 provider 能扛 20 并发，说明**不是硬性并发上限**。

## 测量二：贴近真实 agent 的首轮 payload（≈2k prompt + 8 tools schema，流式）

| 并发 | 成功率 | TTFT p50 | TTFT p95 |
|---|---|---|---|
| 1 | 1/1 | **3.4s** | — |
| 2 | 6/6 | 0.8–1.9s | **4.2–4.9s** |
| 3 | 9/9 | 2.6–4.1s | **4.3–5.8s** |
| 5 | 5/5 | 12.9s | 14.0s |
| 10 | 10/10 | 2.4s | **41.2s** |
| 20 | 20/20 | 4.0s | 8.7s |

同一并发下 p50 与 p95 差一个数量级，说明 provider 侧是**排队 + 调度抖动**，不是稳定扩容。

## 测量三：端到端（经 Harness，10 个真实 Run 并发）

```
RUNS=10  submitWall=117ms
STATUS {"COMPLETED":10}
RUN_WALL p50=75030ms p95=154733ms max=154733ms
TOKENS total=43876 avg=4388  COST total=$0.001597
UNACCOUNTED avg=68691ms/run
LOAD_OK
```

单条 Run 的事件时间线（同一批）：

```
RUN_STARTED        03:38:20.188
SANDBOX_ACQUIRED   03:38:20.233  (40ms, warmHit)
SESSION_INITIALIZED 03:38:22.026
MODEL_STARTED      03:39:31.617   ← 69.6s 空档（provider 排队）
MODEL_COMPLETED    03:39:32.142   (525ms)
RUN_COMPLETED      03:39:33.570
```

沙箱 40ms、工具 15ms、模型 0.5s —— **其余 70s 全在等 provider 的首字**。

## 这对"20 人并发"意味着什么

- 20 人同时点"开始"：以 c=2–3 的安全并发，后 17 个要排队；按单 Run 5s 算，尾部等待约 **30–40s**。
- 如果不限并发（现状 `maxActiveRuns=30`）：全部立刻发出去，每人 TTFT 可能 10–70s，**体验更差且不可预测**。
- 想要真正 20 并发低延迟，只有两条路：
  1. **换容量**：专用 vLLM / 更高档位（vLLM 的 continuous batching 对 20 并发是常规量级，取决于 GPU 与上下文长度）；
  2. **降并发 + 显式排队**：把 `maxActiveRuns` 设 4–6，配合排队位置/ETA，把"慢"变成"可预期"。

## 建议

| 优先级 | 动作 | 说明 |
|---|---|---|
| P0（已做） | `HARNESS_MAX_ACTIVE_RUNS` 默认 30 → **6** | 用调度器当模型并发闸门，避免 70s 级 TTFT |
| P0（已做） | 排队可见 | `GET /queue` 返回 `position` + `estimatedWaitMs`（按最近 15 分钟完成速率估算；样本 <3 时返回 null） |
| P1 | provider 429/超时可见 | 网关目前把 429/5xx 归为 retryable，但用户看不到"在被限流" |
| P1 | 专用模型端点 | 10–20 人并发的唯一可靠解；本地 vLLM + 连续批处理 |
| P2 | 首轮 prompt 瘦身 | tools schema 与系统提示直接影响 TTFT（2k prompt + 8 tools 时 c=1 就要 3.4s） |

## 复现

```bash
# 直连容量（小请求）
OPENCODE_API_KEY=... bun run scripts/model-capacity-probe.ts
# 真实 payload 的 TTFT（2k prompt + 8 tools）
OPENCODE_API_KEY=... bun run scripts/model-ttft-probe.ts
# 端到端 10 并发
HARNESS_BASE_URL=... HARNESS_REGISTRATION_INVITE_CODE=... LOAD_RUNS=10 bun run scripts/load-test-runs.ts
```

## 平台侧观测补充（同日）

trace 新增两个字段，把 `SESSION_INITIALIZED → 首次 MODEL_STARTED` 拆成两段：

| 字段 | 含义 | 归谁 |
|---|---|---|
| `requestAssemblyMs` | 会话就绪 → 请求真正发出 | **我们**（system prompt + tools + 历史序列化） |
| `upstreamTtftMs` | 请求发出 → 响应头到达 | **provider**（排队 + prefill） |

实现：`src/runtime/model-request-timing.ts` 旁路包装 `globalThis.fetch`，PiAdapter 在 `message_start` 时把两个时刻写进 `MODEL_STARTED` 事件；trace 聚合。

**真机首测（10 并发、闸门=6）**：

```
requestAssemblyMs=28      ← 我们组装 prompt/tools 只花 28ms
upstreamTtftMs=11069      ← provider 首字 11s
unaccountedMs=16099
wallMs=16317
```

结论：**"2.7s 空档"里我们只占 28ms，其余全是 provider**。payload 瘦身对总时延帮助有限（除非能减少轮次），真正的杠杆是并发闸门与推理侧容量。
