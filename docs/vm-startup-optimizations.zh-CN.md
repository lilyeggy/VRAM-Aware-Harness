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
| 用静态小监听器替换 `socat`（socat 启动→监听占冷启动 340ms） | 冷启动再减 ~300ms | 待做：正在调研业界做法（`docs/research/cold-start-guest-init.md`） |
| `make-snapshot` 落盘优化（tmpfs 快照池 / 差分快照 / 惰性解压） | 建快照首台 1452 → ~600ms | 待做：调研已落地（`docs/research/cold-start-snapshot-cost.md`） |
| 更小的 guest agent 二进制 / 精简 inittab | ~~冷启动 1.28s 中的大部分~~ **已量化** | agent 只值 ~75ms、init 链 ~10ms；1.2s 的大头是内核 PS/2 探测（O6 已修）与 socat 启动 |



## 4. 冷启动分析

以 256MB guest、jailer、共享基础文件开启为前提，真机实测把冷启动切成两段：

| 段 | 实测 | 说明 |
| --- | --- | --- |
| Firecracker 进程 + 内核 console 起来 | **15ms**（`serial-first-line`） | 进程启动与 API socket 就绪很快（`spawn-process` 1~3ms、`api-socket-wait` 20ms 是 20ms 轮询粒度） |
| guest 用户态就绪（agent 可握手） | **~1281ms** | 占纯冷启动 1.33s 的 96%：busybox init 链 + `socat VSOCK-LISTEN` + agent 二进制加载 |
| 建快照（把 256MB 内存镜像写盘） | **908~918ms** | 只在"池空后的第一次 create"发生 |

结论：

1. **能靠配置消掉的已经消掉了**（热恢复 498ms → 101ms 靠共享只读基础文件与 `copy-disks` 瘦身）。
2. **池空后的第一次 create（≈2.2s）无法靠调参消掉**：1.28s 是 guest 用户态，0.9s 是内存镜像写盘。
3. 因此对用户可见的解法是"改谁付这一笔"：**服务启动预热**（O5）后，用户遇到的第一个 Run 也是热恢复（实测 166ms / warmHit=true）。
4. 并发场景不会线性放大：N=10 并发冷启动只写 1 次快照，其余复用（O5 埋点）。
5. 要进一步压缩冷启动本身，方向是更小的 guest agent/精简 init 链，或 COW 文件系统；两者都未实测（见 §3）。

## 5. 复现命令

```sh
# 预热黄金快照（root，读 broker.env；幂等，已存在则 SKIP）
set -a; . /etc/harness/broker.env; set +a
bun run scripts/vm-snapshot-prewarm.ts
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
