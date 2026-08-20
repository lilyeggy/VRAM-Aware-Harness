# Sandbox 隔离方案评估（容器级 vs 虚拟机级）

> 评估基准机：阿里云 ECS `47.111.83.126`（AMD EPYC，8 vCPU / 30 GiB / Ubuntu 24.04.4 / Docker 29.7.2 / gVisor runsc release-20260810.0）。
> 文档日期：2026-08-18。所有结论严格区分「真机证据」与「推理/待验证」，不夸大。

## 0. 结论先行

- 在**当前这台无 KVM / 无 CPU 虚拟化扩展**的真机上，**`runsc`（gVisor user-space kernel）是最合适的多租户默认**：
  隔离 9 项攻击测试全 PASS，冷启动仅比 runc 慢 ~22%，运行期命令/IO 开销持平，且部署只需要 runsc 一个二进制（无 KVM 门槛）。
- **虚拟机级（Kata / Firecracker / microVM）是本架构 `strict` 档的演进方向**，但它**硬性依赖 KVM**，在这台真机上连进程都起不来。在取得 KVM 环境的真机证据之前，不把它当作"已通过"。

## 1. 隔离层级定位

```
共享宿主内核                                  内核与内核之间
──────────────────────────────┬──────────────┐
runc      runsc(gVisor)      │   Kata        Firecracker / microVM
namespace+  syscall 拦截      │   QEMU+KVM    精简 guest OS VM
cgroup     用户态内核          │   VM
──────────────────────────────┴──────────────┘
  容器级（当前 default=runsc）           虚拟机级（strict，未实现）
```

核心区别：**容器级与宿主共享同一个 Linux 内核**，隔离依赖内核自带机制；**虚拟机级是宿主内核与 guest 内核两个边界**，即使宿主内核被攻破，guest 也不受影响。

| 方案 | 内核边界 | 依赖 | 本真机证据 |
|---|---|---|---|
| runc | 共享宿主内核 | Docker 自带 | ✅ benchmark + 证据 |
| runsc | 共享宿主内核（syscall 拦截） | runsc 单二进制 | ✅ benchmark + attack 9 项 |
| Kata Containers | 独立 guest 内核 | KVM（QEMU 后端） | ❌ 无 KVM，不可运行 |
| Firecracker / microVM | 独立精简 guest 内核 | **必须 KVM** | ❌ 无 KVM，不可运行 |

## 2. 真机数据

### 2.1 性能对比（`sandbox-runtime-benchmark.ts`，5 次迭代 P50）

```
                     coldStart(P50)   command(P50)   io(P50)   cleanup(P50)
runc                  135.4 ms          40.0 ms       44.1 ms     62.2 ms
runsc                 165.9 ms          34.3 ms       43.9 ms     67.0 ms
runsc/runc 比值          1.225x          0.856x       0.997x      1.078x
```

- runsc 冷启动慢约 22%（gVisor 需初始化用户态内核 / sentry），是隔离的主代价。
- 沙箱启动后，单条命令反而略快（0.856x）、IO 持平——**运行期系统性开销可忽略**。
- 每次运行 `docker inspect` 验证 `observedRuntime` 与请求一致，证据完整、无错误、结果 PASS。

### 2.2 隔离强度（`container-sandbox-attack-smoke.ts`，runsc，9 项全 PASS）

```
runsc_runtime_evidence   runtime 证据（点击 runsc）       PASS
cross_tenant_workspace   跨租户 Workspace 不可见          PASS
host_path                宿主路径不可访问                 PASS
path_traversal           路径穿越被拦                    PASS
tenant_secret            他租户 Secret 读不到            PASS
network_none             无外部网络                      PASS
pid_limit                PID 数受限                     PASS
tmpfs_limit              tmpfs 容量受限                 PASS
sandbox_lost             容器被杀 → LOST 收敛            PASS
```

## 3. 评估矩阵（×6 维度）

评分：✅ 好 / ◐ 中 / ⚠ 弱 ｜ 标注【证据】表示本真机实测，【推理】表示逻辑推导、待 KVM 环境验证。

| 维度 | runc | runsc（gVisor） | Kata | Firecracker/microVM |
|---|---|---|---|---|
| 隔离强度 | ⚠ 共享内核、攻击面大【证据】 | ✅ syscall 拦截 9 项 PASS【证据】 | ✅ 独立 guest 内核【推理】 | ✅ 最小内核面【推理】 |
| 冷启动性能 | ✅ 135ms【证据】 | ◐ 166ms（1.22x）【证据】 | ❓ QEMU 更慢【推理】 | ❓ 最快 VM（<200ms 目标）【推理】 |
| 运行期开销 | ✅【证据】 | ✅ 持平【证据】 | ◐ 稍高 | ✅ |
| 部署门槛 | ✅ Docker 自带 | ◐ 需装 runsc、内核参数 | ⚠ 需 KVM + kata-runtime + 网络插件 | ⚠ 需 KVM + firecracker 二进制 |
| 资源密度 | ✅ 最密 | ✅ 密（单进程） | ◐ 每 VM 有固定开销 | ◐ 每 VM 有一定开销 |
| 兼容面 | ✅ 全 syscall | ⚠ 部分 syscall 不支持（GPU/部分工具会失效） | ◐ 完整 guest 内核 | ⚠ 精简内核、驱动少 |
| 运维复杂度 | ✅ 最低 | ◐ 低 | ⚠ 高 | ⚠ 高 |

> runc 因隔离弱且架构已对 `default` fail-closed 禁止回退 runc，**仅作性能 baseline**，不是候选生产档。
> Kata/Firecracker 列全部【推理】，在取得 KVM 真机证据前不等同于通过。

## 4. 为什么这里选 runsc

1. **隔离到位**：9 项真机攻击测试全 PASS，覆盖跨租户文件/Secret、宿主路径、路径穿越、网络、PID/tmpfs。
2. **性能可接受**：冷启动 1.22x，运行期持平；对多租户「few 常驻 sandbox」模型足够。
3. **无 KVM 也能真跑**：这是当前按量收费（~¥1.6/h）AMD 实例上唯一拿得到真机证据的强隔离方案。
4. **fail-closed 一致**：runtime 不符就拒绝，从不静默降级。

## 5. 虚拟机级（strict）的真实前置条件与诚实边界

要在某台机器上真跑 Kata / Firecracker 并产出可写进简历的证据，需要：

- `/dev/kvm` 存在，且 CPU 暴露 `vmx`/`svm`（本次探测：**两者皆无**）。
- 阿里云多数性价比 AMD 实例不提供嵌套虚拟化；需 `开启嵌套虚拟化` 的实例类型，或自有/本地暴露 KVM 的主机。
- 安装 `kata-runtime` / `firecracker`、为其配 rootfs/CNI 或 devmapper（Firecracker 需 tap/macvtap 网络）。
- 之后才能做与 2.2 同款的攻击测试 + 冷启动/IO benchmark。

在这些条件满足前，对 microVM 的任何"通过"结论都**不成立**，也不应宣称。

## 6. 演进决策建议

- 短期（当前预算/真机）：保持 `default=runsc`，可定期复跑 benchmark + attack 留证据。
- 中期（想展示 VM 级隔离）：租/借一台暴露 KVM 的机器（预算允许时按量），跑 Kata 或 Firecracker 的同一套 attack + benchmark，产出真机对比再写进简历。
- strict 档位在代码里已就位（`SandboxProviderRouter` strict 槽 + `UnavailableStrictSandboxProvider` fail-closed），接入 Kata/Firecracker 只需提供对应 Provider 实现，控制面无需改动。

## 参考工具与脚本

- `scripts/sandbox-runtime-benchmark.ts`：`HARNESS_BENCHMARK_RUNTIMES=runc,runsc` 现场对比。
- `scripts/container-sandbox-attack-smoke.ts`：runsc 隔离攻击测试。
- `scripts/container-sandbox-smoke.ts`：容器 smoke。
- `src/sandbox/sandbox-profile.ts` / `sandbox-provider-router.ts`：profile ↔ runtime 映射与 strict 槽。
