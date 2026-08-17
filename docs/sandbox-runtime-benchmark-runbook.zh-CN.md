# Sandbox Runtime 对比实验手册

> 目标：用同一 Harness Sandbox 生命周期、镜像、Workspace、命令和资源限制，对不同 runtime 做可复现实验；不把单机 benchmark 结果误写成安全结论。

## 当前范围

当前代码可以直接测：

- `runc`：仅作为 development benchmark baseline，不是多租户 default；
- `runsc`：P0.5 default candidate，必须通过 `docker inspect` 取得实际 runtime evidence。

Kata/Firecracker 不在本项目内自研 VMM。它们接入后应实现同一 `SandboxProvider` 合同，再加入本实验矩阵；在 Provider 尚未接入前，不得填写虚构结果。

## 执行

在 Linux、Docker daemon、目标 runtime 和非 root容器 UID 都可用的机器上执行：

```bash
export HARNESS_CONTAINER_USER_ID="$(id -u)"
export HARNESS_CONTAINER_IMAGE=alpine:3.20
HARNESS_BENCHMARK_ITERATIONS=10 bun run benchmark:sandbox
```

只测单个 runtime：

```bash
HARNESS_BENCHMARK_RUNTIMES=runsc bun run benchmark:sandbox
HARNESS_BENCHMARK_RUNTIMES=runc bun run benchmark:sandbox
```

脚本不把 runtime 缺失伪装成 PASS：

- 两个 runtime 都通过：`result = PASS`；
- 只有部分 runtime 通过：`result = INCOMPLETE`；
- 没有 runtime 通过：`result = NO_RUNTIME_AVAILABLE`，进程退出非零。

## 测量内容

每个 runtime 使用同一镜像和每次新建的 Workspace，重复执行 N 次：

| 指标 | 定义 | 解释 |
| --- | --- | --- |
| `coldStartMs` | `SandboxProvider.create()`，包括 `docker run` 和 runtime inspect 证据 | 数据面冷启动成本；不是完整 Run 启动延迟 |
| `commandMs` | Sandbox 内执行 `true` 的 `docker exec` 往返时间 | 命令边界固定开销 |
| `ioMs` | 读取 Workspace 文件并向 Sandbox tmpfs 写入 8 MiB | 文件 I/O 粗粒度对照，不是完整 Agent workload |
| `cleanupMs` | `SandboxProvider.terminate()` 到清理完成 | 回收和 slot 收敛相关的基础数据 |
| `observedRuntimes` | 每次 `docker inspect` 的实际 runtime | 防止把配置值误当成实际 runtime |

输出包含原始样本、P50/P95 汇总和 runsc/runc 描述性比值。比值不是跨机器、跨内核或跨镜像的普遍结论。

## 实验控制变量

每次对照应固定：

- Linux kernel、发行版、CPU、内存和负载；
- Docker Engine 版本；
- Alpine/业务镜像 digest，而不是只写 floating tag；
- `HARNESS_CONTAINER_USER_ID`；
- CPU、memory、PID、network 和 mount 策略；
- Workspace 初始文件；
- benchmark iteration 数量、预热策略和并行度；
- Docker daemon 配置和 runtime 配置。

建议至少分别执行：

1. 空闲主机冷启动；
2. 两 Tenant 交错创建 Sandbox；
3. CPU/内存/PID 压力下的启动和清理；
4. Sandbox kill 后的 LOST 收敛；
5. Agent 代表性命令集：Git、Node/Python 测试、文件扫描和编译。

## 安全实验不能由性能 benchmark 代替

性能脚本只测 runtime 成本。隔离结论必须另外运行：

```bash
bun run smoke:container:attacks
```

该攻击 smoke 覆盖跨 Tenant Workspace/Secret、宿主路径、路径穿越、默认网络、PID/tmpfs 资源和 Sandbox kill → LOST。它也必须在真实 Linux Docker + runsc 环境执行。

## 结果判定建议

不要用单一“最快”指标选 default。建议按下面顺序决策：

1. **硬门槛**：实际 runtime、Tenant 文件/Secret、宿主路径、网络和资源攻击必须通过；
2. **兼容性**：代表性 Agent 命令集不能出现未解释的 syscall/工具失败；
3. **生命周期**：创建、LOST、terminate、重启恢复不泄漏 Sandbox/slot；
4. **性能**：比较 P50/P95 冷启动、命令和 I/O；
5. **密度**：在同一机器上观察并发 Sandbox 的 CPU、内存和回收抖动；
6. **运维**：镜像、runtime、网络、日志、升级和故障排查成本。

推荐记录每轮原始 JSON、主机信息、Docker/runtime 版本和攻击 smoke 输出。没有真实数据时，只记录“未验证”，不写“runsc 更快”“Firecracker 更安全”等结论。

## 候选选择原则

- 常规 Agent 文件/Shell/Git/测试：优先比较 `runsc` 与 runc baseline；
- 需要更强 guest-kernel 边界：通过 `strict` Provider 比较 Kata/Firecracker；
- 需要公网：必须先接入受控 egress proxy，不能把 `--network bridge` 当作域名白名单；
- 需要 GPU：模型访问优先走 Harness 受控模型入口，不把 GPU 直接暴露给 Sandbox；
- 需要长状态会话：额外测 snapshot/pause/resume 成本，不能只看 cold start。
