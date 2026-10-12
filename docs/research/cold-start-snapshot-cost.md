# Firecracker 快照创建成本 & 内存镜像恢复 近零成本调研

> 范围：如何降低 **make-snapshot**（`PUT /snapshot/create`）成本，以及如何让内存镜像（`mem.snap`）恢复接近零成本。
> 约束（我们的真实项目）：单机多租户 AI Agent 平台，每 Run 一台 microVM；Firecracker **v1.17.0**（jailer）；宿主 Ubuntu 22.04 / 内核 6.8.0；`/data` 为 **ext4（无 reflink）**；guest 内核 **4.14.174**；guest 内存 256MB；workspace 128MB；rootfs 256MB；只读共享基础文件 + 只读 rootfs + guest tmpfs；快照池 `/data/harness/snapshots-mt/<templateHash>/{vm.snap,mem.snap}`。
> 标注约定：**[已验证]** = 官方文档/上游源码 v1.17.0 直接读到；**[第三方]** = 厂商博客/第三方评测，未独立复现；**[推测]** = 基于上述事实的推断，需实测。

---

## 0. 我们的基线（实测，作为对比锚点）

| 指标 | 数值 | 备注 |
|---|---|---|
| 热恢复端到端 median / p95 | **101.3ms / 129.6ms** | `copy-snapshot` 已为 0（共享/硬链接） |
| `snapshot-load`（`/snapshot/load` + resume） | **4~7ms** | 恢复侧已经很快，不是瓶颈 |
| 首次冷启动 | **1.33s**（guest 用户态就绪 1.28s） |  |
| 冷启动 + 制作快照总计 | **2.25~2.42s** |  |
| `make-snapshot`（`/snapshot/create` 写 vm.snap+mem.snap） | **908~918ms** | ← 本次要攻的第二段 |
| `vm.snap` | **26KB** | 慢的是 `mem.snap` |
| `mem.snap` apparent / 实占 / 空洞 | **512MB / 512MB / 无** | 全量 → 稠密、零页也写 |

**有效写吞吐**：512 MiB ÷ 0.91s ≈ **560 MiB/s**。这个速度对 NVMe 顺序写偏慢、对纯内存拷贝偏快，**强烈提示耗时主要不在“写数据本身”，而在 `fsync`/回写等待**（见 §5.1）——这是本次调研最关键的判断。

> ⚠️ 数据一致性提示：Firecracker 的 mem 文件大小恒为 `mem_size_mib × 1MiB`（源码 `expected_size = mem_size_mib(self.guest_memory()) * 1024 * 1024`）**[已验证]**。我们观测到 512MB，请确认快照时 `machine_config.mem_size_mib` 到底是 256 还是 512；下文“512MB”一律按实测值叙述。

---

## 1. Diff snapshot：`track_dirty_pages` / `enable_diff_snapshots`

### 1.1 确切语义与 API 字段 [已验证]

**创建时** `PUT /snapshot/create`，body = `CreateSnapshotParams`（`serde(deny_unknown_fields)`，即多传字段会报错）：

| 字段 | 类型/默认 | 说明 |
|---|---|---|
| `snapshot_type` | `"Full"`(默认) \| `"Diff"` | 是否只写自上次快照以来被改写的页 |
| `snapshot_path` | Path | microVM 设备/状态文件（我们的 `vm.snap`，26KB） |
| `mem_file_path` | Path | 客户机内存文件（我们的 `mem.snap`） |
| `sync_snapshot_files` | bool，**默认 `true`**（v1.17 新增） | 是否在返回前对状态文件+内存文件做 `fsync`；**已激活的 virtio-block 后备文件无论此值都会 fsync**。设为 `false` 则不等回写、数据留在 page cache，同机读仍完整，仅失去“宿主崩溃也不丢”的持久性。 |

源码位置：`src/vmm/src/vmm_config/snapshot.rs:41-59`（`CreateSnapshotParams` / `default_sync_snapshot_files() -> true`）、`src/vmm/src/persist.rs:169-230`、`src/vmm/src/vstate/vm.rs:600+`。

**加载时** `PUT /snapshot/load`，body = `LoadSnapshotConfig`：

| 字段 | 类型/默认 | 说明 |
|---|---|---|
| `snapshot_path` | Path | 必填 |
| `mem_backend` | `{ "backend_path": Path, "backend_type": "File" \| "Uffd" }` | 与 `mem_file_path` 互斥 |
| `mem_file_path` | Path（**deprecated**） | 旧字段，等价于 `backend_type:"File"` |
| `enable_diff_snapshots` | bool（**deprecated**） | 与 `track_dirty_pages` 或运算后映射到 `track_dirty_pages` |
| `track_dirty_pages` | bool，默认 `false` | 加载后是否恢复 KVM 脏页日志（决定后续能否做“精确脏页 diff”） |
| `resume_vm` | bool | load 后是否立即 resume |
| `network_overrides` | `[{iface_id, host_dev_name}]` | 恢复后重建 tap 映射 |
| `vsock_override` | `{uds_path}` |  |
| `clock_realtime` | bool | 用 KVM 把 guest 墙钟推进到当前（宿主 ≥5.16） |
| `huge_pages` | `"Snapshot"`(默认) \| `"None"` \| `"Transparent"` \| `"2M"` | `"2M"` 必须配 UFFD |

精确错误串（可直接 grep）：`missing field: either `mem_backend` or `mem_file_path` is required`、`too many fields: either `mem_backend` or `mem_file_path` exclusively is required`；弃用信息：`PUT /snapshot/load: mem_file_path and enable_diff_snapshots fields are deprecated.`（`src/firecracker/src/api_server/request/snapshot.rs`）**[已验证]**。

### 1.2 全量 vs diff 到底写多少 [已验证：源码]

- `snapshot_memory_to_file()`（`src/vmm/src/vstate/vm.rs:600+`）：
  - `Full` → `guest_memory().dump(&mut file)`：**逐页写全部内存（含零页）**，非稀疏 → 这正是我们 512MB 实占、无空洞的原因；随后 `reset_dirty_bitmap()`。
  - `Diff` → 取脏位图后 `guest_memory().dump_dirty(&mut file, &bitmap)`：`src/vmm/src/vstate/memory.rs:442+` 里对连续“干净”页段调用 `writer.seek(SeekFrom::Current(offset))` **跳过去不写** → 生成**稀疏文件**，只有脏页占块。
  - 官方集成测试 `tests/integration_tests/functional/test_dirty_pages_in_full_snapshot.py` 断言：full 与 diff 的 `st_size` 相同，但 `diff.st_blocks < full.st_blocks`；两次连续 diff 的 `st_blocks` 相等（“因为 virtqueue 用到的页总会被标脏”）。
- **脏位图来源两种**（`get_dirty_bitmap()`）：
  1. `track_dirty_pages=true`（启动/加载时）→ KVM dirty log，**精确**：只含自 boot/restore 以来被写过的页；
  2. `track_dirty_pages=false` → 退回 `mincore(2)` 近似（对常驻页取并集，偏保守/偏大）；官方注明 **“only works if swap is disabled”**（`docs/snapshotting/snapshot-support.md`）。**不开脏页日志就没有运行时开销**，但 diff 文件偏大。
- **v1.17 关键增强（自动合并）** [已验证，源码 doc-comment]：若 `snapshot_type=Diff` 且 `mem_file_path` 已存在且大小匹配，则 **diff 会直接就地合并进已有快照**；否则覆盖。也就是说“首次 Full + 之后对同一路径 Diff”**不需要**手工 `snapshot-editor edit-memory rebase`（`rebase-snap` 已弃用）。
- **可否直接恢复 diff** [已验证：官方文档]：diff 通常不能直接 resume，必须与 base 合并；**例外是“刚启动（booted）VM 的 diff 快照，可立即 resume”**。原因（**[推测]**，与源码一致）：diff 稀疏孔洞读出为 0，而未写过的页在 guest 侧本来就是 0；但对于“从快照恢复后再 diff”的 VM，孔洞应为 base 内容而非 0，所以必须合并。
- `track_dirty_pages` **不会被写进快照**：加载时必须再次显式设置才能继续做精确 diff。**开启脏页追踪有 CPU 开销，且官方称会“negate most of the benefits of huge pages”。**
- diff 快照当前是 **developer preview**（官方说正在与 `guest_memfd` 结合）。

### 1.3 禁忌 / 限制

- `/snapshot/create` 只能在 boot 之后；`/snapshot/load` 只能在 boot 之前。
- 快照不能跨“不同内存大小/不同软硬件配置”恢复；状态 sanity check 要求只有单个 plugged DRAM 区。
- 恢复后**网络连通性不保证**；MMDS 数据不持久化；metrics/log 配置不保存。
- guest 熵/唯一 ID：Firecracker 的 **VMGenID 设备总是开启**，resume 时会更新 16 字节 generation ID 并注入中断；但 **Linux 要 ≥5.18 才消费 VMGenID**（重播内核 PRNG）。我们是 **guest 4.14.174 → 完全不消费** ⇒ **“同一快照恢复多次，用户态随机数/ID/token 会重复”这一官方警告对我们完全成立，无法靠 VMGenID 解决**；必须应用层去重。**[已验证：`docs/snapshotting/random-for-clones.md`]**
- cgroup **v1 宿主恢复延迟高**，官方强烈建议 cgroup v2（issue #2129）。

### 1.4 对我们“0.9s”的意义

- **“第二/第三次快照只需写脏页”**：成立。对同一运行中的 VM 反复快照（同一 `mem_file_path`），第二次起只写 dirty，且 v1.17 自动合并。若 VM 基本空闲，脏页可能只有几 MB~几十 MB，相对 512MB 是 **10~100×** 的量级下降。但这只对“反复刷新同一 VM 的快照”有用。
- **对“每个模板只做一次快照”的首次成本**：真正有用的是**把首次快照就做成 Diff**（`snapshot_type:"Diff"`）：
  - 若启动时开 `track_dirty_pages=true` → 只写“自 boot 以来被写过”的页。256MB guest 刚 boot 完通常只有几十 MB 真正被写 ⇒ 字节数约降 2~4×（**[推测]**，需实测）。代价：boot 期间 KVM 脏页日志的 CPU 开销。
  - 若不开 `track_dirty_pages` → 走 mincore 近似：只含常驻页，也有收益、且无运行时开销，但文件偏大且**要求宿主禁用 swap**。
- 结论：**“首次全量+后续 diff”能降低的是重复快照成本；要把“首次 0.9s”降下来，应直接用 `snapshot_type: "Diff"`（配 `track_dirty_pages` 或依赖 mincore）**，而不是先全量。

---

## 2. userfaultfd（UFFD）恢复

### 2.1 v1.17 的确切用法 [已验证：`docs/snapshotting/handling-page-faults-on-snapshot-resume.md` + 示例源码]

两种加载后端：`mem_backend.backend_type` = `"File"` 或 `"Uffd"`。

- `"File"`：由**内核**按缺页把内存文件读进 RAM；`backend_path` = mem 文件路径。**注意：这条路径本身就是惰性的**——`src/vmm/src/vstate/memory.rs::snapshot_file()` 用 `libc::MAP_PRIVATE` 把 `mem.snap` 映射进来，缺页时从 page cache 读并按 CoW 复制到匿名页；**不会**一次性读完整个文件。**[已验证：源码]** 所以“File 后端 = 急加载”是常见误解。
- `"Uffd"`：把缺页处理搬到**用户态进程**。`backend_path` = **一个 Unix domain socket 路径**（不是文件）。流程：
  1. 你自己写的 page-fault handler 先 `bind`+`listen` 该 UDS；
  2. Firecracker 发 `PUT /snapshot/load`，body 里指定 `mem_backend:{backend_path:"<uds>",backend_type:"Uffd"}`；
  3. Firecracker 自己创建 UFFD 对象（宿主 5.10 用 `userfaultfd(2)` syscall；6.1 用 `/dev/userfaultfd` 设备，jailer 会自动把它放进 jail；非 jailer 需自行 `setfacl -m u:$USER:rw /dev/userfaultfd`）；
  4. handler 私有 mmap 整个 guest memory 文件；
  5. Firecracker 匿名 mmap 内存区并注册到 UFFD，然后 **connect UDS**，把 **UFFD fd（经 `SCM_RIGHTS`）+ 每个内存区的 `base_host_virt_addr / offset / page_size`(JSON) 发过去**（示例：`src/firecracker/examples/uffd/uffd_utils.rs` 的 `GuestRegionUffdMapping` 与 `send_with_fd`）；
  6. 之后 UDS 不再通信；每次缺页由 handler 用 **`UFFDIO_COPY`** 把页填进 guest 内存。官方 on-demand 示例 `on_demand_handler.rs` 的行为是“**把该地址所属的整个 region 读进来**”（粒度粗、但简单）；`fault_all_handler.rs` 则是把所有页一次性填好。
- **jailer 要求**：handler 进程、UDS、mem 文件都必须位于 jail 内，且 UDS 只对 Firecracker 与 handler 可见。
- **balloon 交互**：balloon 触发 `MADV_DONTNEED` 时 UFFD 会送 `UFFD_EVENT_REMOVE`，handler **必须把对应页清零**（不能从文件回填），否则 inflate/deflate 后读到脏数据。
- **风险**：handler 崩了而 Firecracker 正在 resume → **Firecracker 会永久 hang**（设计上会一直等这一页）。官方要求自带超时/监控/回收机制，并可用 `SO_PEERCRED` 取对端 PID。
- **huge_pages 与 UFFD**：`"2M"` hugetlbfs **必须** UFFD（配 `"File"` 直接报错）；`"Transparent"` 可配 UFFD，但官方说 **UFFD 会限制 THP 效果**；`docs/hugepages.md` 明确“THP 不参与 UFFD，resume 期间不会分配 THP”。

### 2.2 对我方收益评估

- **对首次恢复**：UFFD 本身不减少“必须读的字节”；它是把“谁来服务缺页”换掉。真正的收益来自 handler **可以做额外的事**：压缩块惰性解压、跳过零页、按优先级预取、甚至从网络拉页（CodeSandbox/Modal）。不写 handler 的裸 UFFD 收益有限甚至负收益（多了进程切换）。
- **对多 VM 并发恢复**：`"File"` 后端下 N 台 VM 用 `MAP_PRIVATE` 映射**同一个 `mem.snap` inode**，page cache 天然共享（一份物理页，N 份 CoW）⇒ 并发恢复的 I/O 已被均摊，**不需要 UFFD**。UFFD 并发的主要瓶颈会变成 handler 的解压 CPU。
- **对快照创建成本**：**无影响**。`create_snapshot()` 路径完全不涉及 UFFD（UFFD 只在 load 出现）。**[已验证：源码]**
- **能否“把 mem.snap 省掉 / fork 运行中的 VM”**：上游 Firecracker **没有 live-fork**：必须 pause → create snapshot → 再从快照 clone（多 VM 共享同一个只读 base）。要“免内存镜像”只能走**文件系统快照**路线（E2B 的 filesystem-only snapshot、CubeSandbox 规划的 filesystem-only snapshot），即放弃内存状态、恢复时从磁盘冷启——**这与我们“热恢复 100ms”的目标相反**，除非只用于模板构建阶段。
- 我们的 256MB / 101ms 场景：**UFFD 的 ROI 低**。它值得做的唯一理由是“给 mem.snap 加压缩/去零”（§3），而不是为了恢复速度。

---

## 3. 内存镜像压缩 + 惰性解压

### 3.1 CodeSandbox（最完整的公开实现）[第三方：codesandbox.stream/blog/how-we-scale-our-microvm-infrastructure-using-low-latency-memory-decompression]

做法（值得抄的部分，按顺序）：

1. **先整文件 zstd**：8GiB 快照 → **412MiB（≈20×）**，但整文件解压要 **4~10s**，不可接受。
2. **分块 + lz4 惰性解压**：把内存切成 **8KiB chunk**（试过 4/8/16/32/64/128/2MiB，8KiB 是解压粒度 vs 元数据开销的最优），lz4 压缩 → 8GiB → **745MiB（≈10×）**；handler 只解压“缺页所在的那个 8KiB chunk”并 `UFFDIO_COPY`。
3. **去稀疏化（关键坑）**：最初把 hole 按原页偏移对齐（真稀疏文件）；但宿主是 **btrfs，稀疏文件随机读很慢** → 改成“**所有 chunk 连续排布 + 文件尾部放 manifest**（magic `UFFD` 后跟全页映射表）”。manifest 示例 **9820.25 KiB，加载 37.78ms**。
4. **跳过全零 chunk**：`if data.iter().all(|&b| b==0) → SerializationInfo::Uninitialized`（不占空间）；一台 16GiB VM 有 **13.10GiB** 属于全零。
5. **选择性压缩**：压缩率不佳的 chunk（压缩后 ≥ 原大小 50%）直接原样存，减少解压 CPU（代价：文件 725→921MiB）。
6. **页类型**：`Uninitialized` / `File`(未压缩 4KiB) / `ZstdCompressedFile{compressed_size_bytes}` / `Lz4CompressedFile{compressed_size_bytes}`。
7. **内存回收**：给他们的 Firecracker fork 加了 **Free Page Reporting**（commit `codesandbox/firecracker#11` 的 `84c87c39…`），快照前 inflate balloon 清 page cache；handler 监听“被释放的页”并标 `Uninitialized`。
8. **实测**：16GiB VM → 落盘 **1.5GiB**（原始 3GiB）；组成：lz4 527035 页(2.01GiB)→587MiB、Uninitialized 3434412 页(13.10GiB)、未压缩 File 232857 页(909MiB)。
9. **吞吐数字**：朴素逐页惰性读 82.21MiB/s（→4s）；去稀疏化后 260.13MiB/s（→**1s** 量级）。
10. **最终成绩**：VM resume **avg 400ms、P99 2s、P01 ~150ms**；约 **2.5M 次/月**。
11. **失败尝试**（省得我们再踩）：zstd+字典 与 lz4 解压速度相当 → 弃用；**预测式预解压**（eagerly decompress 预测页）引入线程同步，几乎无收益 → 弃用。

> 对 256MB guest 而言：20× 只存在于“Next.js 大镜像”；我们能指望的是 **去零 + 2~3× 压缩**。且**压缩主要省的是磁盘/网络与内存占用，对 create 时间未必是净赚**（多了一次压缩 CPU），除非在“写盘前压缩”且有富余 CPU。

### 3.2 Modal [第三方：modal.com/blog/mem-snapshots（2025-01-28）+ frontend.modal.com/docs/guide/vm-memory-snapshots]

- **路线是“进程级/gVisor”，不是 Firecracker VM 快照**：Modal 出于安全用 **gVisor `runsc`**，其 checkpoint/restore 是 **CRIU 思想的用户态内核实现**（gVisor `kernel.go` + 各组件 `save_restore.go`）。
- 快照 = 整个进程树的 **内存映射 + fd 表 + 寄存器 + 环境变量 + PID** + 文件系统改动；**不含活跃网络连接与 GPU 状态**（GPU 状态必须 resume 后再建）。
- 性能：**约 2.5× 于普通容器启动**。`import torch` 例：冷启 ~5s → 快照恢复 **p50 1.05s / p0 0.69s**；Stable Diffusion 推理 13s → **3.5s**。
- 机制：pages 文件通常 **100MiB~10GiB**，gVisor **后台按优先级加载缺页**（先满足阻塞页），FUSE 文件服务**激进预加载**整个 pages 文件进 page cache；最坏情况缺页要等一次“网络读”（几十 ms）。
- 痛点：恢复期 CPU stall 达 ~900/ms/s；网络尾部吞吐不稳。
- **兼容性铁律**（对我们直接适用）：快照与 **CPU 特性集、NVIDIA 驱动版本、容器运行时版本** 绑定；Modal 按宿主/机型**多次打快照**（例：`g6.12xlarge` 不支持 `pclmulqdq`，不能用别的主机打出的快照），restore 失败时**自动回退冷启动**。
- **熵警告**：“resumed state 会被反复复用，expectations of entropy may be violated”。

### 3.3 Fly.io [第三方：docs.fly.io/reference/suspend-resume]

- Fly Machines 的 suspend 用 **Firecracker 快照**把**完整状态含内存**存到持久存储；start 时从快照恢复而非冷启。
- 量级：suspend→resume **几百 ms**；冷启动 **~2s+**。要求：**内存 ≤2GB**（更大内存 suspend 更慢，不推荐）、**禁用 swap**、机器需 2024-06-20 后更新过。
- 限制：不推荐一次 suspend 很多机器；**快照不保证持久**（新版本 deploy、宿主迁移、文件损坏、维护 → 直接退回冷启动）；suspend **不重置 rootfs**；时钟可能落后几秒直到 NTP。
- API：`POST /v1/apps/{app}/machines/{id}/suspend`，注释称下次启动 “attempt (but is not guaranteed) to resume from a snapshot”。

### 3.4 Morph（Infinibranch）[第三方：cloud.morph.so/docs]

- **分支/快照是产品核心**：快照捕获 **disk + memory**；“New instances branch from it”，宣称 **sub-second VM startup**。
- `/docs/documentation/instances/snapshot-setup`：链式 `.setup()` 每步结果缓存为一个快照，重复步骤跳过。
- `/docs/documentation/instances/branch`：`instance.branch(count=3)` → 1 次快照 + N 个 clone；用于并行测试/ML。
- `/docs/examples/snapshot-build-caching`：`Snapshot.build(recipe)` 把快照当 **Docker layer**（digest 寻址，复用最长已缓存前缀）。
- SDK：`client.snapshots.create(vcpus, memory, disk_size, digest)`。**官方文档未给出 make-snapshot / resume 的 ms 级数字**；GitHub 上 fork 未公开（`morph-labs/infinibranch` 404）。

### 3.5 CubeSandbox（腾讯，**不是 Firecracker**）[第三方：github.com/TencentCloud/CubeSandbox + cubesandbox.com 基准博客]

- 基于 **RustVMM + KVM**（非 Firecracker），有自研 **CubeCoW CoW 快照引擎**（v0.3.0）。
- 数字：**冷启 <60ms**（单并发 60ms；**50 并发 avg 67ms / P95 90ms / P99 137ms**）；每沙箱内存开销 **<5MB**（内核共享 + CoW）；2GiB 沙箱空闲仅 ~30MB；PVM 云服务器基准：串行 ~67ms（min 55.9 / P95 78.2），10 并发 avg 170.9ms，20 并发 avg 364.6ms。
- 机制要点：**模板 + 资源池 + 快照克隆跳过全部冷启**；磁盘 CoW 用 **reflink（XFS）**；内存追踪用 **soft-dirty（`/proc/PID/clear_refs`）**；新沙箱脏页约 **8MB**（“PagemapAnon snapshot saved”）。快照请求按单沙箱串行化。
- 规划中：**Filesystem-Only Snapshots**（只快照可写文件系统，不 dump 内存），以及 S3 跨节点 pause/resume。

### 3.6 稀疏性 / 零页 / THP / `MAP_PRIVATE` 对我们 mem.snap 的影响

- **当前 mem.snap 512MB 实占、无空洞 = 全量快照的必然结果**（`dump()` 逐页写，零页也写）。**[已验证：源码+集成测试]**
- **让 mem.snap 变稀疏的官方途径**：`snapshot_type:"Diff"`（dirty/mincore）+ v1.17 自动合并。**“跳过零页”上游没有**，要么 diff，要么自研（CodeSandbox 式零 chunk 检测）。
- **THP / hugepage**：`huge_pages:"Transparent"` 走 `madvise(MADV_HUGEPAGE)`，guest 内存须为 2MB 倍数；`"2M"` hugetlbfs 需 UFFD 且能**把 boot 时间最多改善 ~50%**（Firecracker 自家 boottime 测试）；但 **UFFD 与 THP 不兼容**，且 **开 `track_dirty_pages` 会抵消 huge page 的大部分好处**。
- **`MAP_PRIVATE`**：guest 内存是 `MAP_PRIVATE|MAP_ANONYMOUS`；恢复时 `mem.snap` 也是 `MAP_PRIVATE` 映射 ⇒ 读是共享 page cache、写时 CoW 到匿名页，**不会写回 mem.snap**。因此**恢复期不会产生额外写盘**；`MAP_PRIVATE` 也没有减少 create 时的写量（create 走 `dump()` 全量）。
- **balloon / free page reporting**：guest 可通过 virtio-balloon `free_page_reporting` 持续报告空闲页，Firecracker 对其实施 `MADV_DONTNEED`（RSS 下降、页被清零），从而**在快照前把页“变没”**——配合 diff 可显著缩小 mem.snap。需要 guest 内核 `PAGE_REPORTING`；我们 guest 4.14.174 需确认配置，且该功能需 Firecracker pre-boot 开启。**[已验证：`docs/ballooning.md`]**

---

## 4. CRIU（进程级）vs Firecracker（VM 级）

| 维度 | CRIU / gVisor 进程级 | Firecracker VM 快照 |
|---|---|---|
| 代表 | **Modal**（gVisor runsc，CRIU 思想）；`runc`+CRIU 生态 | **Fly.io、CodeSandbox、E2B、Morph、我们** |
| 捕获单位 | 进程树：内存映射/fd/寄存器/env/PID/挂载 | 整机：vCPU/设备模型（`vm.snap`）+ 客户机物理内存（`mem.snap`） |
| 首次启动 | 容器启动（Python import torch 约 5s，走 26000 次 syscall） | VM 冷启动（我们 **1.33s**） |
| 后续恢复 | **p50 1.05s / p0 0.69s**（torch 例），相对冷启 ~2.5× | 我们 **101ms**（load 本身 4~7ms）；Fly 几百 ms |
| 快照创建成本 | 冻结进程并序列化内存（Modal 未公开 ms） | 我们 **0.9s**（本次目标） |
| 主要坑 | 与 CPU 特性/驱动/运行时版本强绑定；活跃网络连接丢失；熵复用 | 与宿主内核/机器型号强绑定；guest 熵（<5.18 无 VMGenID）；网络不保证 |
| 结论 | 换 VMM/运行时级别的方案，**不适用于我们**（我们已经是 VM 级、且恢复更快） | 应在既有 Firecracker 上优化 |

**行业事实**：VM 快照阵营（Fly/CodeSandbox/E2B/Morph/我们）恢复普遍 **百 ms 级**；进程级阵营（Modal）在“大 Python 进程、冷启动 5s”场景收益最大（2.5×），但绝对时间（~1s）仍慢于 VM 快照。E2B 明确区分 **snapshot（1→N 克隆，含内存）vs pause/resume（1→1）**，并提供 **filesystem-only snapshot**（更小更快，但恢复是“从盘冷启”而非内存恢复）。**[第三方：e2b.dev/docs/sandbox/snapshots]**

---

## 5. 写盘侧优化：怎么把 908ms 打下来

### 5.1 第一优先：`sync_snapshot_files: false`（v1.17 精确字段名）

- 语义：`PUT /snapshot/create` 的 **`"sync_snapshot_files": false`** 会让 Firecracker **不等 `fsync` 回写就返回**（状态文件与 mem 文件）；数据仍在宿主 **page cache**，**同机后续读（含 `/snapshot/load`）依然完整**，只是**失去“宿主崩溃后仍能恢复”的持久性**。**[已验证：`CreateSnapshotParams` 源码 + docs]**
- 我们 908ms @ 512MB ≈ 560MiB/s，**与“等 fsync 落 ext4”高度吻合**；关掉后预计只剩内存拷贝/进 page cache 的时间 ⇒ **[推测] 可去掉 50~70% 的耗时**。
- **唯一残留**：官方注明“**已激活的 virtio-block 设备的后备文件无论此值都会 fsync**”。我们有 workspace（128MB）virtio-blk ⇒ 仍会 flush 一次。**这就解释了为什么不能指望降到 0**，也提示下一步应实测“workspace block fsync 占多少”。
- 风险与缓解：宿主崩溃/重启会丢这个刚写的快照 → **快照池必须可重建**（我们有模板 + 硬链接基础件，可后台重建）；建议写完立刻 `rename` 到正式路径 + **后台异步补一次 `fsync`**（让前台快、后台持久）。

### 5.2 其它手段

- **Diff 首次快照**（§1.4）：直接减少要写的字节数（跳过未触碰/未常驻页）。
- **写到 tmpfs（RAM-backed）再后台落盘**：Firecracker 对 `mem_file_path` 只是普通 `File` + `write_all_volatile`，**可以指向 tmpfs**（如 `/dev/shm` 或专用 tmpfs），此时写=内存拷贝、`fsync` 近乎无操作 ⇒ 最快；风险：**每模板多占 256~512MB RAM**、宿主重启丢失、且 jailer 下路径必须仍在 jail 内。可与“后台 `cp`/`rename` 到 `/data`”组合。**[已验证：源码确认无 O_DIRECT/特殊要求；tmpfs 路线为推测]**
- **`posix_fadvise` / `O_DIRECT`**：**Firecracker 没有**这些可调项，快照写路径不暴露；不要指望通过它们优化（换 VMM/fork 才可能）。
- **避免重复截断**：`snapshot_memory_to_file()` 只在“文件已存在且大小 != 期望值”时才 `set_len(0)` 再 `set_len(expected)`；保持 `mem.snap` 尺寸稳定可省一次截断/清零。
- **hugepages（`"2M"`）**：主要收益是 boot 时间最多 −50%，对“写盘量”无直接帮助，且需要 UFFD + 预分配 hugetlb 池。
- **在 create 前 reclaim**：inflate balloon / 让 guest 释放 page cache → 页变零、未被 mincore 认为常驻 ⇒ diff 更小（需 4.14 guest 支持，**[推测]**）。
- **不让用户等**：把 make-snapshot 移出 critical path（见 §6.5）。

---

## 6. 结论：针对我们约束（256MB guest / ext4 / FC v1.17 / 不能重分区）的排序路线

### 6.1 排序（预期收益 / 实现难度 / 风险）

| # | 动作 | 预期收益（make-snapshot 908ms→） | 难度 | 风险 | 依据 |
|---|---|---|---|---|---|
| **1** | `/snapshot/create` 加 **`"sync_snapshot_files": false`** | **[推测] ~200~400ms** | 极低（1 个 JSON 字段） | 宿主崩溃丢该快照 → 后台重建/补 fsync | [已验证 API] |
| **2** | 首次快照就用 **`snapshot_type:"Diff"`**；boot 时开 **`track_dirty_pages:true`**（或不开、走 mincore） | **[推测] 再省 1.5~3×**（写量→几十~120MB） | 中（改启动配置 + load 时重设 `track_dirty_pages`） | 脏页日志 CPU；diff 不可直接 resume 的边界；mincore 要求禁 swap | [已验证源码] |
| **3** | `mem_file_path` 指向 **tmpfs**（/dev/shm 或专用 tmpfs），后台落到 `/data` | **[推测] create ≈ 内存拷贝 (~100~200ms)** | 中（挂载/权限/jailer 路径/同步逻辑） | RAM 占用、重启丢失、竞态 | [推测] |
| **4** | **预热快照池**：模板发布/空闲时后台生成，Run 时只 load | 用户侧 **≈0**（甚至只剩 4~7ms load） | 中（调度、失效、版本 hash） | 存储/内存成本 | [逻辑结论] |
| **5** | UFFD + 压缩块惰性解压（CodeSandbox 式，含跳零页） | 主要省**磁盘/内存占用与恢复**，对 create 帮助有限 | 高（自研 handler/格式，v1.17 支持 UFFD 但压缩要自己做） | handler 崩溃→Firecracker 永久 hang；复杂度高 | [第三方] |

**1+2+3 组合 [推测] 有希望把 make-snapshot 压到 ~100~200ms**；但**要真正“让用户永远不感知”，应同时做 #4**（把成本移到后台），因为首次冷启动 1.33s 本身无法消除。

### 6.2 只能在“换文件系统 / 换快照机制 / 换 VMM”后才可能

- **磁盘 reflink/CoW 快照**（`cp --reflink`、XFS/btrfs）⇒ 我们 **ext4 做不到**（CubeSandbox 用 XFS reflink；E2B 也有 filesystem-only snapshot）。若上游要求不动分区，只能放弃这条。
- **上游 Firecracker 的“全量快照自动跳过零页/稀疏化”**：不存在；需 **diff 模式**（官方）或 **自研 fork**（CodeSandbox 版）。
- **内存镜像压缩 + 惰性解压**：上游只给 UFFD 原语，压缩格式与零页处理**必须自研**（或换 Morph/CodeSandbox 式 fork）。
- **运行中 VM 的真正 fork**（不 pause 直接分支）：上游**没有**；只能 pause+snapshot+clone（Morph 把它产品化了，但是自家 fork）。
- **VMGenID 帮 guest 4.14 解决熵复用**：不可能，需 **guest 内核 ≥5.18**（我们 4.14.174）⇒ 要么应用层去重，要么升级 guest 内核。
- **`guest_memfd` 相关新快照路径**：v1.17 仍在“developer preview 与 guest_memfd 结合”阶段，短期不可依赖。

### 6.3 明确不建议

- 为了“恢复更快”上 UFFD：我们 load 已 4~7ms、File 后端本来就是 `MAP_PRIVATE` 惰性加载，收益趋近于 0，复杂度陡增（还会引入 hang 风险）。
- 整文件 zstd：CodeSandbox 实测解压 4~10s，反而毁掉恢复。

### 6.4 待实测验证（下一步）

1. `sync_snapshot_files:false` 后 make-snapshot 实测值；其中 **virtio-blk 后备文件 fsync 占多少**（把 workspace 块设备临时换成空/只读对比）。
2. 确认快照时 `mem_size_mib`（256 还是 512）与 `mem.snap` 大小的对应。
3. `snapshot_type:"Diff"` + `track_dirty_pages:true` 首次快照：记录 `st_blocks` 与耗时；并实测**该 diff 能否直接 `/snapshot/load`**（docs 说 booted VM 的 diff 可立即 resume，需实证）。
4. tmpfs 池 make-snapshot 与 RAM 占用曲线。
5. 开 `track_dirty_pages` 对冷启动 1.33s 的影响（脏页日志 CPU）。

---

## 附：来源清单

**官方（Firecracker v1.17.0，[已验证]）**
- `docs/snapshotting/snapshot-support.md` — 快照类型/加载/限制/版本兼容/时钟/vsock
- `docs/snapshotting/handling-page-faults-on-snapshot-resume.md` — UFFD 完整流程（本文 §2）
- `docs/snapshotting/random-for-clones.md` — VMGenID / 熵复用
- `docs/hugepages.md` — THP/2M/与 UFFD、快照的关系
- `docs/ballooning.md` — balloon / free page reporting / MADV_DONTNEED 清零
- `src/vmm/src/vmm_config/snapshot.rs` — `CreateSnapshotParams`/`LoadSnapshotParams` 字段与默认值
- `src/firecracker/src/api_server/request/snapshot.rs` — 精确错误串/弃用信息
- `src/vmm/src/persist.rs` — `create_snapshot()` / `guest_memory_from_file()`
- `src/vmm/src/vstate/vm.rs` — `snapshot_memory_to_file()` / `get_dirty_bitmap()` / `mincore_bitmap()`
- `src/vmm/src/vstate/memory.rs` — `dump()` / `dump_dirty()`（seek 跳空页）/ `snapshot_file()`（`MAP_PRIVATE`）
- `src/firecracker/examples/uffd/{on_demand_handler.rs,fault_all_handler.rs,uffd_utils.rs}`
- `tests/integration_tests/functional/test_dirty_pages_in_full_snapshot.py`、`test_snapshot_not_losing_dirty_pages.py`
- URL 前缀：`https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/` 与 `.../raw/v1.17.0/`

**厂商博客 / 第三方（[第三方]，未独立复现）**
- CodeSandbox：`https://codesandbox.stream/blog/how-we-scale-our-microvm-infrastructure-using-low-latency-memory-decompression`
- Modal：`https://modal.com/blog/mem-snapshots`、`https://frontend.modal.com/docs/guide/vm-memory-snapshots`
- Fly.io：`https://docs.fly.io/reference/suspend-resume`、`https://docs.fly.io/api/machines/machines/suspend-machine`
- Morph：`https://cloud.morph.so/docs/documentation/instances/branch`、`.../snapshot-setup`、`https://cloud.morph.so/docs/examples/snapshot-build-caching`、`https://cloud.morph.so/docs/blog/developers`
- CubeSandbox：`https://github.com/TencentCloud/CubeSandbox`、`https://cubesandbox.com/blog/posts/2026-06-03-cubesandbox-perf-benchmark-pvm`
- E2B：`https://e2b.dev/docs/sandbox/snapshots`
- Hocus（Firecracker 无动态内存回收的批评）：`https://hocus.dev/blog/qemu-vs-firecracker`

