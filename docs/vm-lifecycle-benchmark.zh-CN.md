# microVM 生命周期基准（Phase 1）

## 目的

量化生产级 VM 启动速度，覆盖四条路径：

- 冷启动（无快照）
- 首次启动 + 制作快照
- 快照热恢复
- 并发热恢复 / 并发冷启动

脚本直接使用 `FirecrackerSandboxDriver`，不经过 HTTP、Agent 或 Broker，避免把模型延迟混入 VM 启动数据。

## 运行方式

脚本：`scripts/vm-lifecycle-benchmark.ts`

关键环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HARNESS_BENCH_MODE` | `all` | `cold` / `snapshot` / `concurrency` / `all` |
| `HARNESS_BENCH_COLD_ITERATIONS` | `5` | 冷启动迭代次数 |
| `HARNESS_BENCH_WARM_ITERATIONS` | `20` | 热恢复迭代次数 |
| `HARNESS_BENCH_CONCURRENCY` | `1,2,4,8,10` | 并发档位 |
| `HARNESS_BENCH_COLD_CONCURRENCY` | `false` | 是否同时跑并发冷启动 |
| `HARNESS_BENCH_EXEC_PROBE` | `false` | 热恢复后是否执行 `uname -r` 探针 |
| `HARNESS_BENCH_POOL_DIR` | `HARNESS_VM_SNAPSHOT_POOL_DIR` | 基准专用快照池 |
| `HARNESS_BENCH_RUNTIME_ROOT` | `HARNESS_VM_RUNTIME_ROOT` | 基准专用运行目录 |
| `HARNESS_BENCH_WORKSPACE_ROOT` | `/tmp/harness-vm-bench-workspaces` | 基准专用工作区 |
| `HARNESS_BENCH_OUTPUT` | `vm-lifecycle-benchmark.json` | 报告路径 |
| `HARNESS_USE_JAILER` | `true` | 快照模式必须为 `true` |

还需要 `FIRECRACKER_BINARY_PATH`、`FIRECRACKER_JAILER_PATH`、`FIRECRACKER_KERNEL_PATH`、`FIRECRACKER_ROOTFS_PATH`、`FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH`。

真机运行示例（172.17.43.193，root）：

```bash
set -euo pipefail
export FIRECRACKER_BINARY_PATH=/home/cxr/microvm-test/bin/fc117
export FIRECRACKER_JAILER_PATH=/home/cxr/microvm-test/bin/jailer117
export FIRECRACKER_KERNEL_PATH=/home/cxr/microvm-test/bin/vmlinux
export FIRECRACKER_ROOTFS_PATH=/home/cxr/microvm-test/images/rootfs.ext4
export FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=/home/cxr/microvm-test/images/workspace-template.ext4
export HARNESS_USE_JAILER=true
export HARNESS_BENCH_MODE=all
export HARNESS_BENCH_POOL_DIR=/data/harness/vm-bench/snapshots
export HARNESS_BENCH_RUNTIME_ROOT=/data/harness/vm-bench/runtime
export HARNESS_BENCH_WORKSPACE_ROOT=/data/harness/vm-bench/workspaces
export HARNESS_BENCH_COLD_ITERATIONS=5
export HARNESS_BENCH_WARM_ITERATIONS=10
export HARNESS_BENCH_CONCURRENCY=1,2,4,8,10
export HARNESS_BENCH_COLD_CONCURRENCY=true
export HARNESS_BENCH_EXEC_PROBE=true
export HARNESS_BENCH_OUTPUT=/data/harness/vm-bench/vm-lifecycle-benchmark.json
mkdir -p /data/harness/vm-bench
cd /home/cxr/agent-harness-mt
/home/cxr/.bun/bin/bun run scripts/vm-lifecycle-benchmark.ts
```

成功时输出 `VM_BENCHMARK_OK`，并把 JSON 写入 `HARNESS_BENCH_OUTPUT`。

## 真机结果（2026-10-11，172.17.43.193）

环境：Ubuntu 22.04 / 内核 6.8.0-136-generic / 192 vCPU / 251GB RAM / Firecracker v1.17.0 / jailer / guest 4.14.174 / `/data` NVMe。

### 冷启动（jailer，无快照）

n=5：min 1476ms，median 1477ms，p95 1485ms，max 1485ms。

### 快照

- 首次 create（冷启动 + 制作快照）：2866ms
- 热恢复 create（n=10）：min 486ms，median 513ms，p95 538ms，max 538ms
- 热恢复后执行 `uname -r`（n=10）：median 11.6ms，p95 12.4ms，max 12.4ms
- warmHit：10/10

### 并发热恢复（jailer + 快照）

| N | 墙钟 | 单 VM median | 单 VM p95 | warmHit |
| --- | --- | --- | --- | --- |
| 1 | 595ms | 497ms | 497ms | 1/1 |
| 2 | 611ms | 523ms | 523ms | 2/2 |
| 4 | 651ms | 558ms | 562ms | 4/4 |
| 8 | 690ms | 602ms | 605ms | 8/8 |
| 10 | 766ms | 652ms | 670ms | 10/10 |

### 并发冷启动（jailer，快照池清空）

| N | 墙钟 | 单 VM median | 单 VM p95 |
| --- | --- | --- | --- |
| 1 | 2921ms | 2829ms | 2829ms |
| 2 | 2946ms | 2855ms | 2855ms |
| 4 | 2926ms | 2299ms | 2835ms |
| 8 | 2855ms | 2229ms | 2763ms |
| 10 | 2967ms | 2333ms | 2868ms |

说明：并发冷启动时 `warmHit=0`。首个完成的 VM 制作快照，其余 VM 在开始时已计算 `canRestore=false`，因此仍走冷启动。这是明确的优化点：Phase 2/3 可在快照门控结束后重新检查快照并走恢复路径。

### 宿主观测

- 最大同时 Firecracker 进程数 = N。
- 测试后无 firecracker/jailer 残留。
- `MemAvailable` 约 231GB；`/data` 26% 已用；loadavg 约 2.1。
- 快照池与运行目录在测试后清理。

## 启动路径 A/B：共享只读基础文件（2026-10-12，jailer + Firecracker v1.17.0）

热恢复的 0.5s 里，真正属于 Firecracker 的只有 `snapshot/load` 约 7ms；其余是驱动
自己做的拷贝与握手。Firecracker 官方 `snapshot-support.md` 明确允许
"sharing of memory pages and read only disks between multiple microVMs"（加载快照时
对内存文件做 MAP_PRIVATE 只读映射 + 按需分页，写入走 COW 匿名内存），前提是该文件
在 VM 存活期间不可变。据此把内核/rootfs/快照文件从"逐 VM 复制"改为"硬链接共享
同一 inode"，并用 `HARNESS_VM_PHASE_TRACE=1` 分阶段量测。

三种配置（每配置 1 次建快照 + 10 次热恢复，`HARNESS_BENCH_EXEC_PROBE=true`）：

| 配置 | 热恢复 median | p95 | 首次（冷启动+建快照） | 热恢复后 guest 执行 `uname -r` |
| --- | --- | --- | --- | --- |
| legacy（全部复制） | 498.3ms | 517.0ms | 2767ms | 11.5ms |
| `HARNESS_VM_SHARE_BASE_FILES=1`（默认） | **175.9ms** | 196.2ms | 2755ms | 11.4ms |
| 再加 `HARNESS_VM_SHARE_ROOTFS=1` | **101.3ms** | 118.7ms | 2639ms | 10.6ms |

热恢复分阶段（单台 VM，ms）：

| 阶段 | legacy | 共享基础文件 | 再共享 rootfs |
| --- | --- | --- | --- |
| 复制工作区盘 | 102（含内核+rootfs） | 87（rootfs） | 14（仅工作区盘） |
| 共享基础文件（硬链接） | — | 0 | 0 |
| 共享快照文件（硬链接） | 304（复制 512MB 内存镜像） | 0 | 0 |
| jailer API socket 就绪 | 21 | 21 | 21 |
| `snapshot/load` | 7 | 4 | 4 |
| vsock 握手 | 57 | 59 | 56 |
| chown / spawn | 4 | 4 | 4 |
| 合计 | 498 | 176 | 101 |

生产环境实测（172.17.43.193，systemd + broker + jailer，默认配置）：
`SANDBOX_ACQUIRED {durationMs: 202, warmHit: true}`；清池后的首台为
`{durationMs: 2440, warmHit: false}`。

### 三个真机踩坑

1. **模板必须与 VM 运行时根目录在同一文件系统**，否则硬链接报 EXDEV 退化为复制
   （Linux 不允许跨设备硬链接）。生产把 `FIRECRACKER_KERNEL_PATH` /
   `FIRECRACKER_ROOTFS_PATH` / `FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH` 放到
   `/data/harness/images/`（与 `/data/harness/live-full-flow/vm-runtime` 同盘）后，
   rootfs 的 87ms 复制也一并省掉。
2. **绝不要 chmod 硬链接出来的模板**：硬链接与原文件共用 inode，改权限等于改模板。
   把 rootfs 模板设成 0444 后，后续走"复制"的路径会继承 0444（`cp` 不改变已存在
   目标文件的权限），而降权后的 Firecracker 对 `is_read_only: false` 的盘是以
   **O_RDWR** 打开的 → `Drive config error ... Permission denied (os error 13)
   /rootfs.ext4`，整台 VM 起不来。因此 `shareBaseFile` 只对驱动自有、可重建的
   快照文件传 `mode: 0444`，模板保持原权限。
3. **共享 rootfs 必须以只读 virtio 盘挂给 guest**（同一 inode 不能给多台 VM 写），
   而只读标志要跟随"是否请求共享"而不是"硬链接是否成功"，否则文件 0444 + 盘 RW
   同样会在 `/drives/rootfs` 阶段 EACCES。

### 只读 rootfs 的代价（`HARNESS_VM_SHARE_ROOTFS=1`，默认关）

共享后 guest 内除 `/workspace` 外全部只读。真机实测（生产 systemd + broker，
清快照池后重建黄金 VM）：

- `SANDBOX_ACQUIRED {durationMs: 106, warmHit: true}`——比默认再快约 1.7 倍。
- 工具写 `/tmp` 直接失败：`sh: can't create /tmp/harness-probe: Read-only file
  system`，`TOOL_FAILED isError=true`；写 `/workspace` 正常，artifacts 仍能导出。
- 想同时拿到"只读基础镜像 + 可写层"，需在 guest init 里把 `/tmp`、`/run` 等挂成
  tmpfs（对应调研文档 §6 的第 7 项），当前未做。

切换 `HARNESS_VM_SHARE_ROOTFS` 时必须清空快照池：只读语义固化在黄金 VM 的
drive 配置里，池内旧快照恢复出来的盘仍按旧语义（可写）运行。

## 结论

- 冷启动约 1.5s；快照恢复默认约 0.18s（原 0.5s），开启 rootfs 共享可到约 0.1s。
- 热恢复的剩余时间主要是工作区盘复制（14ms）与 vsock 握手（56ms），已接近该路径下限。
- 10 并发热恢复墙钟 766ms，说明快照路径可支撑实验室规模的并发启动。
- 并发冷启动目前不会复用首个快照，建议后续在门控后重查快照。
- 数据为单机 jailer + Firecracker v1.17.0 实测；换宿主、内核或 guest 后需重跑。
- 本次同时修复了 `warmHit` 恒为 `false` 的可观测性缺陷，报告中的 `warmHit` 来自驱动真实回传。
