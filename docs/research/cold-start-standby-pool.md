# 隐藏沙箱冷启动：预热池 / 待机 / fork 运行中 VM 的业界做法与我们的取舍

> 范围：回答"平台怎样用**预热池 (warm pool) / 待机 (standby, suspend) / fork 运行中 VM** 把沙箱冷启动从用户路径上藏掉"，并落到我们的真机约束。
> 我们的约束：单机 192 vCPU / 251GB RAM / 两块 3.5TB NVMe；每 Run 一台 Firecracker **v1.17.0**（jailer），**guest 内核 4.14.174**，guest 内存 256MB，workspace 128MB，rootfs 256MB；宿主 Ubuntu 22.04 / 内核 6.8.0；`/data` 为 ext4（无 reflink）；快照池 `/data/harness/snapshots-mt/<templateHash>/{vm.snap,mem.snap}`；实验室十几人，并发 2–10。
> 标注约定：**[已验证]** = 官方文档/上游源码/真机实测直接读到；**[第三方]** = 厂商博客/第三方评测，未独立复现；**[推测]** = 基于上述事实的推断，需实测。
> 配套文档：本仓库 `docs/research/cold-start-snapshot-cost.md`（讲怎么把 make-snapshot 0.9s 打下来、diff/tmpfs/UFFD/压缩），本文不重复其结论，只引用其编号。

---

## 0. 结论速览（TL;DR）

1. **我们已经拥有业界"藏冷启动"方案里最贵的那半**：黄金快照热恢复 median **101.3ms / p95 129.6ms**，`/snapshot/load` 本身只有 4~7ms。业界待机池（Fly 几百 ms、Modal p50 1.05s、CodeSandbox avg 400ms）都**比我们慢**。**[已验证：真机实测]**
2. 因此**我们真正缺的不是"更快的恢复"，而是"池里永远有匹配的快照"**。唯一会让用户付 1334ms 的场景是：池空 / 模板或 agent 升级后第一次 / 池被 GC 删掉而预热还没补上。**[推测，见 §5.3 的 GC 竞态]**
3. 业界四种形态（§2）：**(A) 预热池**（Daytona / Cloud Run min-instances / Modal `min_containers`）、**(B) 待机快照**（Fly suspend / Blaxel standby / E2B pause）、**(C) 发布期重建**（AWS SnapStart 每次 publish 建快照 / Codespaces prebuilds 每次 push 更新）、**(D) fork 运行中 VM**（CodeSandbox / E2B fork / Morph Infinibranch）。我们已有的"黄金快照 + 开机/每小时预热"= **A 的轻量版 + C 的一半**。
4. **fork 运行中 VM 对我们不可行也不划算**：需要宿主 5.19+ 的 userfaultfd 共享内存写保护（宿主 6.8 满足），但 **guest 4.14 不消费 VMGenID**（≥5.18 才有），重复恢复会复制熵/唯一 ID；且相比"同一黄金快照多次热恢复"它能省下的只有一次性 make-snapshot 成本。**定为过度设计。**（§4）
5. 最划算的排序见 **§7**：① 把"池永不缺失"闭环补全（含修 GC TTL 竞态）→ ② 驱逐策略改为"当前 templateHash 永久保留 + 旧版本留 N-1" → ③ 真机有余量时再上 K=1~2 台常驻 running standby VM（把 101ms 再压到 5~20ms） → ④ 把 make-snapshot 移出关键路径（`sync_snapshot_files:false` + 首次 Diff + tmpfs，见配套文档 §5/§6）。
6. **过度设计**：自研 userfaultfd fork、内存压缩惰性解压、多副本/跨机池、按用户预热池、池大小 >2~3、独立预热守护进程与复杂水位控制。

---

## 1. 我们的基线（真机实测，作为对比锚点）

| 指标 | 数值 | 备注 |
|---|---|---|
| 冷启动端到端（无快照） | **1334ms**（guest 用户态就绪 1281 + 宿主 53） | 唯一会让用户"感觉到"的路径 |
| 冷启动 + 制作快照 | **2254~2416ms**（make-snapshot 908~918ms） | 只在池空/模板变化时发生 |
| 黄金快照热恢复 | **median 101.3ms / p95 129.6ms** | `/snapshot/load` 本身 4~7ms |
| N=10 热恢复总墙钟 | **206~222ms** | 同一 `mem.snap` 被 `MAP_PRIVATE` 映射，page cache 天然共享 |
| 已有预热 | `scripts/vm-snapshot-prewarm.ts` + `deploy/harness-vm-prewarm.timer.example`（`OnBootSec=20s`、`OnCalendar=hourly`，oneshot，幂等：`hasSnapshot(templateHash)` 命中即 `VM_PREWARM_SKIP`） | 只预热**一份快照**，不预热 running VM |
| 已有驱逐 | `src/ops/harness-maintenance.ts:179 pruneSnapshotPool({poolDir,maxAgeMs,maxEntries})`：按目录 mtime 降序，`tooOld = now-mtime>maxAgeMs` **或** `>=maxEntries` 即删；生产 `deploy/harness-maintenance.sh.example` 每天 04:30 `--max-age-hours 72 --max-snapshots 8 --apply` | 年龄 TTL + LRU-by-mtime 上限双条件 |
| 模板指纹 | `templateHash = sha256(kernel size+mtime \| rootfs size+mtime \| agentVersion)`，见 `src/sandbox/microvm/vm-snapshot-manager.ts:32 computeTemplateHash(kernelPath, rootfsPath, agentVersion)`；`agentVersion` 必传 | agent 或内核/rootfs 任一变化 → 指纹变化 → 旧快照自然失效 |

---

## 2. 业界"藏冷启动"的四种形态

### 形态 A：预热池（pre-created / running sandboxes）
预先创建好、**正在运行**的沙箱放在池里，请求来了直接配对。代表：**Daytona warm pools**、**Modal `min_containers`**、**Cloud Run min-instances**、**Northflank min sandbox count**、**CubeSandbox 资源池**。
- 预热对象：已就绪的 running sandbox（Daytona 原文 "pre-created, **running** sandboxes built from a snapshot"；Modal `min_containers` "overprovision idle containers"）。
- 代价：池里每一份都**按运行中资源计费/占配额**（Daytona：池大小×资源计入 org 配额，和运行中 sandbox 一样；Modal：idle 期间照常计费）。**[已验证/第三方]**

### 形态 B：待机快照（standby / suspend / pause）
不在池里常驻运行 VM，而是把"整机状态（内存+文件系统）"冻结成快照，请求到达时恢复。代表：**Fly Machines suspend/resume**、**Blaxel standby/scale-to-zero**、**E2B pause**、**Vercel Sandbox（仅文件系统快照）**、**AWS Lambda SnapStart 缓存快照**。
- 预热对象：**快照**（不是 running VM）。恢复时间 = 各家 resume 延迟（Fly 几百 ms、Blaxel sub-25ms、我们 101ms）。
- 计费：**不按运行资源计**。Fly：suspended 只收 rootfs `$0.15/GB/月`；Blaxel：standby **不计内存费**，只计快照存储/卷；E2B：paused 无限期保留；AWS：按快照缓存时长（≥3h，按 ms）+ 每次 restore 计费。**[已验证/第三方]**

### 形态 C：发布期重建（build-on-publish / build-on-push）
每次发布新版本/推代码时，后台重建预热产物，保证"用户第一次访问时预热已经就绪"。代表：**AWS Lambda SnapStart**（"A snapshot is created each time you publish a new version of your function with SnapStart enabled"）、**GitHub Codespaces prebuilds**（"By default, whenever you push changes to your repository, GitHub Codespaces uses GitHub Actions to automatically update your prebuilds"）。**[已验证]**
- 这正好对应我们 `templateHash` 变化的场景：**agent/内核/rootfs 一变，指纹就变，旧快照自然作废**，必须在"发布之后、用户到来之前"重建。

### 形态 D：fork 运行中 VM（live fork / branch）
对一个**正在运行**的 VM 做 copy-on-write 分支，不重启、不丢内存。代表：**CodeSandbox（userfaultfd）**、**E2B fork**、**Morph Infinibranch**。
- 上游 Firecracker **没有** live-fork：只能 pause → `/snapshot/create` → 再从快照 clone（多 VM 共享同一只读 base）。**[已验证：配套文档 §2.2]**
- E2B fork 的语义也是"原地快照运行中 sandbox（暂停→捕获 FS+内存→恢复）"，N 个 fork 只付**一次**快照成本。**[第三方]**
- CodeSandbox 用 userfaultfd **写保护父 VM 的全部内存**，缺页时把旧页拷给子 VM，实现真正共享内存的 fork（详见 §4）。**[第三方]**

---

## 3. 逐家事实表

| 厂商 | 预热/待机的是什么 | 池大小 / 驱逐 | 计费 | 恢复/冷启数字 | 来源 |
|---|---|---|---|---|---|
| **AWS Lambda SnapStart** | 对已初始化函数的内存+磁盘做 Firecracker 快照，加密后"intelligently caches it to optimize retrieval latency"，维护多份副本并自动打补丁 | 由 AWS 托管，用户不可见；**每次 publish 新版本会重建快照**（旧版本快照随版本有效期） | 快照缓存按时长（**≥3h**，按 ms）+ **每次 restore** 计费，均按分配内存；Provisioned Concurrency `$0.0000041667/GB-s`（保证"double-digit ms"就绪） | 博客：冷启 "over 6 seconds to less than 200 ms"、"up to 10x faster" | **[已验证]** docs.aws.amazon.com/lambda/latest/dg/snapstart.html / snapstart-activate.html / aws.amazon.com/blogs/aws/new-accelerate-your-lambda-functions-with-lambda-snapstart/ / aws.amazon.com/lambda/pricing/ |
| **Fly.io Machines** | **整机快照**（CPU 寄存器、内存、打开 fd）到持久存储；**不是常驻池** | 无常驻池；`autostop` 后由 Fly Proxy 在请求到达时 `autostart`（每轮每 region 最多停 1 台，**从不创建/销毁 machine**） | 运行按秒；stopped/suspended 只收 rootfs **$0.15/GB/月** | resume "a few hundred ms"；冷启 ~2s+；>2GB 内存不建议 suspend；**新 deploy 会作废旧快照**；clock 需等 NTP | **[已验证]** fly.io/docs/reference/suspend-resume/、fly.io/docs/launch/autostop-autostart/、fly.io/docs/about/pricing/ |
| **Daytona warm pools** | **pre-created, running sandboxes built from a snapshot**（真 running VM） | pool size 可配（API `daytona.warm_pool`），每 snapshot×region 一池；**每次领取后后台自动补足**（auto-replenish，无手动触发）；只有 same snapshot + 默认资源/OS user + 无自定义 env/volumes/secrets 才命中 | 池大小×资源**计入 org 配额**，与运行中 sandbox 同等 | container class <90ms | **[第三方]** daytona.io/docs/en/warm-pools/、/docs/en/limits/ |
| **Modal** | `min_containers` 常驻暖容器 / `buffer_containers` 额外缓冲；另有 Memory Snapshots（CRIU 适配 gVisor） | idle timeout 默认 60s、可设 2s–20min | **idle 期间照常计费**（GPU 预留/内存残留） | Mem Snapshot 比普通容器启动快 ~2.5×（torch 例 p50 1.05s） | **[第三方]** modal.com/docs/guide/cold-start、/guide/memory-snapshot |
| **Blaxel** | 无活动连接 → 自动 **standby/scale-to-zero**；standby 时生成"整个状态（内存中的完整文件系统 + 运行中进程）"快照 | 自动；WebSocket/TCP 空闲 15min 触发；进入 standby 约 15s；**快照不保留外部网络连接** | standby **不计内存费**，只计快照存储/卷；另有 archive（不保内存、更慢、不能 fork） | cold start **sub-25ms** | **[第三方]** docs.blaxel.ai/Sandboxes/Overview |
| **E2B** | `pause` 保存 FS+内存；`fork` = 原地快照运行中 sandbox | paused **无限期保留、无 TTL、不自动删除**；fork N 份只付一次快照 | 未在文档页给出池化计费 | 文档未给 ms 数字 | **[第三方]** e2b.dev/docs/sandbox/persistence、/sandbox/fork |
| **Morph Cloud** | Infinibranch：对运行中整机快照/分支/恢复 | `instance start $SNAPSHOT --ttl-seconds`；分支近零开销 | 未公开 | **<250ms**（快照/分支/恢复） | **[第三方]** cloud.morph.so/docs/developers |
| **Northflank** | microVM per workload（Kata 或 gVisor），min/max sandbox 自动扩缩 | min/max counts | 未在页面给出 | "sub-second cold starts" | **[第三方]** northflank.com/product/sandboxes |
| **Vercel Sandbox** | stop 时自动快照**仅文件系统**（非内存）；resume = 新 session 从最近快照 | 默认持久；默认 session 超时 5 分钟 | 未在概念页给出 | boot "Milliseconds (Firecracker optimized for fast boot)" | **[第三方]** vercel.com/docs/vercel-sandbox/concepts |
| **CubeSandbox（腾讯，非 Firecracker）** | 模板 + **资源池 + 快照克隆** "skip all cold-start overhead"；CubeCoW 用 XFS reflink（FICLONE） | 未公开上限 | 未公开 | 单并发 **<60ms**；<50 并发 avg 67ms / P95 90ms / P99 137ms；每沙箱内存开销 **<5MB** | **[第三方]** github.com/TencentCloud/CubeSandbox |

**一个被转述但未能证实的说法**：任务描述里提到 AWS SnapStart "restore in advance" 且"约 90% 的函数可在 10 分钟内预热"。我用 Bing 精确短语检索 `"SnapStart" "restore in advance"` **无结果**，AWS 官方 SnapStart 文档/pricing 页只说"caches the snapshot"、"charged for caching a snapshot over the period that your function version is active, for a minimum of 3 hours"。**故标注为未核实的转述**；如后续要引用请以官方文档为准。**[推测/未核实]**

---

## 4. fork 运行中 VM：在我们约束下可行吗？

### 4.1 机制（CodeSandbox 2023）
- 2022 版：fork 时**全量拷贝**父 VM 内存，"not fast enough"。
- 2023 版用户态 fork：用 `memfd_create` 建内存文件交给 Firecracker；fork 时对**父 VM A 的全部内存写保护**（userfaultfd 的共享内存写保护，**Linux 5.19 才引入**，2022-07-31 发布）；VM B 缺页 → handler 从 A 拷贝该页（A 写前先 **eager copy** 旧页，否则 undefined behavior/kernel panic）→ `UFFDIO_COPY`。`uffd-handler` 进程注册 A 及其子 VM 的内存。需 `CAP_SYS_ADMIN`，或 `vm.unprivileged_userfaultfd=1`（6.1+ 走 `/dev/userfaultfd`）。**[第三方]** codesandbox.io/blog/cloning-microvms-using-userfaultfd（直接访问 403，经 web.archive.org 读取）

### 4.2 唯一性/熵障碍（Firecracker 官方）
- 官方原文：*"Without a strong mechanism that enables users to guarantee that unique things stay unique across snapshot restores, we consider resuming execution from the same state more than once insecure."* 受影响的是 **identifiers、random numbers、entropy pool、cryptographic tokens**。**[已验证]** `docs/snapshotting/snapshot-support.md` §Snapshot security and uniqueness
- VMGenID 是官方解药：Firecracker **总是启用**该设备，恢复时更新 16 字节 ID 并向 guest 注入通知；**但 Linux 要 ≥5.18 才消费**（4.14 完全不消费），官方原文 *"In kernels where there is no VMGenID driver, the device will not have any effect"*。**[已验证]**
- 即使 ≥5.18，官方仍强调 *"State other than the guest kernel entropy pool, such as unique identifiers, cached random numbers, cryptographic tokens, etc **will** still be replicated"* → 应用层仍需去重。**[已验证]**
- 版本事实：VMGenID 设备 x86_64 在 Firecracker **[1.10.0]** 加入（PR #4487，快照格式升 2.0.0）；virtio-rng `/entropy` 端点在 **[1.4.0]** 加入。我们 v1.17.0 **两个设备都支持**，但 guest 4.14 无 VMGenID 驱动 → **设备无效**。**[已验证]** Firecracker CHANGELOG + raw.githubusercontent.com/torvalds/linux/v5.18/drivers/virt/vmgenid.c（200；v5.17 为 404）

### 4.3 4.14 上的替代缓解（可行）
官方针对 **<5.18** 给出的"直接做法"三步（`docs/snapshotting/random-for-clones.md`）：打开 `/dev/random|/dev/urandom` → `ioctl(RNDADDENTROPY)`（需 `CAP_SYS_ADMIN`）→ `ioctl(RNDRESEEDCRNG)`（**4.14 就有**）强制重播种 CSPRNG；Annex 1 附了现成 C 程序。另可：删 `/var/lib/systemd/random-seed`、bind-mount 覆盖 `/proc/sys/kernel/random/boot_id`、用 virtio-rng（但**无法控制 guest 何时取熵**）、依赖 Intel RDRAND/RDSEED HWRNG（IvyBridge+/Broadwell+）。**[已验证]**
> **一个重要的"顺带发现"**：**我们现在就已经在"同一快照恢复多次"**（N=10 热恢复就是这么跑的）。也就是说上面的唯一性警告**对现有生产路径已经成立**，与是否 fork 无关。目前风险低，是因为 `runId`/`sandboxId` 由宿主生成（`guest/agent` 里 grep 不到任何随机数/ID 生成逻辑）。**建议**：在 guest agent 启动序列里加一次 `RNDADDENTROPY`+`RNDRESEEDCRNG`（防御纵深，代价 ~0），并对"每台 VM 必须有唯一标识"的东西坚持宿主下发。**[推测/待实测]**

### 4.4 结论
- 宿主是 Ubuntu 22.04 / 内核 6.8：**5.19+ 的 userfaultfd 写保护在宿主侧是可用的**，所以"宿主内核太老"不是障碍。
- 真正的取舍是**收益**：fork 相对"同一黄金快照 pause→snapshot→clone"能省的，只是**每个模板一次**的 make-snapshot 成本（0.9s），而我们已经把这份快照缓存在池里、恢复只要 101ms。**为省 0.9s（且它已在后台）去背一个自研 UFFD handler（崩溃会让 Firecracker 永久 hang）+ guest 熵去重，不划算。**
- **判定：过度设计。** 如果将来要做，前置条件是 ① guest 内核升到 ≥5.18 或 agent 内做 RNDRESEEDCRNG；② 宿主/宿主内核固定；③ 有明确的"必须从运行中状态分支"的产品需求（如 E2B 式"从当前会话复制 N 份"），而不是"为了更快"。

---

## 5. 单机小规模下的池化权衡（我们的数字）

### 5.1 三种"池"的成本量级

| 方案 | 每份成本 | 我们的规模下要多少份 | 收益（相对池空） |
|---|---|---|---|
| **P0 快照池**（现状：每 templateHash 一份 `mem.snap`+`vm.snap`，共享只读 base 硬链接） | 磁盘 ~(256~512MB mem + 26KB vm + 21MB kernel + 256MB rootfs + 128MB workspace) ≈ **0.4~0.9GB/模板**；RAM ≈ 0（未恢复不占 guest 内存） | **1~2 份**（当前 + 上一版本用于回滚）| 1334ms → **101ms** |
| **P1 待机快照池**（P0 的 K 个副本 / 预留 tmpfs 热副本） | 同 P0，胜在"备份/预热优先级" | 1~2 | 同上，主要防"唯一那份被删/损坏" |
| **P2 running standby VM 池**（预先恢复好、agent 已就绪的 VM） | 每台 VMM 自身 **<5MB** + guest 实际驻留工作集（4.14 + Alpine + 96MB Bun agent 的文件页是 rootfs page cache，**多台共享**；私有堆很小，**[推测] 每台 ~20~60MB**） | **K=1~2** 足够（并发 2–10 但到达率低） | 101ms → **~5~20ms** |

**内存预算**：即便按最坏"每台 standby VM 独占 256MB"算，K=2 也只有 512MB，占 251GB 的 **0.2%**；P2 的瓶颈从来不是内存，而是**每台常驻 VM 都是一个会漂移/崩溃/需健康检查与回收的进程**（我们已有 vm-orphan-reaper 兜底）。**磁盘**：即便 8 个模板 × 0.9GB = 7.2GB，对 2×3.5TB 也可忽略。

### 5.2 命中率要不要算？
我们对齐的粒度是 **templateHash**，不是用户/用户。稳态下内存里只需要 1 份快照，命中率天然接近 100%；**唯一会 miss 的时刻是"模板刚变、预热还没跑完"的窗口**（重建 2.25~2.42s，若用配套文档 §5/§6 的优化可压到 ~0.2~0.4s）。所以"池大小 vs 命中率"的曲线在我们这个规模**几乎没有拐点可言**——这跟 Daytona/Modal 那种"多用户、多 snapshot、高并发"的场景完全不同，**照抄他们的池语义（按 snapshot×region 建池、池大小计入配额）对我们没有收益**。**[推测]**

### 5.3 ⚠️ 现有 GC 的一个竞态（建议修）
`pruneSnapshotPool` 按目录 **mtime 降序**，`tooOld = now - mtime > maxAgeMs`。而**当前在用的黄金快照目录的 mtime 就是它被发布的时间**：每小时预热脚本发现 `hasSnapshot=true` 会 `VM_PREWARM_SKIP` 直接返回，**不会 touch 目录**。于是 `--max-age-hours 72` 会在 72 小时后**把唯一在用的那份快照删掉**，直到下一次预热重建之间，落进来的 Run 会吃到 1334ms 冷启动。**[已验证：源码逻辑推导]**
**修法（任选其一，都便宜）**：① `tooOld` 判断排除当前 `templateHash`（或在 `pruneDirectories` 传入 `protectNames`）；② 预热命中 `VM_PREWARM_SKIP` 时顺手 `utimesSync` touch 一下目录；③ 生产参数改为只按条数驱逐（`--max-age-hours` 调大或禁用年龄条件）。

---

## 6. 预热触发时机：可直接照抄的模式

| 模式 | 业界对应 | 我们的落地 |
|---|---|---|
| **M1 开机后**（boot-time） | Fly 冷启、Cloud Run 首次 | ✅ 已有：`OnBootSec=20s` |
| **M2 定时巡检**（periodic reconcile，幂等） | k8s controller 式；Codespaces 周期性更新 prebuild | ✅ 已有：`OnCalendar=hourly` |
| **M3 发布/构建后**（build-on-publish） | **AWS SnapStart 每次 publish 重建快照**；Codespaces 每次 push 触发 prebuild | ❌ 缺：把预热挂到"agent 编译完成/镜像发布完成"之后（`templateHash` 一变就必须重建）；也可在 `deploy` 脚本末尾 `systemctl start harness-vm-prewarm.service` |
| **M4 池低于水位即补**（auto-replenish on claim） | **Daytona**：每次领取后后台自动补足 | 半有：每小时巡检近似，但没有"领取后立即补"；对我们只有 1 份快照，等价于"被删/失效就补" |
| **M5 首请求触发 + 该 Run 走冷启动**（lazy warm） | Lambda 冷启 + Provisioned Concurrency 拉起；Cloud Run min-instances 提升 | ❌ 缺：`driver.create` 发现 `hasSnapshot=false` → **本次 Run 走冷启动，同时异步触发预热**，让"第一个用户付一次 1334ms，之后所有人都 101ms"。这是 M1/M2 之外最后一道兜底 |
| **M6 空闲 TTL 后停**（反向：scale-to-zero） | Fly `autostop`、Blaxel standby、Modal `container_idle_timeout` | 仅适用于 P2 running standby VM 池：闲置 10~30min 即回收，避免孤儿 |

---

## 7. 结论：给我们规模的 3–5 条最划算策略（排序）

| # | 策略 | 参数建议 | 预期收益 | 难度 | 风险 |
|---|---|---|---|---|---|
| **1** | **把"池永不缺失"闭环补全**：M3（发布后重建）+ M5（首个请求触发异步补）+ 修 §5.3 的 GC TTL 竞态 | 预热后 `systemctl start harness-vm-prewarm.service`；`driver.create` 中 `hasSnapshot=false` → 冷启 + 后台预热；GC 排除当前 templateHash | 把唯一会付 **1334ms** 的场景从"模板变化/清池后的一段时间"缩到"**改动后的第一个 Run**"；稳态用户 p50 稳定 **101ms** | 低 | 低（只是串脚本，不引入常驻进程） |
| **2** | **池驱逐改为"当前 templateHash 永久保留 + 旧版本留 N-1"** | `max-snapshots 8` 保留；年龄条件要么去掉、要么对当前 hash 豁免；旧版本保留 1 份用于回滚 | 消除"在用快照被 GC 删掉"造成的 1334ms 抖动；磁盘代价 <1GB | 低 | 低（误删旧版本只影响回滚窗口，可重建） |
| **3** | **（可选，真机有余量再做）K=1~2 台常驻 running standby VM** | K=2；领取即补；空闲 10~30min 回收（M6）；health check + 复用已有 vm-orphan-reaper | 101ms → **~5~20ms**；收益**只对突发首请求**（稳态用户已在 101ms） | 中 | 中（idle VM 漂移、孤儿、健康检查、少量内存） |
| **4** | **把 make-snapshot 移出关键路径**（跨引用 `docs/research/cold-start-snapshot-cost.md` §5/§6） | `"sync_snapshot_files": false`；首次就用 `snapshot_type:"Diff"`（配 `track_dirty_pages`）；必要时 `mem_file_path` 指向 tmpfs 后后台落盘 | 重建从 2.25~2.42s → **[推测] ~0.2~0.4s**；让 #1/#2 的重建几乎无感 | 中 | 中低（宿主崩溃丢快照 → 池可重建，已有基础设施） |
| **5** | **（不建议）fork 运行中 VM / 自研 UFFD** | — | 相比"同一黄金快照多次热恢复"**几乎无增量收益** | 高 | 高（handler 崩溃 → Firecracker 永久 hang；guest 4.14 熵去重） |
| **6** | **（不建议）按用户预热池** | — | **零收益**：我们按 `templateHash` 而不是用户共享快照，用户之间是同一份 | — | 复杂度、内存/磁盘浪费 |

### 明确属于过度设计（对"单机 + 十几人 + 并发 2–10"）
1. **fork 运行中 VM / 自研 userfaultfd handler**（§4）——收益 <100ms 量级，复杂度/风险不成比例。
2. **内存镜像压缩 + 惰性解压**（CodeSandbox 式）——我们 256MB guest、恢复已 101ms，压缩主要省磁盘/内存而非时间。
3. **跨机/多 region 池、多副本快照**——单机部署，无此需求。
4. **按用户/按用户预热**——快照按模板共享，用户维度不产生 miss。
5. **池大小 >2~3、复杂水位控制器、独立预热守护进程**——用一个幂等 oneshot + systemd timer 已经够；再加水位控制只会增加失效面。
6. **为"更快恢复"上 UFFD 后端**——`/snapshot/load` 已 4~7ms、`File` 后端本身是 `MAP_PRIVATE` 惰性加载（见配套文档 §2），收益趋近 0 且引入 hang 风险。

---

## 8. 待实测 / 待确认

1. **§5.3 GC 竞态**：把 `--max-age-hours` 调到很小，验证"在用快照会被删、且下一次预热前 Run 走冷启动"。
2. **P2 standby VM 的真实内存**：恢复后空闲态的 `RSS`（区分 VMM 私有 vs rootfs page cache 共享），验证"每台 20~60MB"的推测。
3. **guest 4.14 是否能用 `RNDRESEEDCRNG`**：在 guest 里跑一次官方 Annex 1 程序，确认 `ioctl` 成功且 `/dev/urandom` 前后序列不同（CAP_SYS_ADMIN 在 jailer 内是否可得是关键）。
4. **guest 4.14 是否带 virtio-rng 驱动**：官方 quickstart `vmlinux.bin`（4.14.174）的 config 未在仓库中随 4.14 版本保留（FC 现只维护 5.10/6.1/6.18 config），需在 guest 内实测 `/dev/hwrng` 或 `dmesg | grep -i virtio-rng`。
5. **M5 首请求异步预热的实现点**：确认在 `driver.create` 的哪一层安全触发（避免与正在冷启的 VM 争 CPU/IO）。

---

## 9. 来源清单

**官方 / 上游（[已验证]）**
- Firecracker v1.17.0：`docs/snapshotting/snapshot-support.md`（§Snapshot security and uniqueness、VMGenID、on-demand load + COW）、`docs/snapshotting/random-for-clones.md`（熵/克隆、<5.18 直接做法、Annex 1）
- Firecracker CHANGELOG（VMGenID x86_64 于 1.10.0 / PR #4487；virtio-rng 于 1.4.0）：`https://github.com/firecracker-microvm/firecracker/blob/main/CHANGELOG.md`
- Linux VMGenID 驱动 v5.18 存在、v5.17 不存在：`https://raw.githubusercontent.com/torvalds/linux/v5.18/drivers/virt/vmgenid.c`
- AWS：`https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html`、`.../snapstart-activate.html`、`https://aws.amazon.com/blogs/aws/new-accelerate-your-lambda-functions-with-lambda-snapstart/`、`https://aws.amazon.com/lambda/pricing/`（SnapStart ≥3h 缓存计费、Provisioned Concurrency $0.0000041667/GB-s）
- GitHub Codespaces prebuilds：`https://docs.github.com/en/codespaces/prebuilding-your-codespaces/about-github-codespaces-prebuilds`

**厂商文档 / 第三方（[第三方]，未独立复现）**
- Fly.io：`https://fly.io/docs/reference/suspend-resume/`、`https://fly.io/docs/launch/autostop-autostart/`、`https://fly.io/docs/about/pricing/`
- Daytona：`https://daytona.io/docs/en/warm-pools/`、`https://daytona.io/docs/en/limits/`
- Modal：`https://modal.com/docs/guide/cold-start`、`https://modal.com/docs/guide/memory-snapshot`
- Blaxel：`https://docs.blaxel.ai/Sandboxes/Overview`
- Morph：`https://cloud.morph.so/docs/developers`
- E2B：`https://e2b.dev/docs/sandbox/persistence`、`https://e2b.dev/docs/sandbox/fork`
- Northflank：`https://northflank.com/product/sandboxes`
- Vercel Sandbox：`https://vercel.com/docs/vercel-sandbox/concepts`
- CubeSandbox：`https://github.com/TencentCloud/CubeSandbox`
- CodeSandbox userfaultfd fork：`https://codesandbox.io/blog/cloning-microvms-using-userfaultfd`（经 `https://web.archive.org/` 读取）

**本仓库**
- `docs/research/cold-start-snapshot-cost.md`（make-snapshot 成本、diff、tmpfs、UFFD、压缩）
- `src/sandbox/microvm/vm-snapshot-manager.ts:32`（`computeTemplateHash`）、`src/ops/harness-maintenance.ts:179`（`pruneSnapshotPool`）
- `scripts/vm-snapshot-prewarm.ts`、`deploy/harness-vm-prewarm.timer.example`、`deploy/harness-maintenance.sh.example`
