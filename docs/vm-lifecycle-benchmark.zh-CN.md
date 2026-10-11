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

## 结论

- 冷启动约 1.5s；快照恢复约 0.5s，约 3 倍加速；热恢复后执行命令约 12ms。
- 10 并发热恢复墙钟 766ms，说明快照路径可支撑实验室规模的并发启动。
- 并发冷启动目前不会复用首个快照，建议后续在门控后重查快照。
- 数据为单机 jailer + Firecracker v1.17.0 实测；换宿主、内核或 guest 后需重跑。
- 本次同时修复了 `warmHit` 恒为 `false` 的可观测性缺陷，报告中的 `warmHit` 来自驱动真实回传。
