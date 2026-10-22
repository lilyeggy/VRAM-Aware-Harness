# Step 级复用：把「Run 并发」和「模型调用并发」分开

> 问题：一个 Run 跑 5 分钟，但真正需要 GPU 的只有模型调用的那几百毫秒；
> 其余时间在等工具、等网络、等 IO。用"同时跑几个 Run"当并发上限，会把
> GPU 槽位浪费在等待上。
> 实现：`src/llm-gateway/concurrency-limiter.ts` + `LlmGateway.maxConcurrentRequests`

## 两层限制

```
准入（平台层）      HARNESS_MAX_ACTIVE_RUNS        ← 同时在飞的 Run 数
模型调用（推理边界）  LLM_MAX_CONCURRENT_REQUESTS    ← 同时打给推理服务的请求数
```

- Run 在飞 ≠ 模型调用在跑。Run 等工具/等审批时**不占模型槽**。
- 超过模型并发上限的请求在网关内 **FIFO 排队**，不会把压力直接打给推理服务。
- 排队等待可通过 `gateway.capacityStats()` 观测：`inflight / waiting / averageWaitMs / maxWaitMs`。

## 怎么开

1. 配置网关后端（把 Pi 的 provider 指向网关，或直接让 agent 通过网关调用）：
   ```bash
   LLM_BACKENDS=[{"id":"local","baseUrl":"http://127.0.0.1:8000/v1","model":"qwen3-1.7b","logicalModel":"qwen"}]
   LLM_MAX_CONCURRENT_REQUESTS=6
   ```
2. 放开 Run 并发（因为模型调用已经被网关限住）：
   ```bash
   HARNESS_MAX_ACTIVE_RUNS=30
   ```
3. 验证：10–20 个并发 Run 时，观察
   - `gateway.capacityStats().inflight` 不超过 6
   - `waiting` 会随压力上升
   - 工具执行期间模型槽可以释放给别的 Run

## 现状与边界（诚实说明）

- **这是 opt-in**：当前生产环境的 Pi 直连 provider，没有走网关，所以这一步尚未生效；
  需要把 Pi 的 provider `baseUrl` 指到网关（或在 worker 内注入网关地址）才算接通。
- 它解决的是「**我们发多了**」，不解决「**推理服务本身慢**」——后者只能换容量。
- 网关排队是进程内 FIFO，多实例部署时需要换成分布式信号量（或依赖推理服务的 429 + 重试）。

## 测试

- `tests/llm-gateway/concurrency-limiter.test.ts`：上限、FIFO、幂等释放
- `tests/llm-gateway/gateway-concurrency.test.ts`：10 个并发请求、上限 2，
  断言上游峰值并发 ≤ 2、全部成功、`capacityStats()` 正确
