# VRAM-Aware Harness 任务放行与调度策略技术白皮书

> **文档定位**：本文档详细解构 `VRAM-Aware-Harness` 的任务放行（Admission）、资源感知（Observation）与调度编排（Scheduling）核心策略，完整呈现系统如何在单机、多租户、有限显存条件下做出严密的 `START`（放行）与 `QUEUE`（排队）决策。

---

## 一、 核心架构全景：三道防线放行流水线

当用户或 API 提交一个 Agent 任务（Run）时，系统绝不盲目拉起容器，而是依次经过 **调度队列、资源分类、确定性策略** 三道硬核门禁：

```
                [ 客户端提交 Run ]
                        │
                        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ 第一道门禁：调度队列治理 (TenantRunScheduler)                │
 │ 1. 会话串行化拦截：同 Session 运行中则排队                   │
 │ 2. 租户公平队列：租户内严格 FIFO，租户间 Round-Robin 全局轮转  │
 │ 3. 老化插队补偿：等待超 agingMs 优先提权，杜绝饿死           │
 └──────────────────────────────┬──────────────────────────────┘
                                │ (出队候选任务)
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ 第二道门禁：底层资源事实观测与分类 (ResourceClassifier)     │
 │ 1. 采集 vLLM Prometheus: kvCacheUsagePercent, 请求排队数    │
 │ 2. 采集 nvidia-smi: 物理显存已用比例                         │
 │ 3. 【核心创新 N5】: 扣除同机 vLLM 90% 稳态基线，度量真实增量 │
 │ 4. 分类评级: NORMAL / BUSY / CRITICAL / UNKNOWN            │
 └──────────────────────────────┬──────────────────────────────┘
                                │ (输入状态上下文)
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ 第三道门禁：确定性准入决策 (DeterministicExecutionPolicy)    │
 │ 综合判断：资源等级 + 全局并发上限 + 租户并发占用             │
 │                                                             │
 │   [ START 放行 ]   ➔ 拉取预热沙箱，执行任务                  │
 │   [ QUEUE 排队 ]   ➔ 回退队列，记录决策台账，等待下一轮唤醒   │
 └─────────────────────────────────────────────────────────────┘
```

---

## 二、 第一道门禁：调度器层队列与并发治理

代码实现位置：[`src/scheduling/tenant-run-scheduler.ts`](file:///Users/mac/Desktop/resume_proj/VRAM-Aware-Harness/src/scheduling/tenant-run-scheduler.ts)

### 1. 会话串行化（Session Serialization）
* **规则**：属于同一个会话（Session）的多个任务必须严格串行执行。
* **原因**：Agent 对话上下文具有因果依赖性，并发执行会导致对话历史和文件工作区产生读写冲突。若检测到同 Session 已有任务处于 `ACTIVE`，后续任务直接判定为 `SESSION_SERIALIZATION` 并挂起排队。

### 2. 租户两级公平排队模型
* **租户内部（Intra-Tenant）**：严格实行 **FIFO（先进先出）** 顺序；
* **租户之间（Inter-Tenant）**：通过维护一个**全局租户环（Round-Robin Ring）**进行轮询调度。
* **业务价值**：防止“大租户一口气提交 100 个任务把并发全占满，导致小租户的一个简单任务饿死数小时”。

### 3. 老化插队补偿机制（Aging Policy，N10）
* **痛点**：若某个活跃租户不断追加短任务，排在后面的冷门租户即使轮转也可能遭遇较大延迟。
* **规则**：当某个租户队首任务等待时间超过 `schedulerAgingMs`（如 60 秒），该任务获得**最高调度优先级（插队）**，保障了系统的最长等待时延上界。

### 4. 排队超时安全熔断（Queue TTL）
* 在 [`src/scheduling/run-scheduler.ts`](file:///Users/mac/Desktop/resume_proj/VRAM-Aware-Harness/src/scheduling/run-scheduler.ts) 中配置了 `queueTtlMs`。
* 若显存长期爆满导致任务在队列中停留超时，系统主动将其状态机流转为 `FAILED(QUEUE_TIMEOUT)`，杜绝无休止的悬挂死等。

---

## 三、 第二道门禁：vLLM/GPU 资源事实观测与分类

代码实现位置：[`src/resources/vllm-resource-observer.ts`](file:///Users/mac/Desktop/resume_proj/VRAM-Aware-Harness/src/resources/vllm-resource-observer.ts) 与 [`resource-classifier.ts`](file:///Users/mac/Desktop/resume_proj/VRAM-Aware-Harness/src/resources/resource-classifier.ts)

### 1. 采集的核心指标
调度器通过 HTTP 高频拉取 vLLM 的 `/metrics` 接口和 `nvidia-smi` 命令：
* `kvCacheUsagePercent`：**KV Cache 显存块占用率**（大模型推理最核心的压力瓶颈）；
* `runningRequests`：vLLM 当前正在并发解码的请求数；
* `waitingRequests`：vLLM 内部排队等待分配 KV Cache 的请求数；
* `gpuUsedMemoryMiB / gpuTotalMemoryMiB`：物理 GPU 显存占用。

### 2. 关键工程突破：vLLM 稳态基线扣除算法（N5 机制）
* **行业真实痛点**：
  * vLLM 启动时默认带有 `--gpu-memory-utilization 0.9` 参数，**启动第一秒就会直接霸占物理显存的 90%**（其中绝大部分是空的 KV Cache 缓冲池）；
  * 如果调度器直接去查 `已用显存比例`，系统看到的永远是“显存已用 90%”，会**永久判定为 CRITICAL 严重过载**，导致哪怕 1 个字的简单任务都被永久拒绝排队！
* **我们的创新解法（增量压力换算）**：
  * 引入 `gpuMemoryBaselinePercent`（如 90%），调度器只度量**基线之上的动态压力**：
    $$\text{adjustedPercent} = \frac{\text{usedPercent} - \text{baseline}}{100 - \text{baseline}} \times 100$$
  * 处于基线内属于推理引擎的正常预分配稳态；只有当真实显存或 KV Cache 超过基线向上攀升时，才被计入压力。

### 3. 四级资源压力分类与精确阈值（ResourcePressure）
系统按照**“短板效应（悲观原则）”**进行综合判定：只要任一指标触及 CRITICAL 即判定为 CRITICAL；否则任一指标触及 BUSY 即判定为 BUSY。

代码默认配置阈值（[`src/app/harness-config.ts:268-280`](file:///Users/mac/Desktop/resume_proj/VRAM-Aware-Harness/src/app/harness-config.ts#L268-L280)）：

| 监测核心指标 | 正常区间 (NORMAL) | 繁忙门限 (BUSY) | 严重过载门限 (CRITICAL) | 环境变量配置项 |
| :--- | :---: | :---: | :---: | :--- |
| **1. KV Cache 占用率** (`kvCacheUsagePercent`) | **`< 60%`** | **`>= 60%`** | **`>= 85%`** | `HARNESS_BUSY_KV_CACHE_PERCENT`<br>`HARNESS_CRITICAL_KV_CACHE_PERCENT` |
| **2. GPU 显存增量压力** (`gpuMemoryPressurePercent`)<br>*(扣除 90% 稳态基线后的增量)* | **`< 70%`** | **`>= 70%`** | **`>= 90%`** | `HARNESS_BUSY_GPU_MEMORY_PERCENT`<br>`HARNESS_CRITICAL_GPU_MEMORY_PERCENT` |
| **3. vLLM 正在解码请求数** (`runningRequests`) | **`< 4 个`** | **`>= 4 个`** | **`>= 8 个`** | `HARNESS_BUSY_RUNNING_REQUESTS`<br>`HARNESS_CRITICAL_RUNNING_REQUESTS` |
| **4. vLLM 排队等待请求数** (`waitingRequests`) | **`0 个`** | **`>= 1 个`** | **`>= 4 个`** | `HARNESS_BUSY_WAITING_REQUESTS`<br>`HARNESS_CRITICAL_WAITING_REQUESTS` |
| **5. 观测失败 / 无可用信号** | - | - | **`UNKNOWN`** | (触发 Fail-Closed 强制排队) |


---

## 四、 第三道门禁：确定性准入决策矩阵（Decision Matrix）

代码实现位置：[`src/resources/execution-policy.ts`](file:///Users/mac/Desktop/resume_proj/VRAM-Aware-Harness/src/resources/execution-policy.ts)

这是系统决定任务到底是 **`START`（放行）** 还是 **`QUEUE`（排队）** 的核心大脑：

| 资源压力等级 | 全局在跑任务数 (activeRunCount) | 当前租户在跑任务数 (activeTenantRunCount) | 决策动作 (Action) | 原因码 (ReasonCode) | 架构意图与保护策略 |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **`CRITICAL`** | 任意 | 任意 | **`QUEUE`** | `RESOURCE_CRITICAL` | **强制过载保护**：推理后端濒临 OOM，严禁任何新任务进入！ |
| **`UNKNOWN`** | 任意 | 任意 | **`QUEUE`** | `RESOURCE_UNKNOWN` | **安全断路（Fail-closed）**：未获得客观证据前不盲目放行。 |
| **`BUSY`** | `>= maxActiveRuns` | 任意 | **`QUEUE`** | `GLOBAL_CONCURRENCY_LIMIT` | 触达全局静态硬配额上限。 |
| **`BUSY`** | `< maxActiveRuns` | `> 0`（该租户已有任务在跑） | **`QUEUE`** | `RESOURCE_BUSY_TENANT_LIMIT` | **降级防霸占**：系统繁忙时，每个租户最多只允许 1 个任务并发！ |
| **`BUSY`** | `< maxActiveRuns` | `= 0`（该租户当前无任务） | **`START`** | `RESOURCE_BUSY_TENANT_AVAILABLE` | 繁忙时依然保障每个租户享有保底 1 个执行槽位。 |
| **`NORMAL`** | `>= maxActiveRuns` | 任意 | **`QUEUE`** | `GLOBAL_CONCURRENCY_LIMIT` | 资源健康，但达到系统配置的全局并发上限。 |
| **`NORMAL`** | `< maxActiveRuns` | 满足租户配额 | **`START`** | `RESOURCE_NORMAL` | **完全健康**：绿灯放行，立即从预热池取沙箱启动任务。 |

---

## 五、 决策台账与状态唤醒闭环

1. **决策完全可解释与审计（PolicyDecisionStore）**：
   * 每一次不管是 `START` 还是 `QUEUE`，都会生成一条不可篡改的 `PolicyDecision` 记录存入 SQLite；
   * 记录包含：决策时刻、选定的动作、原因码、当时的瞬时显存值、KV Cache 占比快照。为什么放行、为什么排队，完全有据可查。
2. **事件驱动的排队泵（QueuePump & Recovery）**：
   * 当一个在跑的任务执行完毕，释放沙箱和模型连接时，系统会自动触发 `QueuePump`；
   * 调度器重新对队列中的候选任务执行“资源探测 $\rightarrow$ 决策评估”，若此时显存回落为 `NORMAL`，则顺位放行下一个任务。

---

## 六、 90秒面试实战：如何向面试官介绍“放行策略”？

如果面试官追问：**“你们的任务放行策略到底是怎么设计的？”**

直接用以下这段话进行专业回答：

> “我们的任务放行策略是一个**三层漏斗模型（Three-Stage Admission Gate）**：
>
> 1. **第一层是多租户队列编排**：同一 Session 严格串行化，租户内部严格 FIFO，租户之间通过全局环实行 Round-Robin 公平轮转，并带有超时熔断（Queue TTL）和老化插队补偿机制；
> 2. **第二层是 vLLM 显存增量观测**：我们通过 Prometheus 采集 vLLM 的 **KV-Cache 占用率** 和排队请求数。针对 vLLM 默认预分配 90% 显存的特性，我们设计了**稳态基线扣除算法**，专门度量基线之上的真实动态压力，将健康度精准分类为 `NORMAL`、`BUSY`、`CRITICAL`；
> 3. **第三层是确定性准入决策矩阵**：
>    * `CRITICAL` 或探测失败直接强制排队，**物理防范显存 OOM 导致推理引擎雪崩**；
>    * `BUSY` 状态下实施**降级收缩**：单租户并发上限自动压低至 1 个，优先保障无任务租户的最低可用性；
>    * 仅在 `NORMAL` 且未突破全局配额时，才放行（`START`）拉起沙箱执行。
> 
> 每次决策都会落地一条包含瞬时资源快照的**可解释决策台账**，实现了资源调度与推理底座的安全闭环。”
