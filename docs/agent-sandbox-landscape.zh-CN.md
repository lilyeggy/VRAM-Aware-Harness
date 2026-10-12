# 主流 Agent Sandbox 技术方案调研（2026-10）

> 目的：搞清楚 E2B / Daytona / Modal / CubeSandbox / CodeSandbox / Fly / Morph 这类系统「几毫秒拉起沙箱」到底是**怎么做到的**，以及我们（VRAM-Aware-Harness）的差距是**技术栈限制**还是**自己加的拷贝**。
> 方法：只采信官方文档 / 官方工程博客 / 官方仓库源码文档，逐条带 URL。数字口径不一致的地方明确标注。

## 0. 一页结论

1. **没有一家是靠「更快的虚拟机」取胜的。** Firecracker 冷启动 ~125ms（AWS 口径）、快照恢复本身毫秒级，是公共基线。我们真机实测 `snapshot-load`（`/snapshot/load` + resume）只有 **6~7ms**。
2. 拉开差距的是三件事：**① 把「每沙箱私有资源」从拷贝换成写时复制/按需分页；② 把恢复成本挪到预热池；③ 尽量不重启（fork 运行中的 VM）。**
3. 各家宣称的 ms 数字，口径通常只覆盖「恢复/领取」这一段：**不含应用初始化、不含镜像拉取、不含网络就绪**，且往往是**池命中**或**单并发**结果。
4. **最重要的发现（纠正我们之前的判断）**：Firecracker 官方设计**允许**多台 microVM **共享内存页与只读磁盘** —— 加载快照时对内存文件建 `MAP_PRIVATE` 映射，按需缺页加载，写入走 COW 匿名内存。也就是说我们 490ms 里那 **298ms 的 `mem.snap` 拷贝、110ms 的磁盘拷贝，绝大部分是我们自己多加的**，不是技术栈限制。
5. 我们真正缺的对照物：**XFS reflink / COW 文件系统**（CubeSandbox 的 CubeCoW 就靠 `FICLONE` 做 O(1) 克隆）、**预热池**、**只读基础镜像 + 可写 RAM 层**。

## 1. 逐家技术卡片

| 平台 | 隔离技术 | 启动/恢复机制 | 官方宣称延迟 + 口径 | 关键工程细节 | 来源 |
|---|---|---|---|---|---|
| **E2B** | 自研 MicroVM runtime（Firecracker），每 sandbox 独立内核 | pause 保存「文件系统 + 内存」到存储；resume 恢复内存；另有 snapshot/fork（一次快照派生 N 台） | pause ≈ **4s/GiB RAM**、resume ≈ **1s**（未标分位，不含网络） | 暂停不计费、不限并发；创建受节点容量限制（503）；启动走快照，官网称 "container speed" | e2b.dev/security、docs.e2b.dev/sandbox/persistence、/sandbox/fork |
| **Fly.io Machines** | Firecracker microVM | `suspend` 用 Firecracker 快照把整机状态（CPU 寄存器、内存、打开的文件句柄）**写入持久存储**；`start` 从快照恢复而非冷启动（官方措辞 attempt-but-not-guaranteed） | resume **「a few hundred ms」**；冷启动 **~2s+**；启动消息本身 ~10–150ms | `flyd` = 单 host 上所有 VM 的 source of truth（boltdb，market 式调度，不缓存全局状态）；**无预热池**，建议「提前建 machine、用时再 start」 | fly.io/docs/reference/suspend-resume/、fly.io/blog/carving-the-scheduler-out-of-our-orchestrator/ |
| **Vercel Sandbox** | Firecracker microVM（每 sandbox 独立内核，内部代号 Hive） | stop 时自动快照**文件系统**（非内存）；resume 从最近快照起新 session | 新 sandbox **「milliseconds（Firecracker optimized for fast boot）」**；从快照恢复比全新启动更快（未标口径） | 快照 = 文件系统 + 已装包，不保内存；默认超时 5 分钟；一个 sandbox 跨多 session | vercel.com/docs/sandbox/concepts、vercel.com/blog/vercel-sandbox-is-now-generally-available |
| **AWS Lambda SnapStart** | Firecracker microVM | 发布版本时初始化 → 对**内存 + 磁盘**做 Firecracker 快照 → KMS 加密 → 多副本缓存；调用时从缓存快照 resume | 低至 **sub-second**；Java 启动 **up to 10× faster**（未给 p99） | 快照随 runtime/安全补丁自动刷新并重跑 init 计费；**快照含唯一性风险（随机数/ID/密钥）**，官方有专门安全章节；删除函数即按 GDPR 清除 | docs.aws.amazon.com/lambda/latest/dg/snapstart.html、/snapstart-security.html |
| **Daytona** | 默认 Container class = Linux 容器（namespace + 强制 vCPU/内存/磁盘限额）；另有自带内核的 VM/Windows 类 | **Warm Pools**：按 snapshot×region 预建运行中的沙箱；create 需全条件命中（snapshot、region、默认资源、默认用户、无自定义 env/volumes/secrets）才领取；VM 类支持 pause/resume、fork、hot snapshot | Container **<90ms**（未给分位）；每 snapshot×region 一池、占配额、需 support 开启 | container 快照仅文件系统（cold snapshot），停止后仍占磁盘；VM 快照 = 文件系统 + 内存（hot snapshot），停止后 offload 释放配额 | daytona.io/docs/en/isolation/、/warm-pools/、/snapshots/ |
| **Modal** | Sandboxes 仅支持 `runtime="gvisor"`（用户态内核） | Memory Snapshot 源自 **CRIU 适配 gVisor**：快照整个容器状态（文件系统改动 + 进程树：内存映射/fd 表/寄存器/env/PID），不含活动网络连接与 GPU 状态；恢复时 gVisor **按需读 pages 文件**（优先被阻塞页）+ 激进预载 page cache | 容器启动约 **1s**；内存快照后启动快 **3–10×**，"cold start latency can be more than halved" | 容器 FS = OverlayFS，只读 lower 为 FUSE 懒加载服务；`@modal.enter(snap=True)` 在快照前执行、普通 `@modal.enter()` 不入快照；keep_warm/min containers 预热；Memory Snapshot 7 天不可续 | modal.com/docs/guide/memory-snapshots、/guide/cold-start、modal.com/blog/mem-snapshots |
| **Blaxel** | microVM（VMM 厂商未公开） | 进 standby 前自动快照**整个状态**（完整文件系统在内存 + 运行中进程）；重连即恢复进程 | **sub-25ms cold start**、standby **resume <25ms**（未给分位）；静止数秒自动 scale-to-zero | **不保留外部网络连接**（DB/队列/HTTP 池会超时）；standby 切换约 15s；standby 不计内存费、计快照存储费；**文件系统 = 宿主上 EROFS 只读基础镜像 + 纯 RAM tmpfs 可写层（OverlayFS 分流）**，tmpfs 约占分配内存 50% | blaxel.ai、docs.blaxel.ai Sandboxes/Overview、/Infrastructure/Gens |
| **Northflank** | CPU sandbox = microVM（自带内核）；GPU sandbox = gVisor；云上自动选择，BYOC 可指定 | pause/resume 端点，暂停即 scale-to-zero（停算力、卷仍计费） | boot **under a second**（未给分位） | 官方点名 Kata Containers 与 gVisor；ephemeral 存储在暂停时丢失 | northflank.com/product/sandboxes、/docs/v1/application/sandboxes/quickstart |
| **Cloudflare** | Containers = VM-per-container；Workers = **V8 isolate**（非每函数一 VM） | isolate 无 VM 冷启动；容器首次请求需等实例启动 | isolate 启动比容器/VM 上的 Node 进程快约 **100×**；Containers 冷启动通常 **1–3s**（取决于镜像大小） | 容器磁盘默认临时、重启回镜像；快照为 durable_object 调度下的时点不可变文件系统快照；VMM 实现未公开 | developers.cloudflare.com/containers/、/workers/reference/how-workers-works/ |
| **CubeSandbox**（腾讯云，2026-04 开源，Go+Rust，Apache-2.0） | **RustVMM + KVM 硬件级 MicroVM**，每沙箱独立内核 | 预快照模板 + RustVMM 恢复路径；**CubeCoW 存储引擎用 XFS reflink（`FICLONE`）做元数据级 O(1) 快照/克隆** + 脏页增量；支持快照/克隆/回滚与 **CoW 内存 fork** | **<60ms 冷启动**（单并发）；50 并发均值 67ms、P95 90ms、P99 137ms；**<5MB 内存开销** | 另有 eBPF 网络（CubeVS）、L7 出网代理（CubeEgress）；PVM（页表嵌套虚拟化，OpenCloudOS 内核）用于无 `/dev/kvm` 的云主机 | github.com/TencentCloud/CubeSandbox、docs/architecture/overview.md、cubesandbox.com |
| **Morph Cloud** | 自研 MorphVM 虚拟化栈 + MorphFS 分布式 COW 文件系统（VMM 未公开） | **Infinibranch** = 快照/分支/恢复整机环境；原语 image → snapshot → instance → branch | 恢复 **<250ms**、分支近零开销 | 分支 = COW 文件系统 + 快照树 | cloud.morph.so/docs/developers、morph.so/blog/infinibranch（存档） |
| **CodeSandbox** | microVM（Firecracker） | 2022：内存快照落盘 + **reflink** 复制，运行中 VM clone **2s**；2023：改为**用户态 fork，用 userfaultfd**（`memfd_create` + 写保护父 VM + 惰性按页拷贝，依赖 Linux 5.19 共享内存写保护 + 6.1.8 修复）；2024：快照 **zstd 压缩（8GiB→412MiB，约 20×）+ 惰性解压** | clone 2s（2022）→ 恢复 **<1s**（2024） | 关键洞察：**瓶颈从「拷贝」变成「拷贝量」**，于是压缩 + 惰性解压 | codesandbox.io/blog/how-we-clone-a-running-vm-in-2-seconds、/cloning-microvms-using-userfaultfd、/how-we-scale-our-microvm-infrastructure-using-low-latency-memory-decompression |
| **Cua / Lume** | Apple Virtualization.framework（Apple Silicon），开源 | 有 `lume clone`；快照/分支机制与延迟**未公开** | 未公开 | 主要面向 macOS 上的 computer-use agent | github.com/trycua/cua、cua.ai/docs/lume |
| **microsandbox** | Rust，libkrun + smoltcp，每沙箱独立内核 microVM，OCI 兼容 | disk 快照（新 VM 启动）与 **full 快照（内存 + 进程恢复）**；`--cow-mem` 让子 VM **共享未改动内存页**，首次恢复建本地内存缓存供后续复用 | 启动平均 **<100ms**（口径：M1 上 guest boot） | 跨 Linux(KVM)/macOS/Windows(WHP) | github.com/superradcompany/microsandbox、docs.microsandbox.dev/sandboxes/snapshots |
| **Arrakis** | Cloud Hypervisor + KVM（**非 Firecracker**），overlayfs 保护根文件系统 | snapshot-and-restore 回滚 | 未公开 | 开源 AGPLv3 自托管 Agent 沙箱 | github.com/abshkbh/arrakis |

## 2. 横向解剖：把「启动」拆成五条路径

| 路径 | 机制 | 谁在用 | 成本/代价 |
|---|---|---|---|
| **① 真冷启动** | 内核 boot + init + agent 就绪 | Firecracker 官方 ~125ms；我们 1.5s（guest 4.14 + 我们自己的拷贝） | 每次都要重跑初始化 |
| **② 文件系统快照恢复** | 只恢复磁盘，进程重新起 | Vercel（stop 快照 FS）、Daytona container（cold snapshot）、microsandbox disk 快照 | 快，但应用初始化要重跑 |
| **③ 内存快照恢复（全量写盘/读盘）** | 整机状态（内存 + CPU 寄存器 + fd）落盘再读回 | Fly suspend、E2B pause/resume、Lambda SnapStart（+KMS 加密 + 多副本缓存）、Blaxel standby、microsandbox full | 快照体积 = guest 内存；**恢复时间 ≈ 内存体积 / IO 带宽**（E2B 官方 4s/GiB 写、1s 读） |
| **④ 内存 COW / 按需分页** | 不搬内存，缺页时从基础文件取页；写入走私有 COW 页 | **Firecracker 官方 `MAP_PRIVATE`**、CodeSandbox（userfaultfd + 写保护父 VM）、Modal（CRIU + gVisor 按需读 pages）、microsandbox `--cow-mem`、CubeSandbox（XFS reflink + CoW 内存 fork）、Morph（MorphFS COW） | 恢复时间与内存体积**解耦**；代价是「必须保留基础文件整个生命周期」+ 首次访问页有缺页开销 |
| **⑤ 预热池 / 常驻待命** | 提前把 VM 恢复到「就等任务」状态，请求来了直接交接 | Daytona Warm Pools、Modal keep_warm、Fly（建议预建 machine）、Blaxel standby | 用户可见延迟 ≈ 交接成本；代价是**常驻内存**与池命中条件苛刻（Daytona 要求默认资源/无自定义 env 才命中） |

**再往上还有一层：fork 运行中的 VM**（CodeSandbox 2022 用 reflink、2023 改用 userfaultfd 写保护父 VM；Morph infinibranch）。这层解决的是「同一初始状态派生 N 个沙箱」，把「恢复」变成「分叉」。

## 3. 延迟数字口径对照（口径不可比，别直接横比）

| 平台 | 宣称数字 | 是否池命中 | 是否含应用初始化 | 是否含网络就绪 |
|---|---|---|---|---|
| Firecracker 官方 | boot ~125ms；恢复毫秒级（无具体数） | 否 | 否 | 否 |
| E2B | resume ≈1s；pause ≈4s/GiB | 未说明 | 未说明 | 未说明（明示不含网络） |
| Fly | resume「几百 ms」；冷启动 ~2s+ | 否 | 否 | 否 |
| Vercel | 「milliseconds」（启动） | 未说明 | 未说明 | 未说明 |
| Lambda SnapStart | sub-second；Java up to 10× | 是（快照副本缓存） | 否（init 已含在快照里） | 否 |
| Daytona | Container <90ms | **是（Warm Pools）** | 否 | 未说明 |
| Modal | 容器 ~1s；内存快照后快 3–10× | 可选（keep_warm） | `@modal.enter` 已含在快照里 | 否 |
| Blaxel | cold start sub-25ms、resume <25ms | 是（standby） | 否 | **明示不含（网络连接不保留）** |
| Northflank | boot under a second | 未说明 | 未说明 | 未说明 |
| CubeSandbox | <60ms 冷启动（单并发）；50 并发 P95 90ms | 否 | 否 | 否（另有 eBPF 网络方案） |
| CodeSandbox | clone 2s（2022）→ 恢复 <1s（2024） | 否 | 否 | 否 |
| microsandbox | 平均 <100ms（M1 guest boot） | 否 | 否 | 否 |

## 4. Firecracker 官方机制与约束（原文要点）

来源：`docs/snapshotting/snapshot-support.md`、`docs/snapshotting/handling-page-faults-on-snapshot-resume.md`、`docs/design.md`。

- **共享是设计内建的**：原文「The design allows sharing of memory pages and read only disks between multiple microVMs. When loading a snapshot, instead of loading at resume time the full contents from file to memory, Firecracker creates a **MAP_PRIVATE mapping** of the memory file, resulting in **runtime on-demand loading of memory pages**. Any subsequent memory writes go to a **copy-on-write anonymous memory mapping**.」
- **内存文件必须不可变**：原文「The memory file ... **must** be considered immutable from Firecracker and host point of view. It backs the guest OS memory for read access through the page cache. **External modification to this file corrupts the guest memory** and leads to undefined behavior.」→ 结论：**共享同一内存文件给多台 VM 是官方支持的**（只要不再写它）；**不能**在 VM 存活期间改它（所以我们池里的 `mem.snap` 必须只读挂载/硬链接，不能原地更新）。
- **两个内存后端**：`mem_backend.backend_type = File`（内核按缺页处理，即上面的 MAP_PRIVATE 路径）或 `Uffd`（用户态进程处理缺页）。`mem_file_path` 已进入弃用流程，与 `mem_backend` 互斥。
- **UFFD 要什么**：内核 5.10 走 `userfaultfd` syscall（需 CAP_SYS_PTRACE 或 `vm.unprivileged_userfaultfd=1`）；6.1+ 走 `/dev/userfaultfd`（按文件权限，**jailer 会自动把它带进 jail**）。需要**用户自己写** page fault handler 进程，与 Firecracker 通过 UDS 通信、用 `UFFDIO_COPY` 拷页；**handler 崩溃会让 Firecracker 永久挂起**；**UDS 与内存文件必须位于 jail 内**；官方有示例 `on_demand_handler.rs`。
- **UFFD 流程**：handler 私有 mmap 内存文件 → Firecracker 匿名 mmap + 向 uffd 注册 → Firecracker 通过 UDS 把 uffd fd 与内存布局交给 handler → 缺页时 handler `UFFDIO_COPY` 把页拷进 guest 内存。
- **diff vs full**：full 写出全部 guest 内存、可独立恢复；diff 只含上次快照后被写的页（稀疏），通常不可独立恢复，需 `snapshot-editor edit-memory rebase` 合并到 base；`track_dirty_pages=true` 用 KVM dirty log，否则用 mincore（需禁用 swap）；diff 仍是 developer preview。
- **唯一性/安全警告（我们必须记录）**：原文「When snapshots are used in a such a manner that a given guest's state is resumed from more than once, guest information assumed to be unique may in fact not be; this information can include identifiers, random numbers and random number seeds, the guest OS entropy pool, as well as cryptographic tokens... **we consider resuming execution from the same state more than once insecure**」，缓解手段是 VMGenID（`random-for-clones.md`）。→ **我们「黄金快照 → 多台恢复」正是这个模式**，需要在 guest 侧做重播种/VMGenID 或明确接受风险（E2B/Daytona/Lambda 全都这么干，Lambda 专门写了安全章节）。
- **其它约束**：恢复不保证网络/vsock 连接保留；guest 墙钟停在快照时刻（需 guest 侧校准）。

## 5. 与我们（VRAM-Aware-Harness）的逐项对照

| 维度 | 主流做法 | 我们现状 | 差距性质 |
|---|---|---|---|
| 隔离技术 | Firecracker / RustVMM / Cloud Hypervisor / gVisor / 容器 | **jailer + Firecracker microVM**（每 Run 独立内核、无网卡、仅 vsock） | 对齐（我们比容器派更强） |
| 内存快照 | E2B/Fly/Blaxel/Lambda 全量落盘恢复；CodeSandbox/Modal/CubeSandbox 按需分页 | 有快照池，但**每台 VM 把 256MB（生产）/512MB（基准）`mem.snap` 全量 `cp` 进 jail chroot** | **自己加的拷贝**（Firecracker 官方支持共享 + 按需分页） |
| 磁盘 | Blaxel EROFS 只读基础 + tmpfs/OverlayFS 可写层；CubeSandbox XFS reflink 克隆 | 每台 VM `cp` kernel 21MB + rootfs 256MB + workspace 128MB 进 chroot；rootfs 盘还是 `is_read_only: false` | **自己加的拷贝**，且顺带是个安全加固缺口 |
| 可写盘 | reflink/COW（CubeSandbox `FICLONE`、CodeSandbox reflink） | ext4 无 reflink，`cp --reflink=auto` 静默退化为全量拷贝 | 缺 COW 文件系统（远程连 `mkfs.xfs`/`mkfs.btrfs` 都没有） |
| 预热池 | Daytona Warm Pools / Modal keep_warm / Fly 预建 / Blaxel standby | 无（每次 Run 现恢复） | 功能缺失（但属于边界新增项） |
| 恢复后握手 | Blaxel 明示不保留网络；E2B/Modal 有 lifecycle hook | vsock 握手 ~53ms（含 guest agent 就绪） | 数量级可接受 |
| 快照体积 | CodeSandbox zstd 20× 压缩 + 惰性解压 | 无压缩（512MB 原样落盘/拷贝） | 可选优化 |
| 分叉 | CodeSandbox userfaultfd 写保护父 VM；Morph infinibranch | 无（每 Run 从黄金快照恢复，本质是「重复恢复同一快照」） | 可选优化 |
| 快照唯一性 | Lambda SnapStart 有专门安全章节 + VMGenID | 未处理（重复恢复同一快照） | **已知风险，需记录** |
| 网络 | CubeSandbox eBPF（CubeVS）+ L7 出网代理（CubeEgress） | Agent 无网卡；宿主侧 `IPAddressAllow` 白名单 | 定位不同（我们故意不给 Agent 网络） |
| 可观测性 | 各家有启动延迟分位数据 | 已有 `HARNESS_VM_PHASE_TRACE` 分阶段埋点 + `warmHit` + `/metrics` | 对齐 |

## 6. 可借鉴项（仅记录候选，按「收益 / 成本」排序，未承诺实施）

| # | 可借鉴项 | 参考对象 | 我们的改造点 | 预期收益 | 风险 |
|---|---|---|---|---|---|
| 1 | **共享只读基础文件，取消 chroot 拷贝** | Firecracker 官方 `MAP_PRIVATE` + 「sharing of memory pages and read only disks」；Blaxel EROFS 只读基础镜像 | 把 kernel/rootfs/`vm.snap`/`mem.snap` 以**只读 bind mount 或硬链接**放进 jail chroot（不再 `cp`）；rootfs 盘改 `is_read_only: true` | 490ms → **~90ms**（省掉 298ms 内存拷贝 + ~75ms 只读盘拷贝） | 内存文件必须只读且不可变；rootfs 只读需验证 guest 能否启动（可能要 tmpfs `/tmp`）；同文件系统才能硬链接（我们池与 chroot 都在 `/data`，满足） |
| 2 | **可写盘用 reflink/COW** | CubeSandbox（XFS `FICLONE`）、CodeSandbox（reflink） | workspace 模板改用 COW 文件系统（xfs reflink=1 / btrfs 子卷） | 省掉每 Run 128MB（或 32MB）workspace 拷贝 | 远程缺 `mkfs.xfs`/`mkfs.btrfs`，需装包或换盘 |
| 3 | **预热池** | Daytona Warm Pools、Modal keep_warm、Fly 预建 machine | Broker 侧维护 N 台待命 VM，Run 到达直接交接 | 用户可见 **10~50ms** | 常驻内存；池命中条件设计；属于边界新增能力（需解冻决策） |
| 4 | **快照压缩 + 惰性解压** | CodeSandbox（zstd，8GiB→412MiB，20×） | 池内 `mem.snap` 落盘前 zstd 压缩，加载时流式解压 | 省磁盘与 IO（对恢复延迟影响需实测） | 增加 CPU；与「共享只读文件」方案可能二选一 |
| 5 | **UFFD fork（从同一快照分叉）** | CodeSandbox 2023 userfaultfd 路线 | 自写 page fault handler（jail 内），用于批量派生 | 批量创建时省内存与 IO | handler 崩溃会挂住 Firecracker；需在 jail 内运行 handler |
| 6 | **快照唯一性处理** | Firecracker `random-for-clones.md` + Lambda SnapStart 安全章节 | guest 侧重播种（宿主在握手时下发 nonce/seed）或接 VMGenID | 消除「重复恢复同一快照」的唯一性风险 | 需改 guest agent；guest 内核 4.14 可能不支持 VMGenID |
| 7 | **只读根 + RAM 可写层** | Blaxel（EROFS + tmpfs OverlayFS） | rootfs 只读 + guest 内 tmpfs/overlay | 只读盘可安全共享；写入不落盘 | 需改 guest 镜像 |
| 8 | **eBPF/L7 出网代理** | CubeSandbox CubeVS/CubeEgress | 若未来要给 Agent 受限网络 | 细粒度出网控制 | 与「Agent 无网络」定位冲突，暂不适用 |

## 7. 来源清单

- Firecracker：`docs/snapshotting/snapshot-support.md`、`docs/snapshotting/handling-page-faults-on-snapshot-resume.md`、`docs/snapshotting/network-for-clones.md`、`docs/snapshotting/random-for-clones.md`、`docs/design.md`（github.com/firecracker-microvm/firecracker）
- E2B：e2b.dev/security、docs.e2b.dev/sandbox/persistence、docs.e2b.dev/sandbox/fork
- Fly.io：fly.io/docs/reference/suspend-resume/、fly.io/docs/machines/、fly.io/blog/carving-the-scheduler-out-of-our-orchestrator/
- Vercel：vercel.com/docs/sandbox/concepts、vercel.com/blog/vercel-sandbox-is-now-generally-available
- AWS Lambda SnapStart：docs.aws.amazon.com/lambda/latest/dg/snapstart.html、/snapstart-security.html、aws.amazon.com/blogs/aws/new-accelerate-your-lambda-functions-with-lambda-snapstart/
- Daytona：daytona.io/docs/en/isolation/、/warm-pools/、/snapshots/、/limits/
- Modal：modal.com/docs/guide/sandbox、/guide/memory-snapshots、/guide/cold-start、modal.com/blog/mem-snapshots
- Blaxel：blaxel.ai、docs.blaxel.ai（Sandboxes/Overview、Sandboxes/Fork、Infrastructure/Gens）
- Northflank：northflank.com/product/sandboxes、northflank.com/docs/v1/application/sandboxes/quickstart、/sandboxes-on-northflank-cloud
- Cloudflare：developers.cloudflare.com/containers/、/containers/concepts/、/workers/reference/how-workers-works/
- CubeSandbox：github.com/TencentCloud/CubeSandbox（docs/architecture/overview.md、docs/guide/pvm-deploy.md）、cubesandbox.com
- Morph：cloud.morph.so/docs/developers、cloud.morph.so/docs/concepts/mental-model、morph.so/blog/infinibranch（web.archive.org/web/20241119213331/）
- CodeSandbox：codesandbox.io/blog/how-we-clone-a-running-vm-in-2-seconds、/cloning-microvms-using-userfaultfd、/how-we-scale-our-microvm-infrastructure-using-low-latency-memory-decompression
- Cua/Lume：github.com/trycua/cua、cua.ai/docs/lume
- microsandbox：github.com/superradcompany/microsandbox、docs.microsandbox.dev/sandboxes/snapshots
- Arrakis：github.com/abshkbh/arrakis
- 我们自己的真机数据：`docs/vm-lifecycle-benchmark.zh-CN.md`、`docs/platform-boundary.md` §9.8（`HARNESS_VM_PHASE_TRACE` 分阶段耗时）
