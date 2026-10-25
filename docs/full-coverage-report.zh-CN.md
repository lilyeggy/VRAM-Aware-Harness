# 全方位真机全流程验证报告

日期：2026-10-12 ~ 2026-10-13
真机：`172.17.43.193`（Ubuntu 22.04 / 内核 6.8.0-136 / Firecracker v1.17.0 + jailer / ext4 宿主）
被测：

| 实例 | 端口 | 说明 |
| --- | --- | --- |
| 生产 | 3100 | `harness.service`（User=cxr，systemd worker，jailer + 快照，外部 opencode-go `deepseek-v4.1-flash`）+ `harness-broker.service`（root） |
| 测试 | 3210 | `/data/harness/fullcoverage-test/`，独立 DB/workspace/快照池/socket（`/run/harness-fullcov/sandbox-broker-test.sock`）、invite 模式 |

## 1. 结论摘要

| 维度 | 结果 |
| --- | --- |
| HTTP/API 与用户旅程（生产实例） | 36 项断言，修复后全通过（首轮 34/36） |
| 全覆盖矩阵（测试实例，45 项 × 5 phase） | base 通过 38 + 跳过 7 + 失败 0（**F-K 已修复并复跑验证**，见 §6.1）；priority / backpressure / ratelimit / mcp 全部 PASS |
| 故障注入与恢复（p0 e2e、F1/F2、F4/F5/F7） | p0 `P0_E2E_SMOKE_OK label=48ae079c`；`PHASE5_FAULT_INJECTION_OK f4=COMPLETED f5=skipped f7=ok`；F1/F2 `PHASE5_WORKER_CRASH_OK label=batteryD f1=path=supervisor f2=recoveredRun=97803846-…`；F-K 修复后复跑 F1/F2 `PHASE5_WORKER_CRASH_OK label=postfk f1=path=supervisor unit=harness-worker-552e8a67-… f2=recoveredRun=c736f676-…`（`waitForWorkerUnit(90_000)` 竞态修复后首次稳定通过） |
| 持久化与审计 | RUNNING 期间备份 + 备份上审计链校验 `ok:true checked=7962 legacy=0` |
| 运维 | `disk-check`、`cleanup`（含新增 fail-closed 保护）、`backup`、maintenance timer 全部可用 |
| HTTPS 全链路 | `P0_E2E_SMOKE_OK label=d09cc195`（经 `127.0.0.1:8443` 自签 TLS 反代）；F-K 修复后复跑 `P0_E2E_SMOKE_OK label=tls-postfk`（2026-10-13 01:00；`concurrent maxActive=2 overlap=true`、跨用户 404 全集） |
| 平台侧隔离性 | `SANDBOX_SECURITY_PROBE_OK` 13/13 |
| 本地/远程单测 | 675 pass / 10 skip / 0 fail；typecheck 仅 9 条既有基线错误 |

## 2. 方法与分工

1. **生产用户旅程**（`/tmp/prod-journey.py`，36 项）：注册/登录/会话/workspace/发消息/Run 轮询/events/output/workspace-diff/artifacts/decisions/limitations/queue/resources/billing/audit/metrics/跨用户 404 全集/终态中断。
2. **独立测试实例全覆盖矩阵**（`scripts/full-coverage-smoke.ts` + `scripts/run-full-coverage-phases.sh`）：同一实例按 phase 重启 Master，覆盖 happy path、7 个内置工具、幂等、priority、backpressure、限流、MCP。
3. **平台侧探针与故障电池**（`scripts/sandbox-security-probe.ts`、`scripts/p0-e2e-smoke.ts`、`scripts/phase5-fault-injection.ts`、`scripts/phase5-worker-crash.ts`、`scripts/audit-chain-smoke.ts`、`scripts/user-billing-smoke.ts`、`scripts/harness-ops.ts`、`scripts/dev-tls-proxy.ts`）。

## 3. 全覆盖矩阵（`scripts/full-coverage-smoke.ts`）

phase 由 `scripts/run-full-coverage-phases.sh` 编排（每个 phase 重启一次测试 Master 以套用不同的容量/限流/MCP 配置）：

| phase | 配置要点 | 结果 |
| --- | --- | --- |
| base | 默认容量、无 MCP | 45 项：PASS 38 / SKIP 7 / FAIL 0（复跑 2026-10-13 00:53~00:54；修复前为 PASS 34 / FAIL 4，四条 FAIL 全部由 F-K 派生） |
| priority | `HARNESS_MAX_ACTIVE_RUNS=1` | PASS |
| backpressure | `HARNESS_MAX_ACTIVE_RUNS=1` + `HARNESS_MAX_QUEUED_RUNS=1` | PASS（此前因启动对账缺陷 MASTER_DOWN，见 F-G） |
| ratelimit | `HARNESS_RATE_LIMIT_MAX_PER_IP=2` + `FULLCOVER_ONLY=system.ratelimit` + `FULLCOVER_SKIP_BOOTSTRAP=1` | PASS（此前脚本自身注册撞 429） |
| mcp | `HARNESS_MCP_SERVERS` 指向 `tests/mcp/fixtures/echo-mcp-server.ts` | PASS |

base 覆盖：health/ready/metrics；注册（无/错邀请码 403、弱密码 400、重复邮箱 409、正确 201）；登录/登出/DELETE sessions；workspace；conversation（两种创建路径）；消息 → Run → 终态；`/runs/:id` 的 events/output/workspace-diff/artifacts/decisions/limitations/unknown-effects；`/queue`、`/resources`（HOST_WIDE）；7 个内置工具各一个 Run（bash/read/write/edit/grep/find/ls）；跨用户 404 全集；UI 等价旅程。
7 个 SKIP 为 `run.subroute.{decisions,limitations,unknown-effects}`（平台无独立路由，数据在 `GET /runs/:id` 内联，由 `run.detail.inline` 覆盖）、`run.priority`、`run.backpressure`、`system.ratelimit`、`mcp.echo`（分别在对应 phase 中启用，属设计内跳过）。

## 4. 故障注入与恢复

### 4.1 进程级故障（F4/F5/F7）

`scripts/phase5-fault-injection.ts`：

- 默认配置：`PHASE5_FAULT_INJECTION_OK label=faultops-1791819332 f4=COMPLETED f5=skipped f7=ok`。
- backpressure 配置（`HARNESS_MAX_ACTIVE_RUNS=1`、`HARNESS_MAX_ACTIVE_RUNS_PER_USER=1`、`HARNESS_MAX_QUEUED_RUNS=2`）：F5 第 3 个提交被拒 429 + `Retry-After`。

### 4.2 Worker 崩溃（F1/F2）

`scripts/phase5-worker-crash.ts`：提交 `sleep 180` 的 Run → 等 Worker systemd 单元出现 → `systemctl kill -s KILL <unit>` → 观察 Run 收尾与恢复决策。

首次真机执行暴露出**脚本竞态**（F-I）：Run 状态先落库为 RUNNING，Worker 单元随后才创建，脚本只查一次导致 `F1 找不到运行中的 harness-worker-* 单元`。已修：新增 `waitForWorkerUnit(timeoutMs)` 轮询（90s，2s 间隔）。

复跑（2026-10-13 00:23）通过：

```
PHASE5_WORKER_CRASH_OK label=batteryD f1=path=supervisor \
  unit=harness-worker-6bf1358b-6a8e-40fe-b37e-7a2418fd65ea.service \
  run=6bf1358b-6a8e-40fe-b37e-7a2418fd65ea \
  f2=recoveredRun=97803846-1078-4cd6-8251-f274bd09b6d2
```

- **F1（Worker 被 KILL）**：Master 能观察到 Worker 退出 → 走 supervisor 路径，Run 以 `FAILED`（`WORKER_CRASHED`）收尾，不残留 firecracker/jailer/worker。
- **F2（Broker 被停）**：Broker 不可达时 Master fail-closed，恢复 Broker 后由恢复路径续跑得到 `recoveredRun`；Master 全程保持 active（`harness.service` 的 `Wants=` 而非 `Requires=`，见 §9.9 v1.5 记录）。

### 4.3 持久化与审计

- RUNNING 期间 `harness-ops.ts backup` → `/data/harness/backups/harness-20261011T124518Z.sqlite`（3,616,768 bytes）。
- 在备份文件上跑 `audit-chain-smoke.ts --database <备份>` → `AUDIT_CHAIN_VERIFY_OK`。
- 生产库实测：`{"ok":true,"checked":7962,"legacy":0}`。

## 5. 平台侧隔离性探针（`scripts/sandbox-security-probe.ts`）

13/13 PASS（`SANDBOX_SECURITY_PROBE_OK failed=[]`），与生产 broker 同一构造（jailer + 快照 + 共享只读基础文件），不经过 HTTP/Agent：

- guest 只有 `lo`（无网卡、无路由）；`curl/wget/nc` 不可用，`ping` 报 `Network unreachable`；
- 授权 secret 注入成功、宿主模型 key（哨兵值）未进入 guest、未授权 secret 未注入；
- guest 看不到宿主 `/home/cxr`、`/etc/harness`、`harness.sqlite`；
- rootfs 只读（`touch /etc` → `Read-only file system`）、`/tmp`/`/run`/`/var/tmp` 为 tmpfs、`/workspace` 可写；
- 跨沙箱：A 写入的 `marker-a.txt` 在 B 不可见。

**教训（重要）**：同类探测交给 Agent 工具链会失败 —— 模型会把“遍历宿主目录 + 找数据库 + 读凭据环境变量”判定为凭据搜集攻击并**拒绝调用任何工具**（Run `a50879c3-8340-4f05-8674-ba2b6286456a` 零工具调用，thinking 原文 “I should decline to help extract secrets”）。平台级隔离性断言必须在平台侧用 `provider.execute` 直接下探。

## 6. 发现的问题与处置

| 编号 | 严重度 | 问题 | 处置 |
| --- | --- | --- | --- |
| F-A | 中 | 对已 COMPLETED / 非 INTERRUPTED 的 Run 调 `POST /runs/:id/interrupt`、`/resume` 返回 500（`终态 Run 不能中断` 未映射） | 已修：`src/http/routes/runs.ts` 返回 409 + 明确文案；`tests/http/harness-http-api.test.ts` 回归用例（提交 d8b5a93） |
| F-B | 低 | `GET /runs/:id/artifacts/:artifactId` 第三段实际是产物 **path**，字段名易误导 | 已文档化，不改路由（`web/app.js` 依赖该形状） |
| F-C | 中 | `RUN_COMPLETED` / `finished_at` 先落库，产物与 workspace-diff 在 `RUN_ARTIFACTS_READY` 才就绪，窗口实测约 232ms | 契约明确为“等 `RUN_ARTIFACTS_READY`”；矩阵脚本已按契约等待（`waitForArtifactsReady`） |
| F-D | 中 | `SESSION_INITIALIZED → MODEL_STARTED` 空档实测 2404ms / 11135ms，区间无埋点；外部模型服务不可达时只能等 `HARNESS_EXECUTION_TIMEOUT_MS`（默认 30 分钟） | 未修（建议：补 provider 初始化阶段事件、外部模型可达性探测、下调执行超时） |
| F-E | 高 | 生产 `harness-broker.service` 的 `RuntimeDirectory=harness` 会清空整个 `/run/harness`；任何把 socket 放同目录的其它实例会被静默波及（实测导致测试实例 13 条 Run 全部 `connect ENOENT` 后 INTERRUPTED） | 测试/并行实例改用独立 socket 目录（`/run/harness-fullcov`）；部署文档补充“不要把其它实例 socket 放进生产单元 RuntimeDirectory” |
| F-G | 高 | `src/sandbox/sandbox-startup-reconciler.ts` 用陈旧状态做乐观锁 CAS，Provider 在清理期间收敛状态后抛 `Sandbox 状态已变化`，导致 **Master 拒绝启动** | 已修：`isSettledSandboxStatus` + 重读兜底 + 记账失败不覆盖原始原因；`tests/sandbox/sandbox-startup-reconciler.test.ts` 3 用例 |
| F-H | 高 | `harness-ops cleanup --snapshot-pool` 在缺少 `FIRECRACKER_KERNEL_PATH/ROOTFS_PATH` 时保护名单为空，会按 mtime 删掉在用黄金快照；部署的 `/usr/local/sbin/harness-maintenance` 落后于仓库示例（未读 `broker.env`） | 已修：默认 fail-closed 跳过（`HARNESS_OPS_CLEANUP_SNAPSHOT_POOL_SKIPPED`）+ 显式 `--no-protect-current-template` 才清理；部署脚本改为读取 `broker.env`；真机复验 `snapshotPoolProtected=1` |
| F-I | 低 | `scripts/phase5-worker-crash.ts` 在 RUNNING 与 Worker 单元创建之间存在竞态 | 已修：`waitForWorkerUnit(90_000)` 轮询 |
| F-J | 低 | `workspace-diff` 的 `modified` 条目是 `{before, after}` 包装（无顶层 `path`），矩阵脚本按 `item.path` 取到 `null` | 既有的 N24 契约（UI 已用 `diffPath` 补偿）；矩阵脚本按契约修正，API 形状不变 |
| F-K | **高** | **工作区文件不跨 Run 持久**：guest 每个 Run 从静态工作区模板（`FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH`）新建可写盘，宿主工作区目录只在 Run 结束时接收导出（artifacts / workspace-diff），从未回灌进下一次 Run 的盘 | **已修并真机复验**（§6.1）：宿主目录播种进本 Run 的盘；播种 Run 一律冷启动（不恢复/不制作快照），空工作区仍走热恢复 |

### 6.1 F-K 详述（本轮最重要的产品级发现）

**证据（生产实例 3100，同一 workspace `2124694a-1cad-4124-b7a7-f826b1a15591`，2 分钟内连续三个 Run）**

| 步骤 | Run | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | `94ed81a6-e2da-4f91-9cd1-da36a7f4c873` | `echo persist-check-123 > persist.txt` | 成功（TOOL_COMPLETED `(no output)`） |
| 2 | `608db158-2f4f-4460-9c57-c3a51ad87514` | `ls -1` | 只有 `lost+found` —— 工作区是空的 |
| 3 | `02450d88-5191-4048-8916-417db3910f7d` | `cat persist.txt` | `cat: can't open 'persist.txt': No such file or directory` |

**机制**（`src/sandbox/microvm/microvm-sandbox-provider.ts`）：`create()` 用 `copyFileReflink(workspaceTemplate, dir.workspaceDiskPath())` 造盘（模板是空 ext4），`terminate()` 才 `diskExporter.exportToHost(diskPath, workspacePath)` 把 guest 内容导出到宿主工作区。**没有任何反向路径**把宿主工作区内容写回新盘。

**影响**：对“多轮对话式 Agent 助手”是致命的 —— 用户第一轮让 Agent 生成文件，第二轮再让它处理该文件，永远失败；矩阵里的 `tool.write → tool.edit` 跨 Run 序列失败就是这个原因（此前误判为 `workspace-diff` 形状问题）。

**修复方案（已实施并复验）**

1. **每 Run 造盘时用宿主工作区目录播种**：`mke2fs -q -t ext4 -F -d <workspacePath> -L workspace <disk> <blocks>`（真机实测 **3ms**，e2fsprogs 1.46.5；宿主目录为空/`HARNESS_VM_WORKSPACE_SEED=0`/无 `mke2fs` 时继续走模板复制快路径）。
2. 保留 `workspaceScope: "RUN"` 的隔离语义（各 Run 各自独立盘），只是把“上一次的产物”作为输入种子。
3. **播种 Run 必须冷启动**（本轮真机发现的硬约束）：播种出来的 ext4 布局与黄金快照时的工作区盘不同，恢复快照的 guest 内存里持有旧盘的块位图/目录缓存，于是第二轮 `cat` 报 **`Bad message`**、`workspace-diff` 全空 —— 即“宿主播种 + 快照恢复”互斥。实现上 `prepareWorkspaceDiskFromHost()` 返回 `{ seeded }`，驱动把 `workspaceDiskSeeded === false` 同时加进 `canRestore` 与 make-snapshot 闸门；空工作区（fast path）语义不变，仍走热恢复。

**真机复验（生产实例 3100，代码 `e95f0b7`）**

| 步骤 | 观测 | 结果 |
| --- | --- | --- |
| 修复前探针 RUN2 | `cat: can't open 'fk-marker-1791823576.txt': Bad message`，`workspace-diff` 空 | 复现根因 |
| 修复后探针 RUN1（宿主工作区为空） | `SANDBOX_ACQUIRED {durationMs:98,warmHit:true}`；diff `added=[fk-marker-1791823929.txt]` | 热恢复保留 |
| 修复后探针 RUN2（宿主工作区非空 → 播种） | `SANDBOX_ACQUIRED {durationMs:210,warmHit:false}`；`TOOL_COMPLETED {text:"hello-fk\n"}`（读到了第一轮写的文件） | F-K 修复生效 |
| 测试实例 base 复跑 | `COUNTS {'PASS': 38, 'SKIP': 7}`；`workspace.persistence PASS 跨 Run 可见：第二轮 cat 读到了 persist-1791824012975`；`tool.write` / `tool.edit` / `tool.bash` 全部 PASS（diff 非空） | 四条 FAIL 归零 |

**已知代价与后续**：播种 Run 从热恢复（~98ms）变为冷启动（~210ms，仍远低于早期 1334ms）。要把热路径拿回来，需要让 guest 在恢复后重新挂载/接受工作区内容（guest 侧 remount `/dev/vdb` 或经 vsock 流式写入），需改 `guest/agent/agent.c` 并升 `HARNESS_GUEST_AGENT_VERSION`（会重建快照池）；作为独立优化项记录，不影响当前正确性。

**边界影响**：这是边界内承诺的实现缺口（不是新增能力），按 `docs/platform-boundary.md` §9.6 属于允许的“缺陷修复”，不需要解冻决策。

## 7. 未覆盖 / 边界外

- 网络：Agent 无 egress 是**设计内**能力边界，未做“允许出网”验证。
- 多机/HA：单机部署，无 lease/replication/故障转移验证（§9.8 v1.4 明确不做）。
- 大模型并发：矩阵 N 级并发已在 `docs/vm-lifecycle-benchmark.zh-CN.md` 覆盖 VM 侧；本轮矩阵的并发压力集中在调度/队列语义。
- 密码/MFA/管理员后台、用户配额与计费强制力：边界外（见 `docs/platform-boundary.md` §9.3）。
