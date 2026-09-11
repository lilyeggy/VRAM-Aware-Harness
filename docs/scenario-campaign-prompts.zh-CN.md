# 可直接粘贴的任务提示词（第三批并行）

> 每个提示词都是**自包含**的：新对话没有本次上下文，所以环境、禁碰、判定口径、交付格式都写在里面。
> 计划全文见 `docs/scenario-campaign-split-plan.zh-CN.md`；场景定义见 `docs/full-scenario-test-guide.zh-CN.md`。

---

## ⚠️ 先看顺序（否则会把测量跑废）

| 顺序 | 谁 | 能不能现在开 |
| --- | --- | --- |
| 1 | **B2 浏览器**（提示词 A） | **现在就能开**，和正在跑的子智能体并行没问题（轻量交互） |
| 2 | **跑道 A 容量测量**（提示词 B） | **不能现在开**——要等 ① 发压器交付，且要等 B2 收工。A 是唯一负载源，和 B2 同时跑会互相污染 |
| 3 | **跑道 D 长稳**（提示词 C） | **要等 A 产出 λ\***，且开始时不得有别的负载 |

一句话：**同一时刻只能有一个负载源。** B2 是轻量交互，可以和功能类任务共存；A 和 D 必须独占。

---

## ⚠️ 另一个必须知道的边界：`managed-local` 档不能用 bash

已核实（代码 + 真机双向确认）：`src/policies/tool-policy-guard.ts` 对 `bash` 有硬门槛——当策略设了 `workspaceRoots` 但执行环境报不出 `filesystemIsolation=true` 时，直接 `DENY`（错误文案「执行环境无法隔离 Workspace，拒绝 bash」）。
- `managed-local-sandbox.ts:115` → `filesystemIsolation: false`
- `container-sandbox-provider.ts:203` → `filesystemIsolation: true`
- `sandbox-profile.ts:4` 的注释写明 development 档 **deliberately** 不是隔离档

**这是设计上的 fail-closed 安全边界，不是缺陷。** 但它的后果是：

| 档位 | bash | 能跑 | 不能跑 |
| --- | --- | --- | --- |
| `managed-local`（development） | **拒绝** | 读写文件类任务（T1/T2/T3/T6）、纯 UI 场景 | **一切需要 bash 的**：T4 运行测试、T7 多工具、T8 slow-job、R01/R04/R07、T10 的"跑失败测试" |
| `container`（runsc） | 允许 | 上面全部 | — |

所以：**跑道 A 和跑道 D 必须开 `container` 档**（它们的负载组合含 T4/T7/T8），B2 浏览器可以用 `managed-local`，一旦某场景需要 bash 再换 container。

**并且由此推出一条必须如实标注的结论：不存在"E1 且能用 bash"的档位。** `HARNESS_SANDBOX_PROVIDER` 只有 `container` / `managed-local` 两个取值（`src/app/harness-config.ts:116/154` 是二元判断），bash 被 fail-closed 绑定到 `container`，而 `container`+runsc 就属于 **E2**。所以**一切含 bash 的场景（T4/T7/T8/T10、R01/R04/R07）实际都是 E2，不能标 E1**——写证据时别把环境档标错。

**别忘了镜像**：容器档默认 `alpine:3.20` **没有 python**。跑 T4 这类"运行测试"的任务必须换成带解释器的镜像，否则会把"镜像缺依赖"误判成"模型失败"（指南 §3.4 明确点名这条）。

---

## 提示词 A —— 浏览器 UI 批次 B2（新对话，端口 13012）

```text
【任务】VRAM-Aware-Harness 浏览器 UI 批次 B2 测试。你是主智能体，**浏览器工作必须你自己做**——
browser-use 的 skill 明文规定 main-agent-only、不得派给子智能体；开始前先加载 browser-use:control-browser skill。

【环境】远端测试主机：ssh f630@100.65.162.35（用户 f630，已配密钥，用 -o BatchMode=yes）。
本地仓库 /Users/mac/Desktop/resume_proj/VRAM-Aware-Harness，里面有：
  docs/full-scenario-test-guide.zh-CN.md（场景定义 §7.1 / §8，判定口径 §4，证据格式 §10）
  docs/full-scenario-test-report-20260910.zh-CN.md（已跑结果与既有发现）
  docs/known-issues.zh-CN.md（已知缺陷清单）

【开实例】远端生成器已就绪：
  bash /home/f630/cxr/harness-deploy/provision-instance.sh ui-b2 13012 managed-local
  setsid nohup <实例目录>/start.sh >/dev/null 2>&1 &
  等 curl -s http://127.0.0.1:13012/ready 返回 {"ready":true}
  **managed-local 档下 bash 工具会被 fail-closed 拒绝（设计如此）**。本批场景大多只用读写文件类任务，够用；
  一旦某个场景需要执行命令（比如造"测试失败"），就改用 container 档重开实例，别把拒绝当成缺陷上报。
【关键】浏览器跑在**本地 Mac**，实例在**远端**，所以要开隧道才能访问：
  ssh -f -N -L 13012:127.0.0.1:13012 -o BatchMode=yes -o ExitOnForwardFailure=yes f630@100.65.162.35
  然后浏览器访问 http://127.0.0.1:13012/app  （登录页在 /app）
【会话数据】用你自己的独立租户（自己注册，例如 ui-b2@example.test），自己建 Workspace 与对话；
  **不要复用 ui-b1 的租户、Workspace 或对话**。

【要跑的场景】
  U06  失败任务 / 无 Checkpoint 的中断任务 / 安全可恢复任务：失败原因可读；恢复按钮与可恢复性一致；拒绝不得伪装成功
  U09  20 个标签页打开执行中/长历史对话：轮询压力下 UI 与 API 仍可用、无多重轮询泄漏
  U10  断网 30s / 120s 后恢复、慢网与乱序响应：错误可见、自动重新同步、不把旧状态当新状态、不补发重复任务
       （断网用页面级注入模拟，**不要停宿主网络**）
  U12  1440/768/390px 视口 + 键盘操作：主按钮、错误信息、结果入口可达，焦点与滚动正常
       **"Chrome 与另一浏览器"这半条环境不满足（只有内置浏览器 IAB 一个可用），如实标 BLOCKED，不要假装跑了**
  X07  模型输出中断 + 浏览器断网 + 回来取结果：不得拼接第二模型答案、不得把残缺输出当完整成功
       （输出中断用独立 SSE 掐断代理，**不要改共享 vLLM**）
  X02（页面部分）长会话 + 页面重连 + 后续修改：重连不丢任务、不重复提交、能看到已有输出与后续进度

【绝对禁碰】
  13000（共享 Harness）与 18000（共享 vLLM）——不重启、不改配置、不发压；**不要重启 dockerd**（会带走 22 个 polar-* 容器）；
  不碰其他 campaign-* 目录；禁止 pkill bun；禁止填满根盘（只剩 66G，大文件写 /home/f630/homePLUS）；
  不改 src/ 业务代码（需要改代码才能验证的就记最小复现）；不 git commit；凭证只留实例目录，不写进证据。

【已知坑，别重复踩】
  - N22（已登记）：切换对话时**迟到的轮询响应会覆盖当前页**，出现跨对话串扰（状态是 B、页面显示 A 的标题与消息）。
    你在 U06 / X02 里切对话时留意同样现象；复现就附证据，这是已知问题，不用重新定级。
  - N21（已登记）：行内代码里的下划线会被 Markdown 强调吃掉（`new_python_script.py` 显示成 newpythonscript.py）。
    看到渲染异常先对一下是不是这条。
  - 造"长输出"任务时模型常常只回一个循环而不是真的长文本。要输出真的长，提示词必须写死：
    "逐行输出 N 行，每行单独一行，不许用循环、缩写或省略"。

【判定口径】只用 PASS / FAIL / BLOCKED / INCONCLUSIVE / NOT_RUN / OUT_OF_SCOPE。
  **只看到 COMPLETED 不算通过**——必须看实际页面状态、output、产物；每条标注环境档 E0/E1/E2 与 REAL/SIMULATED。
  共享主机 load≈32、显存被 vLLM 预留 44G（但算力空闲）：延迟/吞吐数字不作结论，只取 pass/fail。

【收工核对】停自己的实例（按 PID 杀，禁止 pkill bun）、删自建沙箱容器，然后确认：
  curl http://127.0.0.1:13000/ready 仍为 {"ready":true}；docker ps | grep -c '^polar-' 仍为 22；dockerd PID 未变；df 根盘未被写满。

【交付】逐场景一行：场景 ID｜结果状态｜环境档与 REAL/SIMULATED｜关键证据（数字或事实）｜证据路径。
  最后附：未完成项与原因、以及任何新发现（最小复现 + 证据路径）。证据照指南 §10.1 建目录、§10.2 写每场景记录。
```

---

## 提示词 B —— 串行容量测量跑道 A（新对话，端口 13010）

```text
【任务】VRAM-Aware-Harness 串行容量测量（跑道 A）。
**这是全局唯一允许发持续负载的地方，必须严格串行、一次只跑一个档位。**

【开跑前必须确认两件事】
  1. 统一发压器是否已交付：另一个子智能体应在远端落地 scripts/campaign/load-driver.ts。
     先找它；**没交付就先只做空闲/预热采样，不要自己另起一套发压器**（会和它冲突），并告知用户进度。
  2. 确认此刻没有别的对话/子智能体在发负载（浏览器任务也算负载）。有的话等它们收工再开始。

【环境】远端测试主机：ssh f630@100.65.162.35（用户 f630，用 -o BatchMode=yes）。
本地仓库 /Users/mac/Desktop/resume_proj/VRAM-Aware-Harness：
  docs/full-scenario-test-guide.zh-CN.md —— §9 是本次任务的规范（§9.1 两种负载、§9.2 负载组合、§9.3 分阶段加压、§9.4 发压器约束、§9.5 停止条件与清理），
  §5.3 API 合同、§6.1 任务族 T1–T10 与外部验收、§4.4 体验目标门槛、§10 证据格式。

【开实例】**必须用 container 档**（负载组合含 T4/T7/T8，managed-local 会 fail-closed 拒绝 bash）：
  bash /home/f630/cxr/harness-deploy/provision-instance.sh serial 13010 container
  setsid nohup <实例目录>/start.sh >/dev/null 2>&1 &
  等 curl -s http://127.0.0.1:13010/ready 返回 {"ready":true}
  若要跑 T4「运行测试」，需要把 `HARNESS_CONTAINER_IMAGE` 换成**带 python 的镜像**（默认 alpine:3.20 没有 python，
  否则会把"镜像缺依赖"误判成"模型失败"）。

【步骤】（照指南 §9.3 分阶段）
  A1 单用户每族基线：T1/T2/T3/T4/T6/T7/T8 各 ≥10 个样本，重点族 ≥30；报 TTFT / E2E / 正确率
  A2 并发阶梯：C = 2/4/8/16/32（每档 ≥10min 且样本足够）；C=64 只在资源仍安全时才试；
     记录**第一次违反体验目标的并发档位**（拐点）
  A3 稳定吞吐：在满足目标的档位跑 ≥30min → 产出 λ*（单位 任务/s）。
     **这一步阻塞后续长稳跑道，优先做**
  A4 到达率阶梯（= 场景 Q12）：0.5 / 0.8 / 1.0 / 1.2 / 2.0 × λ*，每档 ≥10min、档间排空；
     看队列增长、拒绝/TTL、过载后的恢复能力
  A5 突发：1 秒内提交平时 5 倍任务量，3 轮、轮间排空
  A6 热点租户：A 占 80% 到达、其他租户均分 20%，≥20min（并入 X01「重载用户不拖垮正常用户」）

【硬性要求】
  - C 是**客户端在途任务数**，不是 Harness 的 activeRunCount，更不是 vLLM 的 running_requests——三者分别记录。
  - 到达率实验必须设**客户端**停止阈值与总时长；不要把客户端阈值写成"系统已有的队列上限/429 能力"。
  - 负向输入、故障注入、主动中断各开独立实验组，**不要混进正常基准**。
  - 单用户基线要先做，不能跳过直接上并发。

【停止条件】出现以下任一，立即停止新增压力并保留证据：
  跨租户泄露 / 不安全副作用重放 / DB 损坏 / 宿主资源逼近危险阈值 / 控制面持续失联 >60s /
  队列超过本轮预设上限 / 30s 内内存异常跃升且持续增长。

【绝对禁碰】13000（共享 Harness）与 18000（共享 vLLM）不重启不发压；不重启 dockerd（会带走 22 个 polar-* 容器）；
  不碰其他 campaign-* 目录；禁止 pkill bun；根盘只剩 66G——每 5 分钟看一次 df，接近阈值就停；
  不改 src/ 业务代码；不 git commit。

【判定口径】只用 PASS / FAIL / BLOCKED / INCONCLUSIVE / NOT_RUN / OUT_OF_SCOPE。
  每条标环境档 E0/E1/E2 与 REAL/SIMULATED。**本机是与他人共享的（load≈32、22 个 polar 评测容器），
  所以吞吐/延迟是"共享主机、含邻居负载"条件下的数值，报告里必须这样标注，不能当作独占容量承诺。**

【收工】停自己的实例（按 PID）、删自建沙箱容器、确认 13000/ready 仍 ready、22 个 polar-* 齐、dockerd PID 未变。
  清理顺序：停生产者 → 撤故障/代理 → 记录剩余任务 → API 中断残留 → 验证 Worker/容器/槽位 → 导证据 → 停服务。

【交付】容量曲线（并发档位 → 吞吐 / 尾延迟 / 拐点）+ λ* 数值 + **拐点首先出现在队列、模型、工具、SQLite 还是 UI**。
  附样本数与分母、未完成项、以及发现的问题（最小复现 + 证据路径，不要顺手改业务代码）。
```

---

## 提示词 C —— 跨会话长稳跑道 D（新对话，脱离会话运行）

```text
【任务】VRAM-Aware-Harness 跨会话长稳测试（跑道 D）。
**必须在跑道 A 产出 λ* 之后才开始**，且**开始时不得有任何其他负载源在跑**。

【开跑前必须确认】
  1. 跑道 A 已给出 λ* 数值（问用户或看 A 的交付）。
  2. 跑道 B2（浏览器）已收工，没有别的对话/子智能体在发负载。

【环境】远端测试主机：ssh f630@100.65.162.35（用户 f630，用 -o BatchMode=yes）。
本地仓库 /Users/mac/Desktop/resume_proj/VRAM-Aware-Harness：
  docs/full-scenario-test-guide.zh-CN.md §9.2 负载组合、§9.3 耐久阶段、§9.5 停止条件与清理、§10 证据格式
  docs/scenario-campaign-split-plan.zh-CN.md §6.7（本跑道定义）

【实例】**必须用 container 档**（R07/T8 依赖 bash，managed-local 会拒绝）。复用跑道 A 的 13010；若它已停，用
  bash /home/f630/cxr/harness-deploy/provision-instance.sh serial 13010 container
  重开。

【内容】
  §9 耐久：约 0.7λ* 正常负载 + 周期性插入峰值，按 2h → 8h → 24h 递进
  G12：2/8/24h 混合负载，包含大量历史查询、eval、Artifact 下载
  X09：业务日长稳 + 负载波峰 + 夜间静默
  R07：T8 持续 30 / 60min。**执行超时必须设到 75min，单工具超时单独核实**——
       用默认 30min 配置去期望 60min 成功是错的，那不算通过

【启动方式】必须脱离会话，否则会话结束即断：
  setsid nohup <driver 或脚本> ... > <log> 2>&1 &

【采样】每 5s 写资源/网关摘要；每 30–60s 写进程与磁盘（Master/Worker RSS、FD、容器数、SQLite/WAL 大小）；故障前后提高频率。
  证据目录照指南 §10.1；**大文件写 /home/f630/homePLUS**，不要写只剩 66G 的根盘。

【磁盘红线】每 5 分钟 df 一次。Artifact/DB 增长接近阈值就停止并保留证据（这是本机最紧的资源）。

【停止条件】跨租户泄露 / 不安全重放 / DB 损坏 / 宿主资源逼近危险阈值 / 控制面失联 >60s / 队列超预设上限 /
  30s 内内存异常跃升且持续增长。

【诚实标注（最重要）】本会话内跑不完的档位一律写 **NOT_RUN**，不要把"跑了一半"当成结论。
  初筛门槛：预热后空闲窗口 Master RSS/FD/存活 Worker 无持续爬升，RSS 增幅 ≤ 20%，超出要解释缓存与回收。

【绝对禁碰】13000 / 18000 不重启不发压；不重启 dockerd（会带走 22 个 polar-* 容器）；不碰其他 campaign-* 目录；
  禁止 pkill bun；不改 src/ 业务代码；不 git commit。

【收工】停生产者 → 撤故障/代理 → 记录残留任务 → API 中断 → 验证 Worker/容器/槽位 → 导证据 → 停服务；
  再确认 13000/ready 仍 ready、22 个 polar-* 齐、dockerd PID 未变。

【交付】长稳资源曲线（内存/FD/磁盘/尾延迟趋势）+ 各档位是否跑完（跑不完写 NOT_RUN）+ 未完成项 + 新发现。
```
