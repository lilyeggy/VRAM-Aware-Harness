# 已知问题逐条讲解（理解版）

> 配套 [known-issues.zh-CN.md](known-issues.zh-CN.md)：清单负责"是什么、证据、状态"，本文负责
> **"属于什么系统层面、真实场景里怎么发生、为什么面试官会问、怎么修"**。所有 file:line 均按
> 2026-09-09 代码现状重新核实（部分与清单首版的行号有漂移，以本文为准）。
>
> 每条按七步讲：**① 家族（哪个系统层面）→ ② 排除相似（它不是什么）→ ③ 真实时间线 →
> ④ 受害者视角症状 → ⑤ 心智模型（可迁移）→ ⑥ 同族排查雷达 → ⑦ 面试一句话**。
>
> 状态速览（2026-09-09）：27 条中 **5 条已修复**（A1、A3、C1、C2、C3）、**1 条系误判**（A2，
> 能力本已实现）、**1 条明确接受**（B10），其余 20 条 OPEN。状态以 known-issues 为准。

---

## 0. 总览地图（先看这张）

| # | 一句话 | 家族 | 状态 | 面试处理 |
|---|---|---|---|---|
| A1 | Worker 直通网关绕过记账/守卫/Checkpoint | 记账与恢复 | ✅ FIXED | **必讲透**（已修，最硬素材） |
| A2 | "多轮会话不可用" | 审计方法论 | 判定为误判 | **必讲**（审计反转案例） |
| A3 | LLM 网关不在 Agent 主流量上 | 观测/路由 | ✅ FIXED | 必讲透（已修） |
| B1 | `WAITING_TOOL` 是没有任何写入方的死状态 | 状态机 | OPEN | 主动坦白 |
| B2 | 登录时序侧信道 + scryptSync 阻塞事件循环 | 身份安全 | OPEN | 主动坦白 |
| B3 | 恢复续跑 prompt 硬编码一句话 | 恢复语义 | OPEN | 主动坦白 |
| B4 | 队列 TTL 只在 drain 时检查 | 调度兜底 | OPEN | 主动坦白 |
| B5 | claimNext 与重新入队之间崩溃 → 幽灵 QUEUED | 双写一致性 | OPEN | 主动坦白 |
| B6 | 客户端可自选 harnessSessionId → 会话抢注 | API 信任边界 | OPEN | 主动坦白 |
| B7 | 租户预算子系统整套代码未接入组合根 | 组合根装配 | OPEN | 主动坦白 |
| B8 | Secret 经 docker argv 注入，同用户可读 | 秘密通道 | OPEN | 讲威胁模型 |
| B9 | Worker 容器靠命名约定绑定 + 类型强转 | 跨进程契约 | OPEN | 主动坦白 |
| B10 | 同会话 Run 串行导致租户内队头阻塞 | 调度取舍 | WONTFIX | 主动讲取舍 |
| C1 | 测试数字 184/254/366 三处不一 | 文档一致性 | ✅ FIXED | 已修，带过 |
| C2 | 手册还在宣传已删除的 /observe 页 | 文档一致性 | ✅ FIXED | 已修，带过 |
| C3 | "实时流式"实为 1.6s 轮询 | 文档一致性 | ✅ FIXED | 已修，带过 |
| C4 | deploy 示例用 development+runc，runsc 缺席 | 部署故事 | OPEN | 主动坦白 |
| C5 | 工作区 87 项未提交改动 + 无关目录 | 仓库卫生 | OPEN | 演示前必须清 |
| D1–D9 | SQL 重复 / N+1 / 审计盲区 / #key 泄漏面等 | 代码卫生 | OPEN | 一句话带过 |

---

## 家族一：执行记账与恢复（支柱 0 × 支柱 1 的合龙处）

这一家族的共同问题：**工具执行的"账"（谁执行了什么、副作用是否已知）与"恢复"（崩了之后从哪继续）是同一份数据**。账记错、记漏或没接上，恢复模型就整体失灵。

### A1 · 默认生产路径旁路 ToolGateway（已修复——最硬的面试素材）

**① 家族**：横切关注点在进程边界上的丢失。工具记账、策略守卫、Checkpoint 都是"包在工具调用外面"的横切层；把 Agent 挪进子进程时，这层没有被跟着搬过去。

**② 不是什么**：不是 Worker 进程隔离本身错了（隔离是对的、该做）；也不是 Pi/模型侧的问题；更不是并发竞争——它是**装配错误**，每次执行都稳定地绕过，不崩、不报错、不丢数据，只是"账本从未翻开"。

**③ 时间线（修复前）**：
1. 用户提交 Run，配置默认 `workerIsolation: "process"`（`src/app/harness-config.ts:245-247`）；
2. Master fork Worker 子进程；`worker-main.ts` 里组装 PiAdapter 时，给它的工具网关是内联直通对象 `{ execute: (_i, invoke) => invoke() }`（修复前 `src/worker/worker-main.ts:149-150`）；
3. 此后每次工具调用：真实执行发生，但 `tool_executions` 不落库、策略守卫不跑、**Checkpoint 永不产生**，`getLastEventSequence` 还硬编码返回 0；
4. 某天 Worker 被杀（OOM、SIGKILL、机器重启）→ 启动恢复扫描查该 Run 的 Checkpoint → 得到 `NO_CHECKPOINT` → 只能判 `MANUAL_REVIEW`。

**④ 受害者视角症状**：平时一切正常（任务照常跑完）——这正是它"叙事级"的原因。故障那刻你宣传的两大支柱互相拆台：支柱 1（进程隔离）把爆炸半径缩小了，却把支柱 0（副作用感知恢复）在默认路径上整个拆掉了。面试官一句"process 模式下 checkpoint 是哪来的？"就问穿。

**⑤ 心智模型**：横切关注点不能靠"新入口记得重新装配"。要么由组合根统一注入（依赖注入的纪律），要么**fail-closed**——没有桥就拒绝运行，而不是给个假网关悄悄降级。

**⑥ 已落地的修复（"把 ToolGateway 沿 IPC 边界对折"，详见 known-issues §5）**：
- `ToolGateway` 拆成 `prepare()`（守卫断言 → 历史幂等判断 → 写 PREPARED 记账，返回 ALLOWED/REUSE/DENIED）与 `complete()`（SUCCEEDED+Checkpoint 原子落库，或 FAILED）两个阶段；in-process 场景 `execute()` 仍由二者组合，行为不变，352 个既有测试作安全网；
- Worker 侧通过 NDJSON 协议 v2 的四个 RPC 消息（`TOOL_PREPARE/COMPLETE_REQUEST/RESPONSE`）请 Master 代记账；**SQLite 仍然只有 Master 单写者**（否决了"Worker 直写 DB"，那会破坏单写者纪律）；
- Worker 侧新增 `src/worker/worker-tool-gateway.ts`：裁决 10s 超时 fail-closed；REUSE 直接复用缓存结果（跨进程幂等重放）；Master 断连时 `failAllPending`；
- **关键语义**：Worker 在 PREPARED 与 COMPLETE 之间被 SIGKILL → Master 留下 `PREPARED + UNKNOWN_EFFECT` 记账 → 恢复扫描 fail-closed（不自动重放 → MANUAL_REVIEW）。即**故障语义自动落进既有恢复模型**，进程隔离的崩溃变成了恢复模型的一个正常用例——这就是"支柱合龙"；
- 顺带修掉 `getLastEventSequence: () => 0` 硬编码（事件序号改由 Master 注入权威值）；
- 验证：362 pass（当时基线 352），含真实子进程 e2e：`tool_after_prepare` 故障注入下记账保留为 PREPARED、无 Checkpoint、`canAutomaticallyReplay=false`。

**⑦ 面试一句话**：「我把工具网关沿 IPC 边界对折成 prepare/complete 两相 RPC，让子进程的每次工具调用先在 Master 落 PREPARED 再执行；这样进程被杀时留下 PREPARED+UNKNOWN_EFFECT，恢复模型 fail-closed 转人工——隔离带来的爆炸半径被记账语义接住了。」

### B1 · `WAITING_TOOL` 是死状态

**① 家族**：状态机/数据模型一致性。**② 不是什么**：不是状态机转移规则写错（转移表本身自洽），也不是 UI 显示 bug——是**枚举值有定义、无生命周期**。

**③ 时间线**：状态枚举（`src/runs/agent-run.ts:22`）、状态机转移表（`src/runs/run-state-machine.ts:13-22`，RUNNING→WAITING_TOOL→RUNNING）、两套仪表盘 UI（"调用工具"标签）三处都认识 `WAITING_TOOL`；但全仓库 grep 不到任何把 Run 写成它的代码。设计意图是"工具执行期间"的状态，而工具执行发生在 ToolGateway 内部，没有回写 Run 状态的钩子。唯一消费方是恢复逻辑：`runstore.ts:247` 把 RUNNING/WAITING_TOOL 都当作"过期快照"转 INTERRUPTED（`:405` 的中断资格判断同理是读不是写）。

**④ 受害者视角**：工具执行期间 UI 永远显示"运行中"，用户分不清任务是在思考还是在调工具；恢复路径上 `WAITING_TOOL` 分支永远走不到，是没被验证过的死代码。

**⑤ 心智模型**：枚举值在存储/状态机/UI 三处存在 ≠ 有生命周期。死枚举是半成品功能预埋的地基——要么接上，要么删掉，留着就是"看起来支持其实没有"。

**⑥ 同族雷达**：审计时对每个状态枚举值问一句"谁写入它？谁读它？读写配对吗？"——`grep -rn "<STATE>" src | grep -v test` 三分钟就能查完。

**⑦ 面试一句话**：「`WAITING_TOOL` 是我状态机里的死状态——三处都有定义但无人写入，正确修法是 ToolGateway prepare 时置位、complete 时回 RUNNING，或者干脆删掉，我倾向后者，诚实。」

### B3 · 恢复续跑 prompt 硬编码

**① 家族**：恢复的语义层（机制恢复 vs 语义恢复）。**② 不是什么**：不是 Checkpoint 机制坏了（机制侧工作正常），是恢复后交给模型的那句话丢了语境。

**③ 时间线**：Worker 崩溃 → 恢复服务找到 Checkpoint（机制侧 ✅）→ `submitResume` 传给模型的续跑输入是硬编码字符串 `"请从恢复点继续完成任务"`（`src/checkpoints/recovery-executor.ts:81`、`src/scheduling/queued-run-recovery-service.ts:57`）→ 模型拿到的只有这句话，**没有原始用户任务、没有已完成工具的语义摘要** → 长任务恢复后只能"猜"要继续什么，输出跑偏或重复已完成工作。

**④ 受害者视角**：用户看到任务"自动恢复了"，但产出文不对题——比直接失败更糟，因为它看起来成功。

**⑤ 心智模型**：Checkpoint 保存的是**机制状态**（停在哪个工具调用边界），恢复 prompt 是**语义状态**（用户到底要什么）。机制恢复 ≠ 语义恢复，缺后者就是"手术室里接好了管线，忘了告诉医生手术方案"。

**⑥ 修复思路**：`continuationInput = 原始 userInput + 已完成工具调用摘要 + "从检查点 X 继续"`；已完成的工具靠既有 Checkpoint 数据就能生成，不用新采集。

**⑦ 面试一句话**：「我的恢复链路机制上闭环了，但续跑 prompt 是硬编码一句话，不带原始任务语境——语义恢复是下一步，数据都在 Checkpoint 里，差的只是组装。」

### B7 · 租户预算子系统未接线（与 A1 同族：有代码、没装配）

**① 家族**：组合根装配。**② 不是什么**：不是预算算法/账本实现有 bug（实现和测试都是全的），是生产对象图里根本没有它们。

**③ 时间线**：`tenant-budget.ts` / `resource-ledger.ts` / `BudgetAwareExecutionPolicy` 三件套有实现有测试；但组合根 `src/app/create-harness-application.ts:326` 只 `new DeterministicExecutionPolicy(...)` → 生产里 `TENANT_BUDGET_EXCEEDED` 是死代码，账本只在内存。完成度文档宣传"租户预算 ✅ 真机"的证据来自一次性脚本 `scripts/server-budget-control.ts`，不是常驻主路径。

**④ 受害者视角**：配置了租户预算也不会生效，超预算任务照跑；面试官若顺着你文档里的 ✅ 追问"生产哪个对象持有 BudgetAwarePolicy？"就露馅。

**⑤ 心智模型**：模块"存在且测试通过"≠"在生产对象图里"。A1（旁路）和 B7（未接线）是同一根因的两种表现——**装配点才决定什么真实发生**。

**⑥ 同族雷达**：审计组合根时列一张"模块 → 谁 new 它 → 谁持有它"清单；任何只有测试 import、没有组合根 import 的模块都是嫌疑。

**⑦ 面试一句话**：「预算子系统代码和测试都是全的，但我组合根只装了确定性策略——这是我最典型的'有实现没接线'，诚实边界我会自己说，而不是等人问。」

---

## 家族二：调度与并发（内存队列的边界）

这一家族的共同背景：**队列在内存、事实在 SQLite**，中间所有"先摘出再放回"的窗口都是风险。

### B4 · 队列 TTL 只在 drain 时检查

**① 家族**：兜底机制的触发模型。**② 不是什么**：不是 TTL 数值配错，也不是准入算法（admission）判断错——兜底逻辑本身对，错在**它的执行依赖别人先动**。

**③ 时间线**：`enforceQueueTtl`（`src/scheduling/run-queue-coordinator.ts:105`）注释写明"每次 drain 前扫描"；全文件唯一调用点在 `:316` 的 drain 路径里，**没有任何 timer**。时间线：队列里有个 Run 等了 11 分钟（超过 TTL）→ 但这 11 分钟里 pump 一次都没转起来（上游没有新提交触发 drain）→ 没人把它置 FAILED → "防永久饥饿熔断"承诺只在有流量时成立。附带问题：排队 `reasonCode` 只在内存，重启后用户看不到"我为什么在排队"。

**④ 受害者视角**：误导性最强的症状是**沉默**——超时的 Run 不报错、不失败，就静静挂着，直到下一次 drain 顺路检查才被熔断。

**⑤ 心智模型**：超时兜底必须**自驱动**（独立 timer/后台巡检），搭便车在主流程里的兜底不是兜底，是"顺路清扫"。

**⑥ 修复思路**：独立 `setInterval` 巡检 + `reasonCode` 落库（重启可复现排队原因）。工作量小，属于"半天修完"的。

**⑦ 面试一句话**：「我的排队 TTL 只在 drain 路径检查、没有独立 timer——有流量时熔断成立，队列静止时过期任务会一直挂；修法是自驱动巡检，这正是'兜底必须自己会跑'的教训。」

### B5 · TOCTOU 归档窗口（幽灵 QUEUED）

**① 家族**：内存态与持久化态的双写一致性。**② 不是什么**：不是死锁、不是调度优先级问题；是单线程 JS 里 `await` 之间依然存在的**崩溃窗口**——时间上从检查到使用（check-to-use）之间进程可以死掉。

**③ 时间线**：pump 的 `claimNext` 把 Run 从内存队列摘出（此刻 DB 仍是 QUEUED，内存里已没有它）→ 准入失败要 `release` + 重新入队，或执行要启动——**在这两步之间进程崩溃** → 重启后：内存队列没有它，DB 说它 QUEUED，而启动逻辑只把 RUNNING/WAITING_TOOL 的过期快照转 INTERRUPTED（`src/runs/runstore.ts:247`），**QUEUED 无人认领** → Run 永远"排队中"。

**④ 受害者视角**：任务永远显示"排队中"，没有任何错误、没有日志、不超时——三重误导。

**⑤ 心智模型**：内存队列是**缓存**，不是事实源；事实源永远是 DB。任何"内存已摘、DB 未定"的中间态，都必须有一条启动对账路径把它捞回来。

**⑥ 修复思路**：启动时扫描 DB 中 QUEUED 且不在内存队列的 Run，重新入队（幂等，天然可重试）。

**⑦ 面试一句话**：「claimNext 之后、重新入队之前有一个崩溃窗口，Run 会脱离内存队列但 DB 仍是 QUEUED——我的修法是启动对账：DB 里的 QUEUED 若不在内存队列就重新入队，因为内存是缓存、DB 才是事实源。」

### B6 · `harnessSessionId` 客户端可自选

**① 家族**：API 输入信任边界。**② 不是什么**：不是鉴权缺失（请求本身要过 principal），是**资源标识符的归属没有校验**。

**③ 时间线**：`submitRun` 接受 body 里的 `sessionId`/`harnessSessionId`（`src/http/harness-http-api.ts:436-438`），不校验这个会话属于谁 → 调度器把同会话 Run 串行化（`tenant-run-scheduler.ts:189-196`）→ 同租户攻击者复用别人的会话 id 提交任务：自己的 Run 排进对方长任务后面（队头阻塞 DoS），且对话流用 `conversation.id` 作 `harnessSessionId`（`:516`），续轮会打开同一 Pi 会话上下文 → 抢注/撞车。

**④ 受害者视角**：被撞用户的任务莫名排队变慢；若上下文续接，多轮对话的"记忆"里混进了别人的任务内容。

**⑤ 心智模型**：会话 id 是**资源地址**。客户端可自选地址 = 允许任何人把内容写进别人的地址空间。id 必须服务端签发；允许引用时必须校验归属（404 而非 403，防枚举）。

**⑥ 同族雷达**：所有接受客户端提供的"指向既有资源的 id"的端点，都问一句"归属校验在哪一层？"

**⑦ 面试一句话**：「会话 id 我允许客户端自选且没校验归属——同租户可以抢注会话造成队头阻塞和上下文串扰；修法是服务端签发 + 引用时归属校验，返回 404 防枚举。」

### B10 · 同会话串行 → 租户内队头阻塞（WONTFIX，设计选择）

**① 家族**：正确性与吞吐的取舍。**② 不是什么**：不是 bug——会话文件不能并发打开，串行化是正确性手段。

**③ 时间线**：租户 A 某会话有个 10 分钟长任务在跑 → 该会话后续所有消息被 `unshift` 回队头（`tenant-run-scheduler.ts:189-196`）→ 严格 FIFO 等待；`hasActiveSession` 是 O(活跃数) 线性扫描（`:233-238`），量大时可优化但量小无所谓。租户**之间**仍是 round-robin 公平，堵的只是同一会话。

**⑤ 心智模型**：凡"为正确性而串行化"的点，都要主动评估队头阻塞的范围（这里被限制在单会话内，可接受）并**主动讲出来**——被动被问穿和主动坦白是两个印象分。

**⑦ 面试一句话**：「同一会话强制串行是防止并发写会话文件的正确性要求，代价是会话内队头阻塞；我把阻塞范围限制在单会话、租户间仍公平，这是有意识的取舍。」

---

## 家族三：身份与密钥安全

### B2 · 登录时序侧信道 + scryptSync 阻塞事件循环（一行代码里藏着两个问题）

**① 家族**：认证安全（侧信道）+ 事件循环卫生（可用性）——同一行短路逻辑同时触发两类问题。

**② 不是什么**：不是密码哈希算法选错（scrypt 本身是对的），也不是 SQL 注入那类"越权"；它是**响应时间的可观测性**变成了信息通道，外加**同步 CPU 密集调用**占了事件循环。

**③ 时间线 A（枚举）**：攻击者 POST 登录 `unknown@x.com` + 任意密码 → `loginUser` 查库得 `row === null`，`||` 短路，`verifyPassword` 里的 `scryptSync` **根本不执行**（`src/auth/api-credential-store.ts:94`）→ ~5ms 返回。再试 `known@x.com` + 错密码 → 走满 `scryptSync`（`:132`，刻意慢，~100ms 量级）→ 响应明显更慢。测响应时间差，即知哪些邮箱注册过。
**时间线 B（阻塞）**：`scryptSync` 是同步 CPU 密集调用，直接跑在 Bun.serve 的单线程事件循环上（`:126/:132`）→ 哈希的 ~100ms 里**整个服务所有请求**都在排队 → 并发登录场景下登录接口成了 DoS 放大器。

**④ 受害者视角**：A 里的受害者是"邮箱被撞库确认存在"的用户；B 里的受害者是**所有用户**——登录高峰期全局变慢，且监控上只看到延迟毛刺，没有错误。

**⑤ 心智模型**：密码校验必须走**恒定时间路径**——用户不存在也要对假哈希跑一次真校验，让两条路径耗时不可区分。CPU 密集任务永不 `*Sync` 在请求路径上：用异步原语（`Bun.password`、node `crypto.scrypt` 回调版）。

**⑥ 修复思路**：① `row === null` 时对一个固定假哈希执行 `verifyPassword` 再返回 null；② `scryptSync` 换 `Bun.password(password, { algorithm: "scrypt", cost })`（异步，不阻塞事件循环）。两条合计 ~20 行。

**⑦ 面试一句话**：「登录接口我有个双料问题：未知邮箱短路跳过 scrypt 构成时序侧信道可枚举注册邮箱，scryptSync 又同步阻塞事件循环——修法是'假哈希走满恒定时间路径 + 换异步 scrypt'，两个问题一个函数里修完。」

### B8 · Secret 经 `docker run` argv 注入

**① 家族**：秘密传递通道。**② 不是什么**：不是 Secret 明文落库/落盘（没有持久化），也不是容器内进程能读宿主——威胁模型限定在**同宿主同用户**的进程。

**③ 时间线**：沙箱创建命令的参数里有 `__HARNESS_SECRET_X__` 占位符 → `withSecretValues` 在拼 docker 命令行时把占位符替换成真实值（`src/sandbox/container-sandbox-provider.ts:263-267`）→ 密钥值出现在 `docker run/exec` 的 argv 里 → 同宿主的同用户进程 `cat /proc/<docker-pid>/cmdline` 直接读走。容器**内**进程读不到（受 Docker 安全边界保护），所以这是宿主侧同用户威胁模型下的泄漏。

**④ 受害者视角**：误导点在于容器隔离做得很扎实（runsc、9 项攻击测试全过），容易让人以为密钥也安全——其实泄漏面在**宿主侧的 argv**，和容器隔离无关。

**⑤ 心智模型**：argv 是公开的（`/proc/*/cmdline` 对同用户可读）；env 不是加密但至少不进 cmdline。秘密过进程边界只有三条正道：环境变量、stdin、临时文件+立即删除——argv 永远不在其中。

**⑥ 修复思路**：`docker run -e NAME=value`（或 `--env-file` 从 mode-600 临时文件读入后即删）。

**⑦ 面试一句话**：「我的 Secret 走 docker argv，同用户进程读 /proc/cmdline 可见——容器内是隔离的，但宿主同用户侧漏；正确通道是 env 注入，这暴露了我对'进程边界'和'容器边界'没分开思考。」

### D3 · `GET /resources` 忽略租户身份（一句话版）

`requirePrincipal` 过了 scope 检查后，`void principal;` 把身份丢弃（`src/http/harness-http-api.ts:177-185`）→ 任意租户都能看**宿主机级** GPU 全局观测。心智模型：**鉴权通过 ≠ 数据不用按租户裁剪**；返回前再问一次"这份数据属于谁"。

### D5 · 平台仪表盘 `#key=` URL 片段（一句话版）

支持 `URL#key=...` 注入 API key：JS 读 fragment 存入 `sessionStorage` 后 `history.replaceState` 清理地址栏（`src/http/harness-platform-dashboard.ts:62`）。清理有做，但残留面仍在：sessionStorage 关标签才清、地址栏短暂可见（投屏/截图），replaceState 前崩溃则进历史。心智模型：**URL 会进历史/引荐来源/录屏三处，凭证永不过 URL**；正确做法是登录表单或一次性短期 ticket。

### D7 · logout 静默成功 + 无会话轮换（一句话版）

`revokeSession` 对无效 token 是无报错的 no-op（`api-credential-store.ts:103-106`），客户端无法区分"已登出"和"token 本来就是假的"；session token 不轮换、也没有"撤销全部会话"。修法：区分返回值 + 提供 revoke-all + 敏感操作后轮换 token。

---

## 家族四：沙箱与 Worker 进程

### B9 · 容器绑定靠命名约定 + 类型强转

**① 家族**：跨进程/跨组件契约的脆弱性。**② 不是什么**：不是沙箱逃逸（容器隔离边界无恙），是**两个进程对同一实体的映射方式**不牢。

**③ 时间线**：Worker 子进程组装自己的 `ContainerSandboxProvider`，注册容器映射靠字符串约定 `agent-harness-${sandboxId}`（`src/worker/worker-main.ts:114-132` 的 `containerMap?.set(...)`）；同时 `EphemeralSandboxStore` 经 `as unknown as SandboxStore` 强转塞进构造参数——类型系统被显式绕过。时间线上的风险：命名约定一旦改变（或未来多 Worker 并存出现命名冲突），sandboxId → 容器的映射就**静默错绑**——`docker exec` 会打进错误的容器，且没有任何报错。

**④ 受害者视角**：最阴险的形态是错绑不报错——任务"正常完成"，副作用落在了错误的工作区/容器里。

**⑤ 心智模型**：`as unknown as` 是类型系统里的"我知道我在撒谎"，每处强转都该配上"为什么这是安全的"证明，否则就是债。跨进程实体映射要么走**显式注册表**（Master 权威下发映射），要么走**带所有权的句柄**，不能靠命名约定这种隐式契约。

**⑥ 修复思路**：Master 在 spawn Worker 时把权威映射（sandboxId→containerName）随启动参数下发，Worker 不再自行推断；`EphemeralSandboxStore` 要么实现 `SandboxStore` 全接口，要么收窄为独立类型。

**⑦ 面试一句话**：「Worker 绑定容器靠 `agent-harness-${sandboxId}` 命名约定加一处类型强转——隐式契约在单 Worker 下成立，多 Worker 或改名即静默错绑；修法是 Master 把映射作为权威输入下发给 Worker。」

### D9 · 故障注入钩子编译进生产入口（一句话版）

`HARNESS_WORKER_SIMULATE` 故障注入（tool_roundtrip / tool_after_prepare 等）env 门控，编译在生产 worker 入口里。风险可控（默认关、env 名字生僻），但测试后门留主干是习惯债：构建期剔出或独立 dev-only 入口更干净。

---

## 家族五：一致性——文档与实现的漂移（含审计方法论）

这一家族的共同教训：**文档是一致性系统的一部分**。"声明—实现—证据"三处对不上，面试官抓到任意一处，就会怀疑其余全部。

### A2 · 审计误判案例（不是 bug，但这是最值得讲的反转）

**① 家族**：审计方法论本身。

**② 发生了什么**：2026-09-08 首轮审计把手册 §14 的"多轮会话 · 定稿设计 · **待实现**"当成代码现状，报为叙事级矛盾 A2（"每 Run 新建空白会话，多轮不可用"）。2026-09-09 以代码复核发现**该能力早已实现且有 e2e 测试**：`PiAdapter.start` 按 `runtimeSessionRef` 分支 create/open（`pi-adapter.ts:143-175`，会话文件跨 Run 持久保留）；`ManagedAgentRuntime` 在 agent_started/resumed 时把会话引用 `bindRuntimeSession` 落库；对话消息统一用 `conversation.id` 作 `harnessSessionId`；同会话 Run 被调度器串行化；测试证据在 `stage1-stage2-control-plane.e2e.test.ts:379`「连续对话」。真正过时的是**手册自己的"待实现"标注**。

**③ 为什么这反而是好素材**：它证明审计会犯错、且错误模式可命名——**把文档声明当成了代码现状**。已固化的流程修正：文档只作线索，结论必须落file:line + 测试证据（本清单 A3、C1–C3 均因此改写或修复）。

**④ 面试一句话**：「我审计时把自家手册的'待实现'当成了代码现状，复核才发现多轮会话早已实现、是文档过时——从此我的对账规则是：一切以代码和测试为准，文档只提供线索。」

### C1–C3（已修复，讲原则不逐条展开）

- **C1**：测试数 184/254/366 三处不一 → 同一事实三个说法。修法：统一为"以最近一次 `bun run test` 为准 + 日期快照"。
- **C2**：`/observe` 页已删，手册 §7 还在宣传，`harness-dashboard.ts` 成无路由死代码 → 修法：文档改口径为"运行级观测抽屉" + 删死代码。
- **C3**：README 写"实时流式输出"，实现是 1.6s 轮询持久化分片、全仓库无 SSE/WebSocket → 修法：**措辞诚实化**（"准实时输出（轮询，非 SSE 推送）"）而不是补功能——宣传词超出实现时，降措辞比升实现优先。

**家族共性心智模型**：面试官验证你诚实的最快方式就是抓文档与实现的偏差；**主动修措辞比被动补功能便宜，且同样得分**。

### C4 · deploy 示例沙箱是 development+runc（OPEN）

旗舰 runsc 在部署故事里缺席（`deploy/qwen38-harness.env.example` 自带 "explicitly development only" 注释）——真机 runsc 证据在安全报告里有，但**部署产物**指向弱配置。修法：示例切 runsc + 保留 runc 作 fallback 注释。面试讲隔离时注意口径："runsc 已真机验证"（有证据）而非"默认部署即 runsc"（暂无）。

### C5 · 工作区未提交改动（OPEN，演示前必须清）

当前 `git status` 有 87 项：A1/A3 修复的源码 + 文档 + `project-roadmap-atlas` 等无关目录的暂存删除。**现场演示或发仓库链接前必须整理提交**——未提交的修复恰恰说明修复没闭环。

---

## 家族六：代码卫生（D 级，一句话讲法）

| # | 一句话 | 修法 |
|---|---|---|
| D1 | `EvaluationAggregator.computeLlmCacheMetrics` 与 `llm-cache-metrics-store.ts` 的 SQL 逐字重复（`evaluation-aggregator.ts:373-405`） | 下沉到 store，聚合器只调查询 |
| D2 | eval 聚合 N+1 查询（`:193-210`） | 一次 JOIN/IN 批量取 |
| D4 | 审计只记 HTTP 鉴权事件（`resourceType` 恒为 HTTP_REQUEST）；interrupt/resume 无资源级审计；查询无分页；DENY 事件 tenantId 为 null（`harness-http-api.ts:632-660`） | 给 interrupt/resume 补资源级审计事件 + 分页 |
| D6 | 路径前缀检查硬编码 `"/"` 而非 `path.sep`（`workspace-service.ts:29`）——Windows 上行为不对 | 用 `path.sep`（跨平台习惯） |
| D8 | Checkpoint 归属校验只靠应用层（`recovery-service.ts:39-116`），数据库无 FK 兜底 | 补 FK（SQLite 支持延迟建索引） |

**家族共性**：单条都小，但同族聚集传达信号——"作者知道边界在哪、只是没来得及收口"，面试被问到时用**一句话承认 + 一句话修法**带过，不要展开防御。

---

## 家族七：观测与路由接线（A3——与 A1 同根因，层不同）

### A3 · LLM 网关不在 Agent 主流量上（已修复，2026-09-09）

**① 家族**：接线（部署配置层）+ 观测形态适配（能力层）双层问题。与 A1 同根因——**有实现没接线**——但层不同：A1 丢在进程内的对象装配层，A3 丢在部署配置层，且叠加一层"观测能力与真实流量形态脱节"。

**② 不是什么**：网关实现本身没有 bug（按逻辑模型路由、429/5xx/超时回退、熔断、前缀规范化都正常，30 个测试全绿）；也不是性能问题。是"路修好了车没开上去"+"车上没装计价器"。

**③ 时间线（bug 现场）**：
1. Pi（agent runtime）每次推理都要调模型；调谁由 models.json 的 `baseUrl` 决定——这是 Pi 的"模型通讯录"，主链路开关；
2. 修复前 `deploy/qwen38-vllm-models.json` 的 baseUrl 是 `127.0.0.1:18000`（vLLM 直连）→ 网关（13000）空转：RouteDecision、前缀指纹、活跃连接槽全部零数据；
3. 更隐蔽的第二层：即使把 baseUrl 指到网关，usage 采集也只认**非流式 JSON** 响应——而 Agent 推理几乎全是流式（SSE）→ `llm_cache_metrics` 台账照样基本为空（修复前仅 `llm-gateway.ts` 的非流式提取路径）；
4. 面试官问"Pi 的请求经过你的网关吗？"→ 叙事穿。

**④ 受害者症状（含误导）**：无任何报错；网关健康探测绿灯常亮——但心跳证明的是"活着"，不是"被使用"；`llm_cache_metrics` 空≠错误，监控不会叫。三重沉默。

**⑤ 心智模型**：计价器装在没人坐的出租车上，读数永远为零。观测必须挂在真实流量上；"绿灯"与"有流量经过"是两件事。

**⑥ 修复（known-issues §7）**：① 接线：models.json baseUrl 18000→13000 + `apiKey` 字段；② 专用低权限凭证：组合根幂等创建 `tenantId: "agent-runtime"`、仅 `models:generate` scope 的凭证（`create-harness-application.ts:217-219`），与人工 bootstrap key（`scopes: ["*"]`）分离——最小权限、可独立撤销、审计可归因；③ 流式 usage 采集：客户端未声明时注入 `stream_options: {include_usage: true}`（`llm-gateway.ts:122-130`，vLLM 据此在 SSE 末尾附 usage chunk），透传经 `TransformStream` 逐行**旁路扫描**（`:283-307`）——响应字节零改动，`LLM_STREAM_USAGE_CAPTURE=0` 可关；④ 验证：4 个新流式测试（含响应与上游逐字节一致），网关 30 全绿，全量 366。

**⑦ 面试一句话**：「我的网关最初是'建好但没接主路'：models.json 还直连 vLLM，且 Agent 流量几乎全是流式、我的 usage 采集只认非流式 JSON——指标台账恒为空。修复三件事：models.json 指到网关；给 Pi 发一把仅 models:generate 的专用租户钥匙；注入 include_usage 并用 TransformStream 旁路扫 SSE 末尾 usage chunk——字节零改动，观测故障不可能变成业务故障，还能一键关。」

**同族雷达**：① 每个独立组件问"生产流量的哪一段经过你"；② 每个指标问"真实流量形态（流式/并发/重试）下有数据吗"；③ 每个健康检查问"绿灯证明活着还是被使用"；④ 每个中间人问"你挂了业务会挂吗"（观测应旁路不挡路）；⑤ 每个替客户端改写请求的行为问"能一键关吗"。

**诚实边界**：真机 vLLM 端到端复验待补（当前证据止于 mock 上游测试）；RouteDecision 内存环形缓冲未持久化（重启即丢）。

---

## 附：同族排查雷达（下次代码审计先查什么）

1. **装配点**：组合根里 new 了哪些策略/模块？哪些模块只有测试 import？（A1、B7 的来源）
2. **兜底触发**：每个超时/清理/对账逻辑，是自驱动（timer/启动扫描）还是搭便车（在主流程里）？（B4、B5）
3. **死枚举**：每个状态值有写入方吗？读写配对吗？（B1）
4. **客户端输入指向**：哪些端点接受指向既有资源的 id？归属校验在哪？（B6）
5. **秘密通道**：秘密过每个进程边界时走 argv/env/stdin/文件 哪条？（B8）
6. **强转与命名约定**：每处 `as unknown as` 和字符串拼接出的跨进程标识，有权威来源吗？（B9）
7. **三处对账**：README / 手册 / 代码，同一事实的说法一致吗？（C1–C3）

## 附：面试优先级分层

- **必讲透（主动展开）**：A1（修复叙事最硬：拆相 → RPC → fail-closed 恢复语义）、A2（审计方法论反转）、A3（主流量接线 + 流式 usage 采集）。
- **主动坦白（被问前自己说）**：B2、B4、B5、B6、B7、C4、C5——每条用"一句话问题 + 一句话修法"。
- **讲取舍（不是错误）**：B10、B8 的威胁模型边界。
- **一句话带过**：D 级全部。

> 修复优先级建议（供下次动工参考）：① C5 工作区清理（演示前必须）→ ② B2（20 行修两个面试高危）→ ③ B4+B5（各半天，补齐调度叙事）→ ④ B3/B7（恢复语义与预算接线，增强"支柱 0"完整性）→ ⑤ 其余按需。
