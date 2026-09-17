# 执行层走查：从被允许到被收敛

本文只用一个主轴——**一条 Run 的时间轴**。从前往后读，永远只有一条线索。

前置四道门 → ① 资源就位 → ② 载体启动 → ③ 执行循环 → ④ 终态收敛

---

## 0. 怎么读这份文档

你在别处可能见过另外三种说法：master / worker / 容器、L0 到 L5、意图 → 声明 → 事实。它们**不是另外几套知识，是同一件事的不同切面**。就像描述一栋楼，可以按施工顺序说，也可以按楼层、按施工队、按验收标准说。

- **时间切法**（本文主线）：什么时候发生什么
- **角色切法**：这一段由谁做。master 掌权威、worker 掌执行、容器掌边界
- **关注点切法**：在隔离谁跟谁。L0 身份、L1 调度、L2 执行、L3 工具、L4 数据、L5 模型
- **规则切法**：每一步凭什么算数。举证三段式、两阶段裁决

每节末尾的「标注」一行，会告诉你这一节涉及哪个角色、属于哪一层、依据什么规则。**四套说法指向同一件事，不会互相冲突。**

---

## 第 0 段 · 前置四道门

四道门都在回答同一个问题：**这次执行凭什么被允许发生。**

在这一段里，一个容器都还没创建。

### 0.1 身份与归属

租户身份从 API 凭据里解析出来，**不是请求里的参数**。客户端无法通过改参数冒充别的租户。

这一步决定了后面所有东西的归属：工作区落在哪个目录、Secret 用哪个租户命名空间、算谁的预算、审计记到谁头上。

> 角色：master ｜ 层次：L0 ｜ 规则：—

### 0.2 能力对账 + 策略编译

两件事连着做：

**能力对账**（`validateRuntimeCapabilities`）：模板声明它需要哪些能力，运行时的能力档案里如果缺了强制项，这次 Run 直接 `REJECTED`，**不硬跑**。缺失的非关键能力会记成 `DEGRADED`，不影响执行但留痕。

**策略编译**（`compilePiPolicy`）：把五层策略取交集，编译成一份有效策略快照。五层是：

| 层 | 来源 | 内容 |
|---|---|---|
| platform | 平台级 | 全局底线；非 development 档强制 `allowNetwork: false` |
| tenant | 租户级 | 该租户的配额与限制 |
| template | 模板级 | 允许的工具、技能、模型 |
| workspace | 工作区级 | `workspaceRoots` 限定路径范围 |
| run | 单次 Run | 本次运行的资源上限 |

编译结果分三档落库：`APPLIED` / `DEGRADED` / `REJECTED`。

> 角色：master ｜ 层次：L1 ｜ 规则：—

### 0.3 准入占槽位

`instances.acquireRun(instance.id)`——占用实例的并发槽位。

这一步是整个执行层最值得讲的工程判断，代码注释写着「**顺序就是缺陷本体**」：

> 原来先创建沙箱、再 `acquireRun()`。当实例残留 `FAILED` 时 `acquireRun` 会抛异常，而这次抛异常发生在沙箱**已经创建之后**，回收沙箱的 `finally` 覆盖不到这条路径——于是每次失败的恢复都留下一个无人回收的容器。真机实测：活锁期间留下 2 个 `agent-harness-*` 容器。

修法：把占槽位挪到创建之前。**拿不到槽位就什么都不创建**（fail fast）。

对称的规则还有一条：沙箱创建失败时要立刻 `releaseRun` 归还槽位。否则会变成另一种泄漏——槽位占着、沙箱不存在、实例再也回不到 READY。一个泄漏的两个方向都堵上了。

> 角色：master ｜ 层次：L1 ｜ 规则：—

### 0.4 决定去哪执行：profile 路由

策略里的 `sandboxProfile` 决定这次落到哪个 Provider，**且拒绝降级**：

| profile | 落到哪 | 约束 |
|---|---|---|
| `development` | managed-local | 构造函数里就禁止非 development；不声明任何隔离 |
| `default` | 容器 + runsc | runtime 不是 runsc 直接抛错，不允许回退 runc |
| `restricted-egress` | 容器 + runsc | 未接 egress proxy 时 `allowNetwork` 为真即拒绝 |
| `strict` | microVM（Kata/Firecracker） | 默认实现直接抛错，不假装 runc 是 strict |

`strict` 那一格是刻意留空的：最坏的做法是降级到 runc 然后声称是 strict。

---

## 第 1 段 · 资源就位

**交接物：`sandboxId` + 运行时证据（沙箱已 ACTIVE）**

### 1.1 创建

`sandbox.create({ id, runId, instanceId, workspacePath, policy })`。两条路径：

- **热池命中**（`warmHit: true`）：直接租用一个预热好的容器，跳过 `docker run`
- **正常创建**：真的起一个容器

编译出的容器参数（`OciSandboxSpecCompiler`）是这层的硬边界：

```
--user 65532:65532          非 root，构造函数拒绝 userId <= 0
--read-only                 只读根文件系统
--cap-drop ALL              丢弃全部 capabilities
--security-opt no-new-privileges
--tmpfs /tmp:rw,noexec,nosuid,size=64m
--network none              非 development 档恒为 none
--pids-limit 128
```

两个刻意的"拒绝"：

- **`diskMiB` 不为 null 时直接抛错**。bind mount 根本无法强制磁盘配额，那就别假装支持。
- **`restricted-egress` + `allowNetwork` 为真时拒绝执行**。没有 egress proxy 就不直连公网。

### 1.2 举证（本节是全篇的重点）

配置声明 ≠ 运行时事实。写下 `--runtime runsc`，不代表跑的就是 runsc：可能没装、可能 daemon 静默回退。所以创建之后必须取证——`docker inspect --format {{.HostConfig.Runtime}}`，实测结果与请求的 runtime 一致才算数。不一致就**删掉容器并判 FAILED**。

这条链在 `isolation-triple.ts` 里固化成三元组：

```
意图  ──编译──►  声明  ──观测──►  事实
有效策略快照    SandboxSpec 指纹    runtimeEvidence
```

三段缺一段即判 `consistent: false`。还支持拿**同一份策略重新编译一次**的指纹来对撞——任何漂移都说明策略或编译器在中途被改动了。

顺带一个细节：spec 指纹的规范化序列化**刻意排除了 `workspacePath`**。因为指纹要反映的是隔离边界（策略 + profile + runtime），而不是这次运行恰好落在哪个目录。

> 角色：master ｜ 层次：L2 ｜ 规则：举证三段式

### 1.3 起跑

举证通过后 emit `sandbox_acquired` 事件（带上获取耗时、是否热池命中、runtime），然后 `startRunAttempt` 把 Attempt 从 `PENDING` 推到 `RUNNING` 并绑定 `sandboxId`。

注意顺序：**沙箱先建好，Attempt 才起跑**。不存在"Attempt 在跑但沙箱不存在"的状态。

---

## 第 2 段 · 载体启动

**交接物：执行信封**

### 2.1 组装执行信封

```
execution = { attemptId, policySnapshotId, sandboxId, sandboxEnforcement, runtimeConfig }
```

`sandboxEnforcement` 是关键——它是第 1 段那份"事实"的**摘要**（运行时探测出来的能力位），传下去供 worker 使用。**证据不是归档就完了，它要参与后续决策。**

### 2.2 执行总时长上限

`SupervisedAgentRuntime` 用 `Promise.race` 让三者竞速：运行结束 / 整体执行超时（`executionTimeoutMs`）/ 被强制终止。这是单次执行的**总时长硬上限**。

### 2.3 spawn 子进程

`Bun.spawn` 起 worker 进程，注入 `HARNESS_RUN_ID`，stdout/stdin 走 NDJSON。

同时挂一个 **15 秒握手看门狗**：迟迟收不到 `WORKER_READY` 就 SIGKILL 它、清理孤儿沙箱、直接判失败。

拿到 `WORKER_READY` 才下发 `START_RUN`。**"子进程起来了"和"可以开始跑了"是两件事。**

> 角色：master（→ worker）｜ 层次：L2 ｜ 规则：—

### 2.4 三个角色是平级的

容易被误解的一点：**容器不在 worker 里面。**

- master 通过 `SandboxProvider` 创建、举证、回收容器
- 容器由宿主上的 docker daemon 承载，是独立资源，PID 1 是 `tail -f /dev/null`
- worker 只有执行通道：拿 `sandboxId` 做 `docker exec`

`docker exec` 由 daemon 在容器命名空间里 fork 进程，所以工具进程的父进程在容器里，**不在 worker 里**。

一个反证：如果容器真在 worker 里，worker 一死容器就该消失，那孤儿回收、启动对账这些代码全都毫无意义。**这些代码存在本身就是"不包含"的证据。**

推论（后面会用到）：worker 被强杀后容器仍然存活，所以必须有孤儿回收与启动对账。

**为什么不干脆让 worker 也住进容器？** 因为容器禁网（`--network none` 是不让工具外带数据的核心不变量），而 worker 必须能连模型。两者互斥，只能让 worker 留在宿主、只把工具的执行地放进容器。

> 角色：master / worker / 容器 ｜ 层次：L2 ｜ 规则：—

---

## 第 3 段 · 执行循环

**交接物：每一笔工具裁决与两阶段记账**

这是整条链路里唯一会反复循环的部分（一次 Run 里可能有几十次工具调用），也是裁决最密集的地方。

### 3.1 worker 侧的启动与竞态防护

worker 拿到 `START_RUN` 后建 PiAdapter、订阅事件、进入 agent 循环。中断可能在任何时刻到达，所以设了 **4 个 Gate**：

- Gate 1：`START_RUN` 到达前就已中断 → 直接放弃
- Gate 2：异步 setup 期间被中断 → 放弃
- Gate 3：执行期间被中断 → **抑制 `RUN_COMPLETED`**，不许把中断报成完成
- Gate 4：异常路径被中断 → 抑制 `RUN_FAILED`，避免把中断报成失败

### 3.2 工具必须申请放行（本节是全篇的重点）

worker 里的 agent 生成了工具调用，但**它没有权限直接执行**。必须先向 master 申请裁决：

```
worker                          master
  │  TOOL_PREPARE_REQUEST  ────►  策略守卫判定
  │                               落 PREPARED 记账
  │                               Run → WAITING_TOOL
  │  ◄──── ALLOWED / DENIED / REUSE
  │
  ├─ DENIED：连容器都不碰，副作用根本不发生
  ├─ REUSE：幂等命中，直接复用既有结果
  └─ ALLOWED：才允许 docker exec 进容器
```

**放行必须在执行之前**：`DENIED` 的价值就是让副作用根本不发生。事后审计救不了一个已经被 `rm -rf` 的目录。

策略守卫（`PersistentToolPolicyGuard`）判三件事：

1. 工具名在 `allowedTools` 里吗
2. 是 `bash` 的话：`allowProcess` 为真吗？执行环境的能力位够吗（`networkPolicyEnforced` / `filesystemIsolation` / `processIsolation`）？**判据用的是运行时探测出来的能力位，不是配置里写的期望值**
3. 其它工具：路径在 `workspaceRoots` 内吗

判定结果无论允许还是拒绝都落一条 `recordToolDecision` 审计记录。

### 3.3 工具全部进容器

沙箱模式下，**7 个内置工具全都走容器**：`read / bash / edit / write / grep / find / ls` 都被改写成容器内的 `sh -lc`，连 `ls` 都进去。

为什么读类工具也要进？因为**路径白名单是应用层的字符串判断，bind mount 是内核级的视野限制**。把 `read` 留在宿主，你挡它的手段只有路径前缀比对；放进容器后，它的文件系统视野只剩 `/workspace` 加一个只读根。

配套一条硬规则（`pi-tool-gateway.ts`）：

```
边界声称 SANDBOX，但 sandboxId / executor 缺失 → 直接抛错，拒绝回退宿主机
```

这条比"工具进容器"本身更重要：它保证系统里**不存在**"宣称沙箱模式、实际在宿主跑"的降级路径。

### 3.4 副作用的两笔账

- `PREPARED`：放行前记一笔，表示"我授权了这件事"
- `COMPLETE`：执行后记一笔，记录实际结果

两笔之间的窗口，正是第 4 段会遇到的 `UNKNOWN_EFFECT` 的来源。

Run 状态在 `RUNNING ↔ WAITING_TOOL` 之间摆动：放行时进 `WAITING_TOOL`，落账后回 `RUNNING`。

> 角色：worker + master（+ 容器） ｜ 层次：L2 / L3 ｜ 规则：两阶段裁决

---

## 第 4 段 · 终态收敛

**交接物：Attempt 终态 + 沙箱回收 + 槽位归还**

### 4.1 Attempt 收敛

`invoke` 返回后：拿到终态标记就按标记走（`SUCCEEDED` / `FAILED` / `INTERRUPTED`），否则默认 `SUCCEEDED`。

`invoke` 抛错时：Attempt 先落 `FAILED`，再把错继续抛上去。

### 4.2 倒序清账

`finally` 里四步：

```
unsubscribe             解订阅
activeBySandboxId.delete  撤映射
sandbox.terminate       销毁沙箱
releaseRun              归还槽位（条件 activeRunCount > 0）
```

注意顺序与创建时**正好对称**：申请是"先占槽位、再建沙箱"，释放是"先销毁沙箱、再还槽位"。

方向相反是为了消灭"槽位已归还但沙箱还在"这个窗口。**这种对称性说明顺序不是随手写的。**

> 角色：master ｜ 层次：L2 ｜ 规则：举证三段式

---

## 三条异常路径

各有各的收敛方式，但共用同一条原则。

### E1 沙箱失联：资源反向驱动控制面

方向性最值得注意：不是控制面定期轮询沙箱活没活，而是容器执行时报错（匹配 `/no such container|container .* is not running|cannot exec in a stopped state/`）→ Provider 标记 `LOST` → 发出生命周期事件 → master 的 `onSandboxFailure` 做四件事：

1. 实例转 `FAILED`
2. Attempt 转 `INTERRUPTED`
3. 补发 `agent_interrupted` 事件
4. 主动去中断 worker

**坏消息从资源层往上冒，而不是从控制面往下探。**

### E2 执行超时：强制收敛

总时长到点后：先试优雅中断 → 宽限期内没退出就 `forceKill`（对支持强杀能力的 inner 执行 SIGKILL）→ **然后强制 `terminate` 沙箱**（释放挂起的 CPU / 内存与资源租约，防止僵尸进程）→ 抛 `RuntimeExecutionTimeoutError`。

中断是三级阶梯：协作式 `INTERRUPT_RUN` → 5 秒宽限 → `SIGTERM` → 2 秒 → `SIGKILL`。另有一条 `forceKill` 支柱跳过前两级直奔 `SIGKILL`。

### E3 工具执行中途崩溃：不猜

`PREPARED` 已落库，但 `COMPLETE` 永远等不到。此时**副作用到底发生没有，系统不知道**，所以它拒绝猜：

这笔按 `UNKNOWN_EFFECT` 处理 → 禁止自动重放 → 转人工核对 → 只给两条出路：

- 确认没发生 → 回 `QUEUED`，用 `/resume` 继续
- 确认已发生 → 直接 `FAILED`，不再假装还能恢复

背后的保守分类：`read / grep / find / ls` 归 `READ_ONLY`（可自动重放）；`bash / edit / write` 一律归 `UNKNOWN_EFFECT`（不可）。代码里有一条硬约束——**幂等语义必须由工具自己明确提供，不能靠工具名猜。**

Run 状态机也配合这个设计：`INTERRUPTED → QUEUED` 或 `INTERRUPTED → FAILED`，没有第三条路。另外 `QUEUED → FAILED` 用于排队 TTL 熔断，避免永久饥饿。

---

## 不在时间轴上的两件事

这两件事不属于某一条 Run 的生命期，**单独记，别往时间轴上塞**。

### A. 启动对账屏障（服务级）

服务重启时，上一个进程可能留下还活着的容器。所以启动时把所有 `PROVISIONING` / `ACTIVE` 的记录捞出来逐条清理，**然后才是调度器启动**。

清理失败的记录**故意保持 unsettled**、不标终态，并且抛错拒绝启动。标成终态等于允许下一次启动假装孤儿不存在——宁可起不来，也不带着孤儿跑。

### B. 热池的隔离代价

为了压冷启动做了容器热池，但有几条约束：

- 预热容器**只在没有任何授权 Secret 时**才允许被复用（`eligible = 无 secret`）
- 租用后改名，**单次使用不归还**
- 租期前先同步抢占再发 I/O，保证两个 Run 抢不到同一个
- 启动时按 label 清理所有遗留 warm 容器

**性能优化不能侵蚀隔离不变量**：一旦涉及密钥就直接放弃复用。

---

## 贯穿规则：举证三段式的三次实例化

这是把前面所有内容串起来的一条原则。**"意图 → 声明 → 事实"这个三段式在链路里出现了三次**，每次都换了一对"声明/事实"的对象：

| 层面 | 意图 | 声明 | 事实 |
|---|---|---|---|
| 沙箱层（第 1 段） | 有效策略快照 | SandboxSpec 与指纹 | 实测 runtime 证据 |
| 工具层（第 3 段） | 策略允许清单 | `PREPARED` 记账 | `COMPLETE` 记账 |
| Run 层（第 4 段） | 模板与 Run 请求 | Attempt 建立 | Attempt 终态 |

真正说明它是同一条原则的，是**三层的失败处理完全一致**：

- 沙箱层事实与声明不符 → 删掉容器，判 `FAILED`
- 工具层缺后半笔账 → 禁止自动重放，标 `UNKNOWN_EFFECT` 转人工
- Run 层异常退出 → 收敛为 `INTERRUPTED`，从不报 `SUCCEEDED`

三句话是同一句：**事实空缺的时候，不允许用乐观假设把空缺填上。**

这是整个项目里最值得讲的一句话。面试时如果只罗列具体的防御措施，听起来像一份清单；讲出这条原则再给三个不同层面的实例，听起来就是架构。

---

## 面试口径速查

**一句话讲清时间轴**：一次执行先经四道门被允许，然后建沙箱并取证、装信封起子进程、循环里逐笔裁决记账、收敛时倒序清账。

**两个不变量**：

1. 任何副作用都要在发生前后各记一笔账
2. 任何资源的获取与释放都要走相反的次序

**三个角色的分工**：master 造盒子，worker 用盒子，daemon 端着盒子。

**最有料的三个展开点**：

- 占槽位顺序（N19 顺序即正确性，有真机数据）
- 工具必须申请放行（放行必须在执行之前，否则拦不住副作用）
- 沙箱失联的反向驱动（坏消息从资源层往上冒）

**被追问时的诚实边界**：

- `default` 档是 gVisor 用户态内核，攻击面比 runc 小但不是零；`strict` 档 microVM 才是内核级边界，而**在没有 KVM 的环境里没有接入**，所以证据里标 `INFO` 而不是 `PASS`
- 如何证明隔离生效：三元组 + 指纹对撞 + `docker inspect` 实测，**不拿配置文件当证据**
- 为什么不直接上 microVM：单节点 + 需要快速启动 + gVisor 兼容性够用；microVM 的启动开销与运维复杂度在这个阶段不划算，所以留成 `strict` 的显式扩展点，而不是假装已实现

---

## 已知的一处偏差（建议自己核一眼）

在 container + worker 这条路径上，Secret 取值有一处不对称：

- 正常路径按租户命名空间寻址：`HARNESS_SECRET_<租户名十六进制>_<名字>`
- 但 worker 进程里的 secretProvider 写的是 `get: (_tenantId, name) => process.env[name] ?? null`——**租户参数被显式忽略，直接用裸名字读进程环境变量**。而 worker 是 `...process.env` 全量继承 master 环境起的。

所以在这条路径上，"租户命名空间"这道约束实际上没有生效。worker 一次只服务一个租户的 Run，跨租户混淆不会立刻发生，但它违背最小权限——worker 进程里可能带着与本次执行无关的凭据。

这是"隔离不变量在某条路径上没有贯通"的典型情况，与 spec 指纹那里的严谨正好形成对照。面试被问到 Secret 隔离时，这里要能答得上来。
