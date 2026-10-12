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

## 3. 待评估 / 未采用

| 候选 | 预期收益 | 现状与顾虑 |
| --- | --- | --- |
| rootfs 共享 + guest tmpfs（`/tmp`/`/run`/`/var/tmp`） | 热恢复 176 → ~100ms | **O4 实施中** |
| 并发冷启动复用首个完成的快照 | 首次并发 N 台从 N×2.7s → 1×2.7s + (N-1)×0.2s | 已确认缺陷：`canRestore` 在并发门控之前计算（`docs/vm-lifecycle-benchmark.zh-CN.md` 并发冷启动一节） |
| 服务启动时预热黄金快照 | 用户首个 Run 不再付 2.4s | 需 broker 侧一次性 create+terminate（或 systemd `ExecStartPost`） |
| 工作区模板瘦身（128MB → 32MB） | `copy-disks` 14 → ~4ms | 需重做 workspace 模板与文档 |
| socket 轮询粒度 20ms → 2ms | `api-socket-wait` 21 → ~3ms | 改驱动轮询常量，需回归 |
| COW 文件系统（xfs reflink=1 / btrfs） | 可写盘拷贝近 0 | 远程无 `mkfs.xfs`/`mkfs.btrfs`，需换盘/装工具 |
| UFFD diff snapshot / 懒加载（CodeSandbox 式） | 内存镜像不再整块写 | 需自写 `UFFDIO_COPY` handler，复杂度高 |
| 预热池（Daytona/Modal/Fly 式常驻待命 VM） | 交接 ~10~50ms | 内存常驻成本、租户隔离与回收复杂度 |

## 4. 冷启动分析

（待实测补充：见 O5/O6。）

## 5. 复现命令

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
