# 生产实例真机全流程验证报告（2026-10-12）

对象：`172.17.43.193` 上的**生产实例**（不是测试实例）——`harness.service`（Master，`0.0.0.0:3100`，非 root，systemd 每 Run worker）+ `harness-broker.service`（root，jailer + Firecracker v1.17.0，启用快照）+ `harness-vm-prewarm.timer` + `harness-maintenance.timer`，`HARNESS_ENV=production`、`HARNESS_REGISTRATION_MODE=invite`，模型为外部 `opencode-go/deepseek-v4.1-flash`。

方法：用 Python 标准库按**用户可见顺序**离线跑一遍完整旅程（注册 → 登录 → 建 Workspace → 建会话 → 发消息 → 轮询 Run → 读 events/output/workspace-diff/artifacts/artifact 内容 → 队列/资源/账单/审计/指标 → 跨用户拒绝 → 中断/恢复 → 登出），共 36 项断言；随后对两次 Run 直接只读查询 SQLite 取时间线证据。

## 1. 结果

第一轮 36 项：34 PASS / 2 FAIL（见 §3 的两条发现）。修复后复跑 `PROD_RECHECK_OK failed=[]`。

| 分组 | 断言 | 结果 |
| --- | --- | --- |
| 进程与静态资源 | `/health`、`/app`（含“外部模型服务”新文案、N29 表格渲染代码） | PASS |
| 注册收口 | 无邀请码 403、错邀请码 403、弱密码 400、正确 201、重复邮箱 409 | PASS |
| 登录/登出 | 错密码 401、正确 200 + token、登出 200 | PASS |
| Workspace/会话 | 建 Workspace 201、列表含新建、建会话 201 | PASS |
| Run 提交 | 发消息 202、**同 idempotencyKey 重放返回同一 runId** | PASS |
| Run 终态 | 轮询到 `COMPLETED` | PASS |
| Run 事件 | `SANDBOX_ACQUIRED`、`TOOL_STARTED/COMPLETED`、`RUN_ARTIFACTS_READY` 均在 | PASS |
| Run 产物 | output 含 `4.14.174`、workspace-diff `added=result.txt`、artifacts 1 条、按 path 取内容含 `prod-flow-ok` | PASS |
| Run 明细 | `/runs/:id` 含 `decisions`/`limitations` | PASS |
| 用户视图 | `/queue`、`/resources`、`/billing`、`/audit` 均 200 | PASS |
| 指标 | `/metrics` 200（bootstrap key） | PASS |
| 跨用户 | 另一个用户读 run/events/output/artifacts 全 404、interrupt 404 | PASS |
| 终端态语义 | 终态 Run 的 interrupt/resume 返回 409（修复前 500） | PASS（修复后） |

## 2. 真机时间线证据（SQLite 只读查询）

Run `8dbdd1be-456a-4750-b336-1ca145a2c0ec`（invite 模式、新用户、`bash` 工具建文件）：总墙钟 7563ms。

```
+   0 RUN_CREATED
+   4 CONTROL_PREPARED {"durationMs":1}
+  76 SANDBOX_ACQUIRED {"durationMs":73,"warmHit":true,"profile":"strict"}
+2645 SESSION_INITIALIZED {"durationMs":6,"mode":"NEW"}
+5049 MODEL_STARTED  (opencode-go/deepseek-v4.1-flash)
+5479 MODEL_FIRST_TOKEN (thinking)
+5790 MODEL_COMPLETED durationMs=741 stopReason=toolUse
+5791 TOOL_STARTED bash {"command":"echo prod-flow-ok > result.txt && uname -r"}
+5798 TOOL_DISPATCHED   (网关记账)
+5812 TOOL_SETTLED      (网关记账)
+5813 TOOL_COMPLETED    {"content":[{"text":"4.14.174\n"}]}
+6654 MODEL_STARTED (第二次调用)
+7562 MODEL_COMPLETED durationMs=909 stopReason=stop
+7563 RUN_COMPLETED
+7795 RUN_ARTIFACTS_READY {"artifactCount":1}
attempt#1 START SUCCEEDED durationMs=7487；artifact result.txt 13B；diff added=[result.txt]
```

Run `42bfd88e-4768-44da-ad27-72098d65bc0c`（修复后复验）：总墙钟 13296ms，`SANDBOX_ACQUIRED durationMs=56 warmHit=true`，工具调用到结果 26ms，`RUN_ARTIFACTS_READY` 同样在终态之后。

要点：
- 用户可见链路（HTTP → 调度 → RunAttempt 租约 → broker → jailer microVM → 工具 → 模型 → 产物导出 → 审计/账单/指标）在 production 模式下端到端可用，**热恢复夺取沙箱 56~73ms（warmHit=true）**。
- 工具调用一次只有一条 `TOOL_STARTED`/`TOOL_COMPLETED`，网关记账是独立的 `TOOL_DISPATCHED`/`TOOL_SETTLED`——此前"同一 toolCallId 重复 TOOL_*"缺陷在生产实测中未再出现。
- 并发/跨用户语义与 p0 smoke、Phase 1-5 的结论一致。

## 3. 发现

### F-A（平台缺陷，已修 `d8b5a93`）终态 Run 的中断/恢复返回 500 而不是 409
`POST /runs/:id/interrupt` 对一个已 COMPLETED 的 Run 穿透到 HTTP 兜底，返回 `500 {"error":"内部错误，请稍后重试"}`——而这是客户端可预期的冲突。根因：`src/runs/run-service.ts` 的 `interrupt` 抛 `终态 Run 不能中断:<id>`，`src/http/routes/runs.ts` 的 `interruptRun` 未映射；`resumeRun` 同理会把非 INTERRUPTED 的恢复请求交给状态机（`非法的 AgentRun 状态转换`）。
修复：`src/http/routes/runs.ts:190-210` 增加显式前置校验——终态（COMPLETED/FAILED）中断 → 409 `终态 Run 不能中断：<id>`；非 INTERRUPTED 恢复 → 409 `只有 INTERRUPTED 的 Run 可以恢复，当前状态：<status>`；两条 DENY 审计。回归测试 `tests/http/harness-http-api.test.ts`（终态 409 / RUNNING 恢复 409 / RUNNING 中断仍 200）。生产复验：`409 {"error":"终态 Run 不能中断：42bfd88e…"}`、`409 {"error":"只有 INTERRUPTED 的 Run 可以恢复，当前状态：COMPLETED"}`。

### F-B（脚本/契约问题，非缺陷）产物内容是**按 path** 取，不是按 id
`GET /runs/:id/artifacts` 返回 `{runId, path, hash, size, createdAt}`，没有 id 字段；`GET /runs/:id/artifacts/:artifactId` 的第三段实际是产物 path（`src/app/harness-application.ts:257 getRunArtifact(runId, path)`，`web/app.js:484` 用 `encodeURIComponent(path)`）。首轮脚本按 id 取导致 404；按 `result.txt` 取返回 200 与内容。**契约本身自洽，但字段名 `:artifactId` 容易误导调用方**，建议文档注明（不改路由，避免破坏既有 UI）。

### F-C（真实窗口，未修）终态可见早于产物就绪
`RUN_COMPLETED`/`finished_at` 在 +7563 写入，而产物捕获完成（`RUN_ARTIFACTS_READY`）在 +7795——存在约 232ms 窗口：客户端"看到终态后立刻取 artifacts"可能拿到空列表。Phase 3 已加 `RUN_ARTIFACTS_READY` 事件作为就绪信号，但状态本身仍先落地。建议：轮询/UI 以 `RUN_ARTIFACTS_READY` 为产物就绪判据，或把 artifact 捕获前移到终态写入之前（后者会拉长终态延迟）。

### F-D（真实缺口，未修）首个模型调用前的空档没有观测
两次真机运行中 `SESSION_INITIALIZED → MODEL_STARTED` 分别是 **2404ms** 与 **11135ms**；该区间完全黑盒（worker 单元只记 systemd 的 Started/Deactivated，CPU 1.1~1.3s）。这与我们已知的该宿主 egress 脆弱性一致（`/etc/hosts` 里仍有一条 `harness-model-pin` 把 opencode.ai 钉到可用 IPv6）。建议：① 在 Pi/provider 初始化周围补一条阶段事件（复用 `[vm-phase]` 式打点思路）；② 外部模型服务加启动可达性探测与更短的请求超时；③ `HARNESS_EXECUTION_TIMEOUT_MS` 从 30 分钟下调。

## 4. 未覆盖（本轮）
- 并发规模压力（10/50/100 并发）→ 由 `scripts/full-coverage-smoke.ts`（测试实例）与 `scripts/vm-lifecycle-benchmark.ts`（并发 1/2/4/8/10）覆盖。
- 故障注入 F1-F7、备份/审计/账单/运维/TLS → 由故障运维电池覆盖（见 `docs/fault-ops-report.zh-CN.md`）。
- 浏览器端 UI 交互（本报告只验证 `/app` 静态页与新文案在，用户旅程由 HTTP 契约等价复现）。
- 隔离性只能平台侧下探（Agent 会拒答这类命令）→ 见 §5。

## 5. 平台侧隔离性探针（真机 13/13）

### 5.1 为什么必须绕过 Agent（模型拒答）
曾把"guest 无网卡 / 看不到宿主 / 模型 key 不在沙箱"写成一条工具命令交给 Agent 执行，结果模型**直接拒绝**：Run `a50879c3-8340-4f05-8674-ba2b6286456a` 没有发起任何工具调用（单次 `MODEL_COMPLETED stopReason=stop`），thinking 认为这是凭据搜集/外传探测（“This is suspicious… I should decline to help extract secrets”），最终回答 761 字符拒绝执行并给出"去敏感化"的替代命令。

→ 结论：**平台级隔离断言不能靠 Agent 工具链验证**（模型出于安全理由拒答，与被测系统的隔离性无关，而且拒答不等于隔离成立）。必须在平台侧用 `provider.execute` 直接下探。

### 5.2 探针
`scripts/sandbox-security-probe.ts`（与生产 broker 同一构造：`FirecrackerSandboxDriver` + `MicrovmSandboxProvider` + `InMemorySandboxStore`，jailer + 快照 + 共享只读基础文件），建两台沙箱：

- `security-probe-a`（user `probe-a`，`allowedSecrets=["PROBE_TOKEN"]`，环境里种入 `HARNESS_SECRET_<HEX(probe-a)>_PROBE_TOKEN=planted-secret-value`）
- `security-probe-b`（user `probe-b`，无 secret）
- 同时把 `OPENCODE_API_KEY`/`PI_AUTH_TOKEN` 设为哨兵值 `should-never-reach-guest-model-key`，用于证明宿主模型凭据不进沙箱。

输出 `SANDBOX_SECURITY_PROBE_OK` / `_FAIL failed=[…]`，结束 terminate 两台并清理工作区。

### 5.3 真机结果（172.17.43.193，jailer + Firecracker v1.17.0，256MiB guest，`HARNESS_VM_SHARE_ROOTFS=1`）
`ACQUISITION A={"durationMs":60,"warmHit":true} B={"durationMs":69,"warmHit":true}`（命中快照池）

| 断言 | 证据 |
| --- | --- |
| 只有 lo 网卡 | `ls /sys/class/net` → `lo`；`ip -o link` 只有 `lo`（`state DOWN`） |
| 无法出网 | guest 内无 `curl`；`wget`/`nc`/`ping 1.1.1.1` 全部 `Network unreachable`；无路由表 |
| guest 内 root | `uid=0(root) gid=0(root)`，PID1 = `init` |
| 内核 | `Linux (none) 4.14.174` |
| 被授权 secret 进沙箱 | `PROBE_TOKEN=planted-secret-value` |
| 宿主模型 key 未进沙箱 | guest `env` 只有 `PATH/PROBE_TOKEN/PWD/SHLVL`，哨兵值 0 次命中 |
| 宿主文件系统不可见 | `/home/cxr`、`/home/cxr/agent-harness-mt/data`、`/var/lib/harness-worker`、`/etc/harness` 全部 `No such file or directory`；`find / -maxdepth 4 -name harness.sqlite` 无命中 |
| rootfs 只读 | `touch /usr/local/...`、`touch /etc/...` → `Read-only file system`；`/dev/root on / type ext4 (ro,…)` |
| /tmp 可写（tmpfs） | `tmpfs 64M /tmp`、`16M /run`、`32M /var/tmp` |
| /workspace 独立可写 | `/dev/vdb 103.9M` 挂 `/workspace`，写 `marker-a.txt` 成功 |
| 跨沙箱工作区隔离 | B 的 `/workspace` 只有 `lost+found`；`cat /workspace/marker-a.txt` → `No such file or directory` |
| 未授权 secret 不注入 | B 的 `PROBE_TOKEN` 为空 |
| 资源限额（VM 级） | `nproc`=2、`MemTotal 243804 kB`（256MiB guest 配置） |

### 5.4 附带的边界事实（记录，不构成本轮缺陷）
- guest 内 `/proc/self/cgroup` 为空：限额在 **VM 层**（vCPU 数、内存镜像大小、磁盘镜像大小），不在 guest 内核 cgroup；guest 内是单用户 root（`userId: 0`，仅在 guest 内部有意义，不穿透宿主）。
- guest 镜像 `/etc/resolv.conf` 仍写着 `nameserver 1.1.1.1`（镜像遗留）；无网卡无路由，解析不可能成功，重建镜像时清掉以免误导。
- 探针脚本的类型兼容处理与生产一致：`broker-main.ts:136-138` 也用 `store as unknown as SandboxStore`（`SandboxStore` 带私有字段，`InMemorySandboxStore` 只能这样传）。

### 5.5 与业界对照
业界方案常见的"隔离性声明"（无网卡 / 只读根 / 跨用户不可见 / secret 按用户注入）在本轮全部**用平台侧真机证据**落到了同一张表里，而不是靠模型自述或文档推断；这也是 `docs/agent-sandbox-landscape.zh-CN.md` §5 逐维对照里我们"已对齐"的那一列。
