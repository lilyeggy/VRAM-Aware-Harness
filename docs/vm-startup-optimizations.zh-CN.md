# microVM 启动加速记录（冷启动 / 快照恢复）

本文件是**持续累积**的优化台账：每次改动 VM 启动路径（冷启动、快照制作、快照恢复、
握手、目录准备、回收）都必须在这里加一条，写清"背景 / 机制 / 代码 / 真机实测 / 代价 /
提交"。横向调研（各家 sandbox 怎么做到毫秒级）见 `docs/agent-sandbox-landscape.zh-CN.md`，
基准脚本与早期数字见 `docs/vm-lifecycle-benchmark.zh-CN.md`。

## 0. 记录规则

1. 一条优化 = 一个条目：**背景**（哪个阶段慢、为什么）、**机制**（改了什么、为什么这样改）、
   **代码**（文件/函数/环境变量）、**实测**（真机 172.17.43.193，jailer + Firecracker v1.17.0，
   1 冷 + N 热，median/p95）、**代价**（对 guest 语义、安全或运维的影响）、**提交**（commit）。
2. 数字必须来自真机，且注明配置（内存大小、rootfs 大小、是否 jailer、是否共享）。
3. 结论变化时**在原条目内更正**并注明（例：O3 对"内存镜像能否共享"的更正），不要静默改写历史。

## 1. 启动路径地图

一次 Run 的 VM 生命周期（阶段名与 `HARNESS_VM_PHASE_TRACE=1` 打印的 `[vm-phase]` 一致）：

```
Run 准入(policy/RESOURCE) → sandbox.create
  ├─ 冷启动路径（快照池无匹配 templateHash）
  │    copy-disks（kernel+rootfs+workspace 拷进 VM 私有目录，jailer 下为 chroot）
  │    chown-chroot → spawn-process（firecracker/jailer）→ api-socket-wait
  │    api-config-cold（PUT /boot-source /drives /vsock …）→ instance-start
  │    vsock-handshake（guest 内核启动 + busybox init + socat/agent 就绪）
  │    make-snapshot（PUT /snapshot/create：把 guest 内存 + 磁盘状态落盘）
  │ └→ 快照池出现 <templateHash>/{vm.snap,mem.snap}
  └─ 快照恢复路径（池中有匹配 templateHash）
       copy-disks → chown-chroot → spawn-process → api-socket-wait
       copy-snapshot 或 share-snapshot → snapshot-load（PUT /snapshot/load + resume）
       → vsock-handshake（guest 已在快照里 boot 完成，只剩重连握手）
工具执行（vsock exec）→ 收尾（workspace 导出、artifacts、sandbox.terminate）
```

关键事实：`templateHash = sha256(kernel size+mtime | rootfs size+mtime | agentVersion)`，
所以改内核、rootfs 或 agent 版本都会让旧快照自然失效。

## 2. 已实施优化

### O1 修复 `warmHit` 恒为 false（2026-10-11，提交 `aab6b10`）

- 背景：`SANDBOX_ACQUIRED` 事件里的 `warmHit` 永远是 `false`，无法判断一次启动到底走了冷启动还是
  快照恢复，所有"加速"结论都不可验证。
- 机制：驱动 `create()` 把 `warmHit: canRestore`（快照池命中）回传给 provider，
  provider 不再硬编码 `warmHit: false`；`MockMicrovmDriver` 增加 `setWarmHit`。
- 代码：`src/sandbox/microvm/firecracker-sandbox-driver.ts`、`microvm-sandbox-provider.ts`、
  `microvm-types.ts`、`mock-microvm-driver.ts`。
- 测试：`tests/sandbox/microvm-sandbox-provider.test.ts`（"如实回传 warmHit"）。

### O2 分阶段耗时埋点（2026-10-11，提交 `35c4b42`）

- 背景：只知道"热恢复 ~0.5s"，不知道时间花在哪，无法判断该优化什么。
- 机制：`HARNESS_VM_PHASE_TRACE=1`（默认关、零开销）在驱动里给 11 个阶段打
  `[vm-phase] <sandboxId> <phase> <ms>`：`copy-disks`、`chown-chroot`、`spawn-process`、
  `api-socket-wait`、`api-config-cold`、`vsock-handshake`、`copy-snapshot`、`snapshot-load`、
  `make-snapshot`、`share-base`、`share-snapshot`、`total`。
- 实测（6 次热恢复，512MB guest，全部复制）：`total ~490ms` = `copy-snapshot 298` +
  `copy-disks 110` + `vsock-handshake 53` + `api-socket-wait 20` + `snapshot-load 6~7` +
  `spawn 1~3` + `chown 1~2`；冷启动首建 `total 2776ms` = `vsock-handshake 1325` +
  `make-snapshot 1290` + 其余。
- 结论：**Firecracker 自己的恢复（`snapshot-load`）本来就只有 6~7ms**，端到端 0.5s 里
  九成是驱动自己做的拷贝。
- 代码：`src/sandbox/microvm/firecracker-sandbox-driver.ts`（`phaseTrace` + `tracePhase`）；
  测试 `tests/sandbox/vm-phase-trace.test.ts`。

### O3 共享只读基础文件（硬链接替代拷贝）（2026-10-12，提交 `578e132`）

- 背景：O2 显示 `copy-snapshot`（512MB 内存镜像拷进 VM 私有目录）304ms + `copy-disks`
  102ms，占了热恢复的 8 成。
- 机制：Firecracker 官方 `docs/snapshotting/snapshot-support.md` 明确
  "The design allows sharing of memory pages and read only disks between multiple microVMs"：
  加载快照时对内存文件做 **MAP_PRIVATE 只读映射 + 按需分页**，写入落到 COW 匿名内存，
  只要求该文件在 VM 存活期间**不可变**。因此可以多台 VM 硬链接同一份内核/rootfs/快照文件，
  前提是"共享文件永不被原地修改"。
  - 内核、`vm.snap`、`mem.snap`、`rootfs.ext4` 由驱动硬链接进各 VM 目录（跨设备自动退化为复制）。
  - 工作区盘（每 VM 私有、可写）仍然复制。
  - 快照制作改成 staging 目录 + `publishStaging()` 原子发布（先 `rmSync` 旧目录再 `renameSync`），
    这样"正在被其它 VM 映射读取的旧 inode"内容不会被改动。
  - 开关：`HARNESS_VM_SHARE_BASE_FILES`（默认开，`0` 关）、`HARNESS_VM_SHARE_ROOTFS`（默认关，`1` 开）。
- 代码：新增 `src/sandbox/microvm/shared-base-files.ts`
  （`SHARED_BASE_FILE_MODE = 0o444`、`shareBaseFile(src, dst, {link?, fallbackCopy?, mode?})`），
  `vm-snapshot-manager.ts`（`createStagingDir`/`stagingSnapshotPaths`/`publishStaging`/`discardStaging`），
  `firecracker-sandbox-driver.ts`（`shareBaseFile` 调用点、`share-base`/`share-snapshot` 埋点、
  `is_read_only: sharedRootfsReadOnly`）。
- 实测（每个配置 1 冷 + 10 热，`HARNESS_BENCH_EXEC_PROBE=true`）：

  | 配置 | 热恢复 median | p95 | 首次（冷启动+建快照） | 恢复后 guest 执行 `uname -r` |
  | --- | --- | --- | --- | --- |
  | 全部复制（legacy） | 498.3ms | 517.0ms | 2767ms | 11.5ms |
  | 共享基础文件（默认） | **175.9ms** | 196.2ms | 2755ms | 11.4ms |
  | 再加 rootfs 共享（可选） | **101.3ms** | 118.7ms | 2639ms | 10.6ms |

  分阶段：`copy-snapshot` 304 → 0 → 0ms；`copy-disks` 102 → 87 → 14ms；
  `snapshot-load` 7 → 4 → 4ms；`vsock-handshake` 56~59ms；`api-socket-wait` 21ms。
  生产（systemd + broker + jailer，默认配置）`SANDBOX_ACQUIRED {durationMs: 202, warmHit: true}`，
  清池后首台 `{durationMs: 2440, warmHit: false}`。
- 代价与踩坑（真机，必须记住）：
  1. 硬链接要求**同一文件系统**，否则 EXDEV 静默退化为复制（生产已把内核/磁盘模板放到
     `/data/harness/images/`，与运行时根同盘）。
  2. **绝不 chmod 硬链接出来的模板**：共用 inode，rootfs 变 0444 后，走复制路径的 VM 的盘
     继承 0444，而 Firecracker 对 `is_read_only: false` 的盘以 O_RDWR 打开 →
     `Drive config error … Permission denied (os error 13) /rootfs.ext4`。故 `mode: 0444`
     只用于驱动自有、可重建的快照文件。
  3. rootfs 只读标志必须跟随"是否请求共享"，不能跟随"硬链接是否成功"（否则 0444 文件 + RW 盘同样 EACCES）。
  4. 共享 rootfs 时 guest 内除 `/workspace` 外只读：实测写 `/tmp` 失败
     `sh: can't create /tmp/harness-probe: Read-only file system` → 需要 tmpfs（见 O4）。
- 更正记录：本节最初（2026-10-12 早）写的是"硬链接内存镜像不安全：Firecracker 以可写方式
  mmap，多 VM 共享 inode 会串写"。该结论**错误**，已被官方 `snapshot-support.md` 原文推翻，
  见 b332/`docs/agent-sandbox-landscape.zh-CN.md` §4。本条目保留更正痕迹。

### O4 rootfs 共享 + guest tmpfs（2026-10-12，提交 `cb47f73`）

- **背景**：热恢复里 `copy-disks` 仍有 87ms，全是 rootfs.ext4（256MB）的整块复制。
- **机制**：`HARNESS_VM_SHARE_ROOTFS=1` 时 rootfs 也走硬链接共享（只读），`sharedRootfsReadOnly` 决定 `/drives/rootfs` 的 `is_read_only`。rootfs 只读后 guest 写 `/tmp` 会 EROFS，因此 guest 镜像的 `/etc/inittab` 在 sysinit 段加 `mkdir -p /tmp /run /var/tmp` + 三个 tmpfs 挂载（`/tmp` mode=1777,size=64m；`/run` mode=755,size=16m；`/var/tmp` mode=1777,size=32m）。构建脚本 `scripts/microvm/build-guest-rootfs.sh` 已带上这段；生产镜像 `/data/harness/images/rootfs.ext4` 用 debugfs 原地打补丁（备份 `/data/harness/images/rootfs.ext4.bak-tmpfs`）。
- **实测**（172.17.43.193，jailer + Firecracker v1.17.0，256MB guest，共享开）：
  - 热恢复（benchmark stageB，n=10）：median **101.3ms** / p95 118.7ms；`copy-disks` 102ms → **14ms**（只拷可写工作区盘）。
  - guest 可写性：`bash -c "uname -r && df -h /tmp && cp result.txt /tmp/r.txt"` → `4.14.174` + `/tmp` 64MB tmpfs + 写成功；未打 tmpfs 补丁时同一命令报 `sh: can't create /tmp/harness-probe: Read-only file system`。
  - 冷启动不受影响（首台 `SANDBOX_ACQUIRED.durationMs` 2375ms，与未共享时 2440ms 同量级）。
- **代价 / 回退**：guest 除 `/workspace`、`/tmp`、`/run`、`/var/tmp` 外不可写（`pip install` 到 site-packages、编译缓存会 EROFS）。回退 = 去掉 `HARNESS_VM_SHARE_ROOTFS=1` 并**清空快照池**（只读语义固化在黄金 VM 的 drive 配置里，旧快照恢复出来仍是旧语义）。
- **附带修复**：per-IP 限流默认值 120 → **1200**（`src/app/harness-config.ts`）。实验室 10-20 人共用一个 NAT 出口 IP 时，120/min 会把正常使用打成 429（真机 p0 smoke 首轮即 `注册失败 HTTP 429`）。

### O5 首次冷启动拆解 + 服务启动预热（2026-10-12）

- **背景**：O4 之后热恢复已 ~0.1s，用户问"首次冷启动能不能也快"。冷启动 = 池空时的第一次 create，≈2.2~2.4s（snapshot 模式，含建快照）；纯冷启动（不建快照）≈1.33s。
- **机制 1：分段埋点**（`serial-first-line`、`snapshot-reuse`，配合 `HARNESS_VM_BOOT_VERBOSE`）
  - 驱动 drain Firecracker stdout（内核 console，原来只挂 `proc.on("error")` 完全不读），记录**首个串口字节**的时刻，以及被抓取到的最后 8KB 串口输出（`HARNESS_VM_BOOT_VERBOSE=1` 时内核打印完整启动日志，否则 `quiet loglevel=3`）。
  - `snapshot-reuse`：本 VM 没写快照、只是在并发门控里等到别人做好后复用；`make-snapshot` 只在真的写镜像时记录。
- **机制 2：预热脚本**：`scripts/vm-snapshot-prewarm.ts`（内存自检 + 真机模式）：按模板哈希查快照，不存在就 create + terminate 一次以生成快照；已存在则 `VM_PREWARM_SKIP`。`deploy/harness-vm-prewarm.service.example`（`EnvironmentFile=/etc/harness/broker.env`，`IPAddressDeny=any`）+ `harness-vm-prewarm.timer.example`（`OnBootSec=20s` + `OnCalendar=hourly` 自检）。
- **实测拆解**（172.17.43.193，jailer + fc117，256MB，共享开）：
  - 纯冷启动（不建快照）n=3：median **1334ms** = `vsock-handshake` 1281 + `api-socket-wait` 20 + `copy-disks` 16 + `api-config-cold` 14 + `chown-chroot`/`spawn-process`/`share-base` ~5。
  - `serial-first-line`：冷启动 **15ms**、热恢复 21ms —— 说明 Firecracker 进程与内核 console 是"立刻"起来的，**慢的 1.28s 全在 guest 用户态**（busybox init 链 + `socat VSOCK-LISTEN` + agent 二进制加载）。
  - 建快照模式首台：total 2254~2416ms = 冷启动 1.28s + `make-snapshot` **908~918ms**（把 256MB 内存镜像写盘）。
  - `quiet loglevel=3` 与 verbose 的时间**没有差别**（1334ms vs 1334ms）：串口日志不是瓶颈，保留 quiet 只为少写不消费的管道数据、降低阻塞风险。
  - 并发冷启动 N=10（池空，同一模板）：总墙钟 2341~2472ms，单 VM median 1718~1852ms；`snapshot-reuse` **9 台**、真写快照 **1 台**（外加 1 次 warmup）→ 不是 10×2.4s。
  - 预热后并发热恢复 N=10：总墙钟 206~222ms，单 VM median 104~117ms，warmHits 10/10。
- **生产验证**（同机，`HARNESS_VM_SHARE_ROOTFS=1`）：清空 `/data/harness/snapshots-mt` 后以 root + `broker.env` 运行预热 → `VM_PREWARM_OK template=2d686647... firstCreateMs=2235 warmHit=false probe=4.14.174`；再跑一次 → `VM_PREWARM_SKIP reason=snapshot-present`；随后首个真实用户 Run `SANDBOX_ACQUIRED {"durationMs":166,"warmHit":true}`（预热前同一操作是 2440ms / warmHit=false）。
- **结论**：首次冷启动的 2.2s 不能靠调参消掉（1.28s guest 用户态就绪 + 0.9s 写内存镜像）；能改的是**谁付这一笔**——预热把它从用户路径挪到服务启动。要真压缩冷启动本身，需要更小的 agent 二进制/精简 inittab（未实测）或 COW 文件系统让 `make-snapshot` 不再整块写。

### O6 关闭 guest 内核 i8042/PS-2 探测：冷启动 1338ms → 539ms（2026-10-12）

- **背景**：O5 只能看到 `serial-first-line`（15ms）与 `vsock-handshake`（1281ms）两点，中间 1.2s 是黑盒。为定位补了两层观测：**guest 侧 boot marks**（`/etc/boot-mark` 读 `/proc/uptime` 打 `/dev/console`，inittab 的 sysinit 每步各一个 mark）＋ 内核 `printk.time=1` ＋ **Firecracker stdout 落盘**（`HARNESS_VM_SERIAL_LOG_DIR`）。结果：guest userspace（init）直到 uptime **0.85s** 才开始，而内核只用 ~60ms 就该到 init。
- **根因**：内核时间线里有两段空白 —— `0.091s19 → 0.348s58`（257ms）与 `0.363s → 0.861s`（498ms），全部落在 `i8042`（PS/2 键盘控制器）探测上；Firecracker 侧日志同期有 `Failed to trigger i8042 kbd interrupt (disabled by guest OS)`。Firecracker 不提供 PS/2 设备，这两段是纯粹的等超时。
- **机制**：
  - `COLD_START_BOOT_ARGS` 常量（`src/sandbox/microvm/firecracker-sandbox-driver.ts`）在**默认与 verbose 两条** `boot_args` 分支都加上 `i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd`。
  - 新增 `extraBootArgs`（env `HARNESS_VM_EXTRA_BOOT_ARGS`）追加在命令行末尾，用于**不重编镜像**调内核参数。
  - 新增 `serialLogDir`（env `HARNESS_VM_SERIAL_LOG_DIR`）：把 Firecracker stdout 落盘为 `<dir>/<sandboxId>.serial.log`，否则 guest boot marks 与内核时间线读不到（此前只保留 8KB 尾巴在内存里）。
  - guest 埋点脚本：`scripts/microvm/build-guest-rootfs.sh`（新建镜像）与 `scripts/microvm/patch-guest-rootfs-bootmarks.sh`（给存量镜像原地补，幂等、先备份 `.bak-bootmarks`、拒绝改写含未知行的 inittab）。mark 阶段名：`proc-sysfs` / `mdev` / `tmpfs` / `workspace` / `before-socat`。
- **真机实测**（172.17.43.193，jailer + Firecracker v1.17.0，256MB guest，共享只读基础文件开，`cold` 模式）：

  | 配置 | 冷启动 total | guest init 时刻 | 宿主 connect-ok |
  | --- | --- | --- | --- |
  | 无额外参数（基线） | 1338ms | uptime 0.85s | 1206ms |
  | 仅 `i8042.noaux` | 949ms | uptime 0.57s | 900ms |
  | `i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd` | **539ms** | **uptime 0.05~0.06s** | **404ms** |
  | 再加 `i8042.nokbd` | 539ms（无进一步收益） | — | — |

  加参数后的 539ms 构成：内核→init 50~60ms ＋ init 链（5 个 boot mark 之间）≤10ms ＋ **`socat` 启动→监听 ~340ms** ＋ agent 加载 ~75ms。
  建快照模式首台：2235~2776ms → **1452ms**；热恢复不受影响：median **102.9ms**、warmHits 5/5、热恢复后执行 `uname -r` 10.9ms。
- **被否证的两个假设**（记录以免重复走）：
  1. "socat 在等熵"：追加 `random.trust_cpu=on` 后 539ms 不变，且 guest `crng` 初始化发生在 ~1.1s —— **晚于** socat 开始监听（0.4s），所以 340ms 不是等熵。
  2. "socat 慢在宿主页缓存未热"：同一配置第二轮（宿主页缓存已热）数值与第一轮相同 → 不是宿主侧 I/O，是 socat 自身启动（动态链接 `socat + libssl3/libcrypto3`）。
- **代价**：只影响 PS/2 输入设备探测；无头 guest 不需要键盘/鼠标。删除这几个参数即可回滚（`HARNESS_VM_EXTRA_BOOT_ARGS` 可临时覆盖）。
- **提交**：见本节末尾 O6 对应 commit（含 boot-mark 脚本、`tests/sandbox/vm-boot-args.test.ts` 4 用例）。

### O7 jailer 下快照硬链接进 staging：make-snapshot 908 → 753ms（2026-10-12）

- **背景**：jailer 下 Firecracker 把快照写在 chroot 内（`/golden.snap`、`/golden.mem`，与池同在一个 /data 文件系统），随后驱动用 `cp --reflink=auto` 把它复制进 staging。**ext4 没有 reflink，`--reflink=auto` 静默退化为全量复制** —— 256MiB 内存镜像因此在 create 路径里被读+写了一遍。
- **机制**：改用 `shareBaseFile(snapInChroot, stagingPaths.snapshotPath, { fallbackCopy: copyFileReflink, mode: SHARED_BASE_FILE_MODE })`（同 inode、零拷贝；跨设备/失败时自动退回复制）。发布仍是"写 staging + rename"：运行中的 VM 通过硬链接仍持有旧 inode，不会被截断。
- **实测**（172.17.43.193，jailer + fc117，256MiB guest，共享开，snapshot 模式首次 create + 1 次热恢复）：
  - `make-snapshot` **908~918ms → 753~756ms**；`firstCreateMs` 1452 → **1293~1302ms**。
  - 热恢复 `total` 105~107ms（`snapshot-load` 5~6ms、`vsock-handshake` 59~64ms），未受影响。
- **被否证的假设（重要）**：`sync_snapshot_files:false` 基本没有收益 —— 等 fsync **753ms**、不等 **756ms**。原因：256MiB 的 dump 本身就要约 750ms（≈340MiB/s，受宿主回写与 NVMe 带宽约束），期间后台 writeback 已经写掉大部分脏页，等 `fsync` 时几乎没有剩余工作。因此**默认恢复为持久（`sync_snapshot_files` 不显式关闭）**，只保留 `HARNESS_VM_SNAPSHOT_SYNC_FILES=0` 开关（关闭时发布后异步补一次 `fsyncPublished`），并在 `.env.example` 里写明"实测无收益"。
- **结论**：首次建快照剩余的 ~750ms 是**Firecracker 写 256MiB 内存镜像本身的速度上限**，API 层已无旋钮可调。再降只有两条路（均未实施，见 §3）：
  1. `snapshot_type:"Diff"`（首次快照即只写脏页）：官方仍是 developer preview；对我们"一份快照多 VM 加载"的模型要先验证 diff 孔洞语义与恢复正确性（孔洞读 0 只在"刚 boot 的 VM 的 diff"成立）。
  2. 快照先写 tmpfs（RAM 速度）、后台再搬到 /data：前台只剩内存拷贝，但需要给 jailer chroot 内造 tmpfs 路径 + 发布前 gate（未发布前其他 VM 不能读到半份文件）。代价是每模板多占 256MiB RAM。
- **提交**：见 O7 对应 commit（含 `tests/sandbox/vm-snapshot-sync-files.test.ts` 4 用例）。

### O8 冷启动剩余耗时的归属：guest agent 二进制加载（2026-10-12，实测）

- **背景**：O6 把纯冷启动从 1338ms 降到 539ms 之后，剩余时间此前被记成"socat 启动→监听 ~340ms"与"agent 加载 ~75ms"。用三组真机实验重新归因，**其中两条旧结论被推翻**。
- **实验 1：socat 是不是 340ms 的来源 → 否**。写了一个 2KB 的极简 vsock 监听器（`socket(AF_VSOCK)`/`bind`/`listen`/`accept` + `fork` + `dup2` + `execl /agent/main`，静态编译 890KB），替换 inittab 里的 `socat VSOCK-LISTEN:5000,fork EXEC:/agent/main`，同参数真机对比：静态监听器 **523~542ms** vs socat **539ms** —— 差异在噪声量级（~16ms）。**"socat 启动占 340ms"作废**；实验文件未进仓库。
- **实验 2：agent 二进制才是大头 → 是**。把 `/agent/main`（`bun build --compile` 产物，**96,352,640 字节**）换成 900KB 的静态 C ping 应答器，其余（内核、inittab、socat、共享只读基础文件）完全不变：`vsock-connect-ok` 153~156ms 之后 **pong 只晚 3ms**、冷启动 `total` **208~228ms**；同参数下原 96MB agent 是 pong 391~395ms、`total` 442ms。⇒ **冷启动剩下的 ~230ms 是那个 96MB Bun 二进制被读入内存并初始化**，"agent 只值 75ms"作废。
- **实验 3：预读 agent 到 page cache → 无效**。在 inittab 的 respawn 之前插一步 `cat /agent/main > /dev/null`：`total` 344/407/443ms（中位 407），与不预读的 442ms 同量级。96MB 的读取只是被提前，并没有被消除（256MB guest 也留不住它）。
- **被否证的调参（重要）**：把 vsock 握手改成"30ms 单次超时 + 20ms 间隔"（原 100/300）会让**冷启动**看起来更快，但**热恢复严重回归**：恢复出来的 guest 里 socat 会为每个连接 fork 一个 agent，密集重试在 256MB guest 里连续开出 ~50 个连接 → 反复 fork 96MB agent → 热恢复 **97ms → 229~653ms**（一次恢复里 `vsock-connect-ok` 出现 50 次）。已回滚为 `connectWithRetry(20000, 100, 300)`：**单次尝试超时必须大于 agent 加载时间**，否则"重试"会把等待变成进程风暴。
- **首次快照用 `snapshot_type:"Diff"`（新增旋钮 `HARNESS_VM_SNAPSHOT_TYPE`，默认仍是 `Full`）**：`mem.snap` 实际占用 **256MiB → 74.6MiB**（`st_blocks` 524288 → 152896，稀疏），`firstCreateMs` **1301 → 1140ms**，热恢复 96.9 → 96.2ms，恢复后 exec 11.0 → 10.2ms；**5/5 次恢复 + exec 探针全部成功**，证实官方"刚启动过的 VM 的 diff 快照可以直接 resume"对我们成立（我们的黄金快照正是"刚完整启动并握手成功的 VM"）。收益只有 ~160ms（dump 虽稀疏化 3.4×，但首次 create 还包含内核启动 + agent 加载），且 diff 仍是官方 developer preview，因此**默认保持 `Full`**，只在需要更小池文件、更低宿主 page cache 压力时显式开启。
- **冷启动 539ms 的当前构成**：内核→init ~60ms、init 链 + socat 进入监听 ~90ms（其中 socat 本体 ~16ms）、**96MB agent 加载 ~240ms**、其余 ~30ms；池空后另有 `make-snapshot` ~750ms。
- **下一步（按收益排序，未实施）**：
  1. **把 guest agent 换成小体积静态二进制**（C/Go/Rust）：预期冷启动 539 → ~300ms、首建 1293 → ~1050ms。移植面就是现有 `guest/agent/main.ts`（181 行：JSON-RPC `ping`/`exec`、base64 64KB 分片、1MiB 截断、`timeoutMs` 到点 SIGTERM→2s→SIGKILL）。远程宿主只有 gcc（无 go/rustc），C 是唯一现成路径。
  2. 配合 1 把 guest RAM 从 256MiB 下调（agent 变小后 256MiB 内存镜像的写量可以线性下降）。
  3. 保持服务启动预热（O5），让用户路径始终命中热恢复，而不是去追冷启动的绝对数字。
- **提交**：见 O8 对应 commit（含 `tests/sandbox/vm-snapshot-type.test.ts`）。

### O9 静态 C guest agent 替换 socat + 96MB Bun 产物（2026-10-12，实现）

**动机**：O8 三组实验证明剩下的冷启动时间几乎全在 guest 用户态，其中约 240ms 是加载
96MB 的 `bun build --compile` 产物（Bun 运行时初始化 + 大量页面读入），约 90ms 是
`socat`（动态链接 OpenSSL/readline）进入监听。业界（Fly.io `init`、Apple `vminitd`、
microsandbox `agentd`、E2B `envd`）无一例外都是"静态单二进制 + `init=<agent>`"，没有
人会为了开一个 socket 拖进 OpenSSL —— 调研见 `docs/research/cold-start-guest-init.md`。

**实现**：
- 新增 `guest/agent/agent.c`（单文件、无依赖、约 1050 行）：自带最小 JSON 解析器 +
  流式 base64 编码；协议与 `guest/agent/main.ts` 完全一致（`ping`/`exec`、`exec_output`
  按 64KB 分片、`exec_result` 带 `exitCode/timedOut/truncated`、>1MB 帧判
  `protocol_frame_too_large`、超时 SIGTERM→2s→SIGKILL、子进程退出后 1s 静默即收尾，
  避免孙进程占住管道把宿主挂死）。与 socat 版的关键差别：**agent 自己 `AF_VSOCK` 监听**
  （`bind(VMADDR_CID_ANY, port)` + 每连接 `fork`），因此不再需要 socat 转发，也不再需要
  `libssl3/libcrypto3/libstdc++/libgcc/readline/libncursesw`（约 6.9MB 动态库）。
- 编译体积：macOS `cc -O2`（clang）**35,792 字节**，零警告；对比 96MB Bun 产物约 1/2700。
- `scripts/microvm/build-guest-rootfs.sh`：新增 `HARNESS_GUEST_AGENT_IMPL=c|bun|auto`
  （默认 auto：有 `cc` 即 c）。`c` 时现场静态编译并写 `/agent/main`，inittab 的 respawn 行
  改为 `::respawn:/agent/main`（不再经 socat），并跳过 socat/OpenSSL/C++ 运行时 apk 拉取；
  `bun` 时保持原行为。加了自检：`impl=c` 出镜像前必须确认 inittab 直接 respawn `/agent/main`。
- `scripts/microvm/patch-guest-rootfs-c-agent.sh`：给**存量镜像**原地换 agent（生产镜像不重
  建也能切）。幂等、先 `cp -a` 备份 `<image>.bak-cagent`、inittab 白名单校验（未知行拒绝
  改写）、回写后 dump 校验 + `cmp` 校验二进制一致，输出 `PATCH_C_AGENT_OK`。
- `src/sandbox/microvm/firecracker-sandbox-driver.ts`：`guestAgentVersion` 默认 `1.0.0` →
  `2.0.0`。**该值参与 `computeTemplateHash`，换 agent 不提升它就会复用旧 agent 的黄金快照**
  （旧快照内的 `/agent/main` 是 socat 版）。切实现后必须清空快照池。
- 与 `docs/microvm-implementation-plan.md:228`（"不要引入 Go/C 工具链"）冲突：这里显式记偏差，
  理由 = 冷启动是 VM 沙箱的核心体验指标，而 96MB 解释型运行时是当前最大的单点开销；
  代价是 guest agent 从 TS 变成 C（宿主侧仍全 TS，协议未变，测试见
  `tests/guest/agent-stdio.test.ts`）。

**本地验证**：`tests/guest/agent-stdio.test.ts` 14 用例全绿（pong/数字 id 回显、stdout/stderr
分帧、env 注入与 PATH 解析、timeout→124、`maxOutputBytes` 截断、200KB 输出分帧拼接、
`kill -9` → 1、后台孙进程不挂住、四类协议错误、>1MiB 帧、cwd 不存在 → 127）。

**真机 A/B（172.17.43.193，jailer + fc117，256MiB guest，共享只读基础文件开，冷启动 3 次）**：

| 配置 | 冷启动 total 中位 | vsock-connect-ok | vsock-pong | 说明 |
| --- | --- | --- | --- | --- |
| socat + 96MB Bun 产物 | **338ms** | 140ms | 207ms | connect 成功后还要 ~70ms 加载 Bun agent |
| 静态 C agent（974,536 字节，glibc -static） | **261ms** | 138ms | 138ms | connect 成功后 ~0ms 即可应答 |

- 两个数字都是**同一批补丁后**（见 O10 的握手量化修复）；修复前同样两个配置是 602ms / 535ms。
- guest 侧时间线（`/etc/boot-mark` + agent 自己的 `harness-agent listening on vsock:5000` 串口打印）：
  init 链在 **uptime 0.06~0.08s** 就全部走完，C agent 的监听行紧跟着出现 —— 也就是说
  **guest 用户态 ~70ms 就绪**，`copy-disks`(84ms)+`api-socket-wait`(21ms)+`api-config`(11ms)+
  内核启动(~50ms) 才是冷启动剩下的主要成本。
- 热恢复（同一 C agent 镜像，snapshot 模式 5 次）：total 中位 **117.5ms**、`snapshot-load` 5ms、
  `vsock-handshake` 5.5ms → C agent 对热路径无回归（宿主侧握手本来就是一次成功）。
- 结论：96MB 解释型运行时带来的真实差异是 **connect 之后的 ~70ms**，加上 O6 之前那次误归因，
  说明"用静态二进制的收益"必须在握手不再被量化之后才能测准。

**代价 / 未做**：镜像里的 socat 与那几个动态库**没有删除**（只删了引用），镜像体积暂时没降；
`init=<agent>`（连 init 链一起去掉，业界 3/3 采用）未做，留待下一步。

**生产验证（172.17.43.193，systemd + jailer，2026-10-12 19:07~19:11）**：

- 给生产镜像 `/data/harness/images/rootfs.ext4` 打 C agent 补丁（`PATCH_C_AGENT_OK ... agentBytes=974536`，
  备份 `rootfs.ext4.bak-cagent`），`/etc/harness/broker.env` 设 `HARNESS_GUEST_AGENT_VERSION=2.0.0`，
  清空快照池并重启 Broker。
- 清池后第一个 Run `1a09587f`：`SANDBOX_ACQUIRED {"durationMs":916,"warmHit":false}`（冷启动 ~260ms
  + 制作快照 ~650ms），工具在 guest 内执行 `uname -r` 返回 `4.14.174` —— **C agent 的 exec 链路
  在生产可用**；同配置在 socat+Bun 时代是 1507ms。
- 之后的 Run（含 p0 smoke 的串行/并发）：`49ms / 54ms / 76ms / 76ms / 77ms`，全部 `warmHit=true`；
  同配置在 socat+Bun 时代是 128ms。
- 维护脚本的 GC 豁免在生产验证：`cleanup --snapshot-pool ... --max-age-hours 0 --max-snapshots 0`
  （dry-run，等效"删掉一切"）输出 `snapshotPoolRemoved=0 snapshotPoolProtected=1` +
  `HARNESS_OPS_CLEANUP_PROTECTED 54b4cce787cc…`，即当前模板快照被正确豁免。
- `harness-vm-prewarm.service` 手动触发：`VM_PREWARM_SKIP template=54b4cce787cc… reason=snapshot-present`。
- `scripts/p0-e2e-smoke.ts` → `P0_E2E_SMOKE_OK label=e893796f`（串行 maxActive=1、并发 maxActive=2
  overlap=true、跨租户 run/events/output/interrupt/对方 workspace 提交全部 404）。

**生产验证（GC 豁免）**：见上一段最后两条（`snapshotPoolProtected=1` / `VM_PREWARM_SKIP`）。

### O11 让"池里永远有匹配的快照"：GC 豁免当前模板（2026-10-12）

**问题**：`pruneSnapshotPool` 按目录 mtime 降序做"年龄 TTL + 条数上限"双条件删除，而**当前在用**
的黄金快照目录的 mtime 就是它被发布的时间；预热命中时脚本走 `VM_PREWARM_SKIP` 直接返回、不会
`touch` 目录。于是生产参数 `--max-age-hours 72` 会在 72 小时后把**唯一在用的**快照删掉，直到下一次
预热重建之间落进来的 Run 吃完整冷启动（1334ms）。来源：`docs/research/cold-start-standby-pool.md` §5.3。

**修复**：
- `src/ops/harness-maintenance.ts`：`PruneResult` 增加 `protected:string[]`；`pruneSnapshotPool` 与
  `pruneDirectories` 接受 `protectedNames?:readonly string[]`，命中者**既不删也不计入条数上限**。
- `scripts/harness-ops.ts`：新增 `resolveProtectedTemplateHashes(args)` —— 用与 Broker 相同的
  `VmSnapshotManager.computeTemplateHash(FIRECRACKER_KERNEL_PATH, FIRECRACKER_ROOTFS_PATH,
  HARNESS_GUEST_AGENT_VERSION ?? "2.0.0")` 算出当前模板并豁免；`--protect-template <hash>` 可追加，
  `--no-protect-current-template` 显式关闭；输出新增 `snapshotPoolProtected=N` 与
  `HARNESS_OPS_CLEANUP_PROTECTED <hash,...>`。
- `deploy/harness-maintenance.sh.example`：只从 `/etc/harness/broker.env` 读取需要的三个键
  （`read_broker_env`，避免整份 source 把控制令牌带进维护进程），否则维护脚本没有 `FIRECRACKER_*`
  时豁免会静默失效。

**为什么这也算冷启动优化**：我们已经有业界"藏冷启动"里最贵的那一半（热恢复 median 101ms、
`/snapshot/load` 4~7ms，比 Fly/Modal/CodeSandbox 都快）。真正会让人"感觉到"的只剩"池里没有匹配快照"，
而 GC TTL 竞态正是其中一个我们完全可控的来源。

### O10 修复 vsock 握手量化：握手期间对端关闭立即失败（2026-10-12）

**根因**：`FirecrackerVsockBridge.connect()` 只把 `error` 当失败；`close` 事件只通知
`activeHandlers`（握手阶段该表还是空的），于是 guest 尚未监听时（Firecracker UDS 代理直接关闭
连接），pending 的握手 promise 一直悬着，直到 `handshakeTimeoutMs`（冷启动路径 300ms）才超时，
再等一个 `intervalMs`(100ms) 重试 —— `connect-ok` 被**量化到 ~400ms**，而 guest 实际 70ms 就绪。

**修复**：
- `src/sandbox/microvm/firecracker-vsock-bridge.ts`：`connect()` 的 `close` 处理里，若握手未完成则
  立即 `reject(new Error("vsock 连接在握手完成前被对端关闭（guest 尚未监听）"))`；并新增 `end`
  （半关闭）同样处理。已完成的连接仍走原来的 activeHandlers 通知路径。
- `src/sandbox/microvm/firecracker-sandbox-driver.ts`：冷启动重试参数 `connectWithRetry(20000, 100, 300)`
  → `connectWithRetry(20000, 50, 300)`（快速失败后可以更密地探测）。
- 测试：`tests/sandbox/firecracker-vsock-bridge.test.ts` 新增两条 —— 对端关闭时必须在 <300ms 内
  reject（不等 attemptTimeout）；mock 服务端"前两次拒绝、第三次就绪"时 `connectWithRetry(5000,50,300)`
  总耗时 <400ms（≈2 个 interval）。

**真机效果（同一批镜像）**：

| 配置 | 修复前冷启动 | 修复后冷启动 | 热恢复 |
| --- | --- | --- | --- |
| socat + Bun agent | 602ms | **338ms** | — |
| 静态 C agent | 535ms | **261ms** | 117.5ms（total）、握手 5.5ms |

**教训**：`connectWithRetry(20000, 20, 30)`（O8 试过的"极密重试"）之所以让热恢复退化到 229~653ms，
是因为每次尝试都要白等满 30ms 超时；把"对端关闭"当失败之后，失败尝试变成亚毫秒级，interval 才真正
决定了探测延迟。**先修失败判定，再调重试参数。**



**代价 / 未做**：镜像里的 socat 与那几个动态库**没有删除**（只删了引用），镜像体积暂时没降；
`init=<agent>`（连 init 链一起去掉，业界 3/3 采用）未做，留待下一步。


## 3. 待评估 / 未采用

| 候选 | 预期收益 | 现状 |
| --- | --- | --- |
| rootfs 共享 + guest tmpfs（`/tmp`/`/run`/`/var/tmp`） | 热恢复 176 → ~100ms | **已实施（O4）**：实测 101.3ms |
| 并发冷启动复用首个完成的快照 | 首次并发 N 台从 N×2.7s → 1×2.7s + (N-1)×0.2s | **已生效**：O5 埋点证实 N=10 时 9 台走 `snapshot-reuse`，只有 1 台真写快照（早先"`canRestore` 在门控前计算导致不复用"的判断**作废**——门控内会复查 `hasSnapshot`） |
| 服务启动时预热黄金快照 | 用户首个 Run 不再付 2.4s | **已实施（O5）**：`scripts/vm-snapshot-prewarm.ts` + `deploy/harness-vm-prewarm.{service,timer}.example`；生产首个 Run `warmHit:true, 166ms` |
| 工作区模板瘦身（128MB → 32MB） | `copy-disks` 14 → ~4ms | 待做（收益小） |
| socket 轮询粒度 20ms → 2ms | `api-socket-wait` 20 → ~3ms | 待做（收益 ~17ms） |
| `quiet loglevel=3` 启动参数 | 期望少写串口、间接加速 | **已实施但无时间收益**：实测 1334ms vs 1334ms；保留只为减少未消费的管道数据（`HARNESS_VM_BOOT_VERBOSE=1` 可打开详细日志） |
| COW 文件系统（xfs reflink=1 / btrfs） | 可写盘拷贝近 0、`make-snapshot` 更快 | 未采用：远程无 `mkfs.xfs`/`mkfs.btrfs`，需换盘/装工具 |
| UFFD diff snapshot / 懒加载（CodeSandbox 式） | 内存镜像不再整块写 | 未采用：需自写 `UFFDIO_COPY` handler，复杂度高 |
| 预热池（Daytona/Modal/Fly 式常驻待命 VM） | 交接 ~10~50ms | 未采用：内存常驻成本、租户隔离与回收复杂度 |
| 关闭 guest 内核 i8042/PS-2 探测（`i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd`） | 冷启动 1338 → ~540ms | **已实施（O6）**：实测 539ms；建快照首台 2235 → 1452ms；热恢复不变 |
| 用静态小监听器替换 `socat` | 期望冷启动再减 ~300ms | **已否证（O8/O10）**：socat 本身只值 ~16ms；O10 修掉握手量化后，socat 与 C agent 的差别就是 connect 后的 ~70ms agent 加载 |
| jailer 下把 chroot 内快照**硬链接**进 staging（替代 `cp --reflink=auto` 的全量复制） | `make-snapshot` 少一遍 256MiB 读+写 | **已实施（O7）**：908 → 753ms；首建 1452 → 1293ms |
| `/snapshot/create` 带 `sync_snapshot_files:false`（不等 fsync） | 期望 -200~400ms | **实测无收益**：753 vs 756ms（dump 本身 ~750ms，期间后台回写已完成）→ 默认恢复持久 |
| 快照先写 tmpfs（RAM）再后台搬到 /data | 前台只剩内存拷贝（~150ms） | 未实施：需给 jailer chroot 造 tmpfs 路径 + 发布前 gate；每模板多占 256MiB RAM |
| `snapshot_type:"Diff"` 首次快照只写脏页 | 写量降 3.4× → 首建 -160ms | **已实测（O8）**：256MiB→74.6MiB、firstCreate 1301→1140ms、5/5 恢复+exec 探针通过；旋钮 `HARNESS_VM_SNAPSHOT_TYPE=Diff`，默认仍 `Full`（官方 developer preview） |
| 预读/缓存 `mem.snap` 到 page cache（预热后首次 load 更快） | `snapshot-load` 5~6ms → ~2ms | 未做（收益小） |

| 更小的 guest agent 二进制（静态 C/Go/Rust 替代 96MB Bun 产物） | 冷启动 **-77ms**（真机 A/B：338 → 261ms） | **已实施（O9）**：`guest/agent/agent.c` + 自监听 AF_VSOCK；老结论 "-230ms" 是握重量化造成的误判（O10） |



## 4. 冷启动分析

以 256MB guest、jailer、共享基础文件开启为前提，真机实测把冷启动切成两段：

| 段 | 实测 | 说明 |
| --- | --- | --- |
| Firecracker 进程 + 内核 console 起来 | **15ms**（`serial-first-line`） | 进程启动与 API socket 就绪很快（`spawn-process` 1~3ms、`api-socket-wait` 20ms 是 20ms 轮询粒度） |
| guest 用户态就绪（agent 可握手） | **O6 前 ~1281ms** → O6 后 ~390ms → O10 后 **~130ms**（connect-ok 138ms） | boot-mark 实测 init 链 uptime 0.06~0.08s 就结束；O9 换 C agent 后 connect 成功即应答（0~2ms），差别只剩 socat+Bun 的 ~70ms |
| 建快照（把 256MB 内存镜像写盘） | **908~918ms** | 只在"池空后的第一次 create"发生 |

结论：

1. **能靠配置消掉的已经消掉了**（热恢复 498ms → 101ms 靠共享只读基础文件与 `copy-disks` 瘦身）。
2. **池空后的第一次 create（≈2.2s）无法靠调参消掉**：1.28s 是 guest 用户态，0.9s 是内存镜像写盘。
3. 因此对用户可见的解法是"改谁付这一笔"：**服务启动预热**（O5）后，用户遇到的第一个 Run 也是热恢复（实测 166ms / warmHit=true）。
4. 并发场景不会线性放大：N=10 并发冷启动只写 1 次快照，其余复用（O5 埋点）。
5. O9 已把 guest agent 换成静态 C 二进制（自监听 vsock，不再需要 socat），O10 修掉了握手里 ~400ms 的量化，冷启动 539ms → **261ms**。
6. O8 已把剩下的 390ms 拆开：init 链 ~90ms、**96MB agent 加载 ~240ms**、其余 ~60ms。要进一步压缩冷启动，首要项是把 guest agent 换成小体积静态二进制（预期 -230ms）；COW 文件系统仍未实测（见 §3）。

## 5. 复现命令

```sh
# 预热黄金快照（root，读 broker.env；幂等，已存在则 SKIP）
set -a; . /etc/harness/broker.env; set +a
bun run scripts/vm-snapshot-prewarm.ts
```

## 5.1 guest agent 构建与存量镜像切换

```bash
# 重建镜像（有 cc 时默认 impl=c）
bash scripts/microvm/build-guest-rootfs.sh - /tmp/rootfs.ext4 /tmp/workspace.ext4

# 存量镜像原地切换（先备份 .bak-cagent，幂等）
bash scripts/microvm/patch-guest-rootfs-c-agent.sh /data/harness/images/rootfs.ext4

# 切完必须做：提升 HARNESS_GUEST_AGENT_VERSION（默认已 2.0.0）并清空快照池
rm -rf /data/harness/snapshots-mt/*
```

## 6. 基准与预热复现命令

```sh
# 真机：热恢复/冷启动 A/B（root，jailer + Firecracker）
HARNESS_BENCH_MODE=snapshot HARNESS_USE_JAILER=true HARNESS_VM_SNAPSHOTS_ENABLED=true \
HARNESS_BENCH_POOL_DIR=/data/harness/vm-bench/pool HARNESS_BENCH_RUNTIME_ROOT=/data/harness/vm-bench/runtime \
HARNESS_BENCH_WORKSPACE_ROOT=/data/harness/vm-bench/ws HARNESS_BENCH_WARM_ITERATIONS=10 \
HARNESS_BENCH_EXEC_PROBE=true HARNESS_VM_PHASE_TRACE=1 \
FIRECRACKER_BINARY_PATH=... FIRECRACKER_KERNEL_PATH=... FIRECRACKER_ROOTFS_PATH=... \
FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=... \
/home/cxr/.bun/bin/bun run scripts/vm-lifecycle-benchmark.ts

# 看端到端是否命中快照：GET /runs/:id/events 的 SANDBOX_ACQUIRED.durationMs / warmHit
# 服务端分阶段日志：journalctl -u harness-broker.service | grep vm-phase
```
