# VRAM-Aware-Harness 全场景测试报告（campaign-20260910-01）

> 执行日期：2026-09-10。执行依据 [full-scenario-test-guide.zh-CN.md](full-scenario-test-guide.zh-CN.md)。
> 本报告只记录**实际执行过并采集到证据**的结论，未执行/不可执行的场景明确标注，不作推广。

## 0. 结论速览

> 2026-09-10 追记：报告初版发现的问题 N1–N4 已在同日全部修复并复验，
> 全量测试 392→396 pass / 0 fail / 4591 expects；修复后 campaign 重部署 +
> **真实浏览器端到端验收通过**（注册→登录→建 Workspace→UI 发任务→
> 回答 UI-FIX-OK / 17×23=391→刷新恢复）。详见 §4.1 各条"修复记录"。

| 维度 | 结论 |
| --- | --- |
| 基线 | 本地 392/392 单测全绿 + typecheck 干净 + demo/控制台 smoke 通过 |
| E1 真实链路 | 独立实例（campaign-20260910-01）· Pi→网关→vLLM→Qwen2.5-7B 全链路真实流量；28+ 真实 Agent 任务完成 |
| 隔离硬不变量 | 跨租户读/写/恢复/下载 15 项探测全部 404 拒绝；无副作用；伪造 tenantId 无效 |
| 状态机 | R02 30 轮排队中断风暴 + 全程：日志"非法转换"0 次、DB 0 卡死 |
| 中断恢复 | R04（Checkpoint 后中断→resume→完成）PASS；无 Checkpoint 时 resume 409 诚实拒绝 |
| 强杀恢复 | X11 kill -9 master：任务无丢失、对账为 INTERRUPTED 可解释；pump 启动期抛 1 次槽位异常（N2，不阻塞） |
| 网关故障 | G02 死后端自动回退（fallbackCount=1）PASS；G05 全后端死亡有界失败 PASS |
| 并发/容量 | Q01 高/低两档：低配 4/2 下尾延迟 6.6→36.7s、完成率 100%；高配 16/8 见 §5 |
| **P0 UI 缺陷** | **用户工作台 /app 内嵌脚本解析即失败（模板正则转义错），浏览器打开白屏死壳；现有冒烟只查 HTML 字符串没有查脚本执行**（§4.1 N1） |
| 诚实边界 | managed-local 环境拒绝 bash（fail-closed 设计）；受环境约束未完成的任务终态仍为 COMPLETED（§4.1 N3） |

**未在本轮执行**（如实标注）：
- 24h 长稳（X09/F 批）：本轮 做 30min 程度观测，未承诺承诺级长稳结论。
- 真实浏览器 UI 全旅程（U01–U08 浏览器部分）：初轮因 N1 白屏无法开始；N1 修复后已完成部分 U 项，其余见 §8.2。

**第二轮追加：E2 容器隔离全部执行（原本记为环境 BLOCKED）**
- 2026-09-10 在本机装入 gVisor `runsc release-20260817.0`（SHA-512 校验通过，经 `/etc/docker/daemon.json` + SIGHUP **热加载**注册，dockerd PID 260689 未变、22 个 `polar-*` 容器全程未受影响），容器隔离场景由 BLOCKED 转为可执行。
- 结果：**S05 / S07 / S08 / G09 / G10 / X10 全部 PASS**；**S06 首轮 FAIL**——运行容器内未授权 Secret 不可见，但 Secret 明文经 `--env` 落在容器 `Config.Env`，宿主 `docker inspect` 可直接读出（N13，指南规定"已知 argv 风险如复现必须 FAIL"）。
- **N13 已修复并复验**：Secret 不再进创建参数，改为执行期 `docker exec --env NAME` 从客户端进程环境取值。复验探针 `hostVisibleSecretLeak=false`、本人 Secret 仍可见、他租户仍不可见 → **S06 转 PASS**。
- 过程中发现并修复 **N12**：代码以"runsc 启动阶段拒绝 `--pids-limit`"为由跳过 PID 上限，实测该说法在现版本不成立，导致沙箱进程数完全不设上限、本项目 `smoke:container:attacks` 因此失败。
- 详情与证据见 §8.4；脚本 `scripts/e2-sandbox-limits.ts`、`scripts/e2-warm-pool.ts`、`scripts/e2-container-failure.ts`。

## 1. 环境与隔离准备（§3 复盘）

- 服务器：100.65.162.35（Ubuntu 20.04，A6000 48GB）。共享 GPU：vLLM 0.7.3 + Qwen2.5-7B（127.0.0.1:18000，仅内网监听，未动）。
- 本轮独立实例：`/home/f630/cxr/harness-deploy/campaign-20260910-01/`——代码 rsync 自 git HEAD `1982a1b` + 工作区（含 B11 修复，`isTakenOverByConcurrentHandling` 5 处引用核对）；端口 13001、数据库/工作区/日志/Pi 模型配置全部独立；`node_modules` 软链到主部署（无网络写入）。共享服务（13000 master PID 1296768、vLLM、llama-server 48809、polar-* 容器）全程未触碰。
- 账号：campaign-u01 / c01 / c02 / c05 / s09 / r02 / r04(a,b,c) / q01×4 / q04 / x11 / x11b / q11×8 均为独立注册租户；凭证不落仓库，测试报告只保留脱敏记录。
- 网关双后端拓扑（G02/G05 使用）：`campaign.env.bak-before-g02` 备份 + 依次注入死后端/全死后端/恢复，重启即生效。
- 响应空白期：`backendStates.*.healthy=false`（探活路径默认 `/health` 与 vLLM 404/X-检查路径不匹配被代码忽略掉——真实请求照常成功；已记录为观察项 N4）。

## 2. 基线回归（批次 A）

`bun run test`：392 pass / 0 fail / 4575 expects（本地 macOS，bun 1.3.13）。`bun run typecheck`：0 error。
`bun run demo:day7`（Fake）：PASS（RESOURCE_CRITICAL→RESOURCE_NORMAL 演示正常）。
`bun run scripts/user-console-smoke.ts`：4 项 PASS（注：该 smoke 校验 HTTP 合同和页面字符串，不执行工作台 JS——本轮正是靠真浏览器实践暴露了这一点，见 N1）。

## 3. 用户闭环与能力（批次 B，全部 E1/REAL）

| 场景 | 结果 | 证据要点 |
| --- | --- | --- |
| U01 API 闭环（注册→登录→Workspace→对话→T3→下载验收） | PASS | run `23ff8d1b`：事件链 63 序列含 9 轮工具；`result.json` 落盘 SHA-256 `cda2ced0…` 与 Diff/Artifact 三方一致；首轮模型漏传参数被校验拒绝（TOOL_FAILED isError）后自愈成功 |
| C01 T1 短问答（17×23） | PASS | finalText "17 * 23 等于 391。"，无文件修改；模型先尝试 bash 被拒后心算——fail-closed 正常行为 |
| C02 非法输入 10 项 | PASS | 空输入/缺字段/错类型/JSON/数组/坏 thinkingLevel 全部 400，随后合法提交 202 正常 |
| C05 T4 修复任务 | 能力 FAIL（诚实边界） | bash/edit 被 fail-closed 拒绝；模型明确告知"环境不支持，请手动执行"且未伪造结果；calc.py/test_calc.py 未被篡改（独立复算 add(2,3)=-1 与磁盘一致）；但 Run 终态仍为 COMPLETED（见 N3） |
| S01/S02/S04 跨租户 | 15/15 PASS | B→A 的 run/events/output/diff/artifacts/下载/中断/恢复/伪造 workspaceId 全部 404；A 状态未受污染；无 token/无效 token 401 |
| S09 文件产物 | PASS | 嵌套目录`目录/报告.md`+中文`中文文件.txt` 内容逐字节正确；`rm` 请求被拒后文件留存，Diff 诚实归入"新增"（与磁盘核对一致） |

## 4. 生命周期 / 恢复 / 并发（批次 C，E0+E1/REAL）

### 4.1 R04 中断→恢复
- 事件链（run `c76a8843`）：写1/读/写2/读/写3/读 各 TOOL_COMPLETED 后、模型汇报阶段被打断（seq 26 RUN_INTERRUPTED）→ `RUN_QUEUED(27)` → Resume 202 → `RUN_RESUMED(28, checkpointId 189eee71)` → 一次验证性 read（33-36）→ RUN_COMPLETED(40)。无副作用重放、无重复写。
- Attempt 账本：#1 START INTERRUPTED，#2 RESUME SUCCEEDED。Checkpoints 7 条带 tool_execution_id + 绑定事件序列。
- **无 Checkpoint 立即中断**：RUNNING 早期 interrupt 成功；resume 返回 409 "Run 没有可用 Checkpoint"（诚实拒绝多次复现）。恢复能力基线 = 助手已记录的边界（无 Checkpoint 需人工处理）实机复核一致。
- 磁盘核对：r04-log.txt 内容与账本一致（每轮 write 为覆盖语义，最终落 `r04-step3`——模型自己的写入方式，账本-磁盘-回答三方一致）。

### 4.2 R02 排队 vs 启动竞态（X03 的 E1 补活）
- 30 轮"占槽长任务 + 0.05s 轮询命中 QUEUED 后发 interrupt"：观察 QUEUED→INTERRUPTED 合法流转，1 次 RUN_COMPLETED 后终结。
- 服务日志"非法的 AgentRun 状态转换"= 0；DB 终态守恒：52 COMPLETED + 45 INTERRUPTED（含历史挑战注入）= 0 卡死。pump 持续工作至队列清空。

### 4.3 Q01 并发背压（低配 4 全局/2 租户）
- 8 租户 12 任务闭环：12/12 COMPLETED、0 拒绝；单任务时延曲线随队列深度 6.6→36.7s（每+1 并发 ~6-9s），队首无饥饿。
- 产物：8/12 磁盘文件落盘精确（`out-q01b-*.json` 哈希与账本一致）；11/12 回答含标记；2 条 finalText 夹带工具调用 JSON 噪声（模型行为，链路无伪造）→ 任务能力 92% 合格。
- 已独立记录 Q014 串行保真（Q04）：同会话 10 个任务 0.34s 内连发，开始时间严格隔间（前一条 finished_at 之后 60-80ms 开始），零重叠、10/10 COMPLETED。

### 4.4 X11 控制面强杀（SIGKILL kill -9 master PID 1803786）
- 注入前快照 RUNNING(9 文件长任务) + QUEUED(计算任务)。kill 后端口释放确认；重启 ready。
- 重启对账：两任务均安全落为 **INTERRUPTED**（可人工恢复），无"接受任务消失"。空工作区——无脏半成品文件。
- 用户操作链：resume 409 "没有可用 Checkpoint"（中断发生在首个 Checkpoint 前，按设计诚实拒绝；不自动回放副作用——R05 类硬不变量在真机的一例）。
- 遗留：重启瞬间 pump 抛 1 次 `HarnessInstance 无法获取执行槽位`（run-queue-coordinator.ts:377 attemptNext），为对账并发瞬态；服务继续服务，0 次非法状态转换（N2）。

## 4.1 问题清单（本轮新增）

| # | 级别 | 描述 | 证据 | 结论 |
| --- | --- | --- | --- | --- |
| **N1** | **P0 UI** | 用户工作台 `/app` 内嵌脚本**在浏览器中解析即失败**：整个客户端 JS 活在 TS 模板字面量里，`\r\n?`、`code.join('\n')` 等被模板级转义吃成真实控制字符；其余 `\s \d \] \( \*` 等正则转义也被丢弃（多数"碰巧"还能解析但语义已错），首个致命点在 `markdown()` 的正则 → `Invalid regular expression` → 整个脚本不执行，auth/app 双 `hidden` 白屏。localStorage 有 token 也进不去。既有 `user-console-smoke.ts` 只做字符串断言，抓不到此类缺陷 | 证据：`/tmp/campaign-evidence/ui-script-parse-bug/`（app.html、app-inline.js bisect）；复现 `new Function(脚本)` 抛错 | **已修复（同日）**：客户端 JS 抽出为独立文件 `src/http/user-console-client.js`（`readFileSync` 注入模板，`${USER_CONSOLE_CLIENT_JS}`），彻底消灭模板转义这一类 bug；新增回归测试"用户工作台的内联脚本必须能被浏览器引擎解析（N1 回归）"（对每段 `<script>` 做 `new Function` 解析断言）。真浏览器端到端验收：注册→登录→建 Workspace→发任务→回答渲染→刷新恢复 全通过 |
| N2 | C（运维） | 控制面 kill -9 重启对账窗口内 pump 抛 1 次 `HarnessInstance 无法获取执行槽位`（instance-store.ts:76 → run-queue-coordinator.ts:377），表现为对账并发瞬态，被 pump 吞掉打印后继续服务 | logs/harness.log 重启段落栈 | **已修复（同日）**：新增 `InstanceSlotUnavailableError` 专用类型；协调器识别后按瞬态处理——先 release 再重新入队（reasonCode `INSTANCE_NOT_READY`），返回 DEFERRED 等下一轮 pump 重试，不再向 onError 抛异常栈。回归测试 `tests/scheduling/instance-not-ready-defer.test.ts` |
| N3 | C（产品） | 受环境约束无法完成的任务（bash 被拒）终态为 COMPLETED：系统没说谎（finalText 明确"环境不支持"），但状态栏与真完成无异 | C05-T4.json + 磁盘未修改证据 | **已修复（同日）**：新增 `src/policies/run-limitations.ts`（DENY 账本聚合）+ `GET /runs/:id` 响应新增 `limitations` 字段（toolName/reason/count/lastDecidedAt，不改变状态机语义）。活体验证：bash 拒绝任务 COMPLETED 且 `limitations=[{bash, "执行环境无法隔离 Workspace，拒绝 bash", count:1}]`。测试：`tests/policies/run-limitations.test.ts` + HTTP 断言扩展 |
| N4 | 观察项 | 网关 backendStates `healthy:false` 与真实可用矛盾：探活默认 `{baseUrl}/health`，vLLM 无此路由 404，且 baseUrl 约定已含 `/v1`，拼 `/v1/v1/models` 亦 404；探测结果从不反映真实可用性 | backend-health-monitor.ts:55,105 | **已修复（同日）**：默认探活路径改为 `/models`（与 `/chat/completions` 同一拼接约定，得到 OpenAI 标准端点 `/v1/models`），可用 `LLM_HEALTH_PROBE_PATH` 覆盖；头注释更正"vLLM 原生 /health"的错误假设。真机复验：`healthy:true`，故障注入回退行为不变 |
| N5 | 观察 | WAITING_TOOL 实时窗口 <30ms 裹挟 managed-local bash 拒绝：S9b.1 在真机永远采样不到（与上轮 A6000 报告口径一致）；由事件链/账本而非窗口采样判定 | 本轮 R04/R02 的事件链 | 无需修复；测试策略已固化"有序事件为准" |

## 5. 容量与长稳（批次 E/F，实时数据）

### 5.1 容量阶梯（E1，真实模型）

| 档位 | 配置（全局/租户） | 在途任务 | 结果 | p50 | p95 | max | 质量合格 | 0 拒绝 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 低配（初始 campaign 配置） | 4/2 | 12 | 12/12 COMPLETED | 15.0s | 34.4s | 36.7s | 11/12（其余 1 条 finalText 无标记但文件产物正确） | ✓ |
| 高配 | 16/8 | 32 | 32/32 COMPLETED | 62.1s | 112.8s | 116.7s | 32/32 | ✓ |

- **磁盘产物核验**：高配 32/32 个 `out-q11-*.json` 落盘且内容与账本一致；低配 8/12（4 条为模型噪声采集缺口，Diff/Artifact 账本完整）。
- **守恒**：提交 44，接受 44，COMPLETED 44，拒绝 0，未知 0；无任务丢失。
- **经验吞吐**：高配档下约 0.29 任务/s 带 32 个 T3，Qwen2.5-7B 单卡 A6000 同租户 8 并发起步点。

### 5.2 资源与状态守恒
- Master（PID 2029284）：RSS 351 MB、22 线程、19 FDs —— 高载后无泄漏迹象。
- DB 终态：131 COMPLETED + 47 INTERRUPTED（含 R02 风暴、X11 强杀与历史中断）= 全部收敛，0 非法状态转换贯穿整轮。
- vLLM 观测：KV 缓存与 running requests 在负载波谷回零；观测数据源 VLLM_METRICS + NVIDIA_SMI 双源可用（host 级，单 Run GPU 用量不可得——按指南 §2.2 边界记录）。
- 长稳（30min 量级）：以本 campaign 持续任务+故障重启后服务目录再利用正常呈现；24h 级别未执行（范围外）。

## 6. 清单：BLOCKED / 未执行
（见 §0 末尾说明，均为环境与范围限制，非系统缺陷。）

## 7. 残留清理

- 测试实例 campaign-20260910-01（端口 13001、runtime/）在本轮结束时**停止并保留证据快照**，供后续复核；如需删除再执行 `rm -rf`（不删除共享服务）。
- 所有测试租户数据保留在 campaign 数据库内，与共享库物理隔离；主部署未做任何数据改动。
- 证据目录：远端 `campaign-20260910-01/evidence/{runs,load,recovery,cases,server-logs}`；本地 `/tmp/campaign-evidence/`（UI 脚本解析证据、修复对照）。
- 本地工作区未做业务代码修改：全面基于"B11 已完成的 `run-service.ts` 修复 + 测试"开展；**UI 修复（N1）按约定不动业务代码，仅提供最小复现与修复方案**。

---

# 8. 第二轮补测覆盖矩阵（2026-09-10 续测）

> 本节回答"指南里的场景是否都跑完了"：**没有全跑完**。下表按指南 §7/§8/§9 逐行对账，
> 标明实际执行情况与证据。凡未执行的都写明原因（NOT_RUN / BLOCKED / OUT_OF_SCOPE），
> 未执行不等于通过。

## 8.1 已执行（E1 真实模型 + 真实 HTTP/浏览器）

| 行 | 场景 | 结果 | 证据 |
| --- | --- | --- | --- |
| U01 | 注册→登录→Workspace→对话→T3→下载 | PASS（API + 真浏览器） | evidence/runs/U01.json；真浏览器 UI-FIX-OK/391 |
| U02 | 同会话连续修改/多轮上下文 | PASS | 浏览器：第二轮问"口令"→U02-OK；C07 十轮 3/3 保持 |
| U03 | 执行中刷新重开 | PASS | 浏览器刷新后会话/工作区/输出恢复 |
| U05 | 停止排队/执行中任务 | PASS | 浏览器停止按钮→"已中断，任务在安全边界停止" |
| U07 | 连续双击发送 | **FAIL（新发现 N7）** | 两次点击产生 2 个任务并都执行 |
| U11 | 登出后旧凭证 | PASS | 浏览器回到登录页 + X12 同 token 401 |
| C01 | T1 短问答 L1/L2 | PASS | 17×23=391，无文件修改 |
| C02 | L0/非法输入 | PASS 10/10 | 全部 400，后续合法提交 202 |
| C03 | L2/L3/L4 首中尾标记 | L2 PASS；L3 完成但 3 标记未复现=能力 FAIL；L4 超限 FAILED | evidence/cases/C03-L*.json |
| C04 | L6 超上下文（78 万字符） | FAILED（有界，原因已可读） | 202 接受→模型 400→新归类消息 |
| C05 | T4 修复+跑测试 | 系统正确性 PASS / 能力 FAIL（bash fail-closed） | 磁盘未改、模型诚实告知（N3 已加 limitations） |
| C07 | 同会话 10 轮 + 周期复述 | PASS | ORACLE-777 在第 3/6/9 轮均保持 |
| C08 | 长输出 128/512 条 | 128 PASS；512 FAILED（原 60s 超时，N6） | evidence/cases/C08-*.json |
| C09 | emoji/中文/HTML 文本 | 文件 PASS；逐字回显 FAIL（模型改写） | 产物 `emoji-🦄-中文.txt` 落盘 |
| C10 | 访问不存在文件 | PASS（诚实报"不存在"，1 次 TOOL_FAILED，无编造） | evidence/cases/C10.json |
| C11 | thinkingLevel off/low/high | PASS（均可执行；7B 无 reasoning 通道，hasThinking=false） | evidence/cases/C11.json |
| C12 | 高重复 vs 高唯一输入 | PASS（inputTokens 6688 vs 10275，cacheRead=0） | evidence/cases/C12.json |
| Q01 | 闭环并发 | PASS（4/2 12 任务、16/8 32 任务，0 拒绝） | evidence/load/q01b、q11 |
| Q02 | 单租户上限 1 | PASS（同租户第二个 QUEUED，邻居 COMPLETED） | evidence/cases/Q02.json |
| Q03 | 全局上限 1 | PASS（串行 + QUEUE_BLOCKED） | evidence/cases/Q03.json |
| Q04 | 同会话 10 任务连发 | PASS（DB 时间戳严格串行） | 前文 §4.3 |
| Q05 | A 洪泛下 B 短任务 | PASS（12/12 完成；尾延迟最高 215s） | evidence/cases/Q05.json |
| Q06 | 资源 CRITICAL 准入 | critical PASS（QUEUE_BLOCKED RESOURCE_CRITICAL）；recover INCONCLUSIVE | evidence/cases/Q06-*.json |
| Q07 | 队头阻塞 | PASS（同租户第二会话短任务 40.6s 完成） | evidence/cases/Q07.json |
| Q09 | 排队 TTL 熔断 | PASS（5s TTL → FAILED QUEUE_TIMEOUT） | evidence/cases/Q09.json |
| Q10 | metrics 故障 | INCONCLUSIVE（观测故障时保守排队；环境同时处于显存高位，无法隔离归因） | evidence/cases/Q10-*.json |
| Q11 | 提交成功率（阈值抖动简化版） | PASS（6/6 202） | evidence/cases/Q11.json |
| R01 | 长任务与短任务并行 | PASS | evidence/cases/R01.json |
| R02 | 排队 vs 启动竞态（30 轮） | PASS（0 非法转换、0 卡死） | 前文 §4.2 |
| R03 | Worker 执行中被 kill -9 | PASS（RUN_FAILED `WORKER_CRASHED: exitCode=137, signal=SIGKILL`；邻居 1.2s 完成） | evidence/cases/R03.json |
| R04 | Checkpoint 后中断→resume | PASS（Attempt 1→2，无副作用重放） | 前文 §4.1 |
| R06 | 中断收敛与清理 | PASS（INTERRUPTED 秒级收敛） | evidence/cases/R06.json |
| R08 | 并发 interrupt/resume | PASS（双中断 200 幂等；双 resume 409 无重复执行） | evidence/cases/R08.json |
| R09/X11 | 控制面 kill -9 + 重启对账 | PASS（在途/排队→INTERRUPTED 无丢失；N2 已修） | 前文 §4.4 |
| S01/S02/S04 | 跨租户读/写/凭证 | PASS 15/15 | 前文 §3 |
| S03 | 会话抢注 | PASS（跨租户 409 拒绝；同租户复用 202） | evidence/cases/S03.json |
| S09 | 文件新增/中文/嵌套路径 | PASS | 前文 §3 |
| S10 | 快照覆盖边界（2MiB±1/忽略目录） | PASS（超限文件不进产物、下载 404、node_modules 忽略） | evidence/cases/S10.json |
| S11 | 同 Workspace 双会话并发写 | PASS（各自 Diff 只归自己文件，无交叉归属） | evidence/cases/S11.json |
| S13 | 产物不可变 | PASS（第一轮 artifact 哈希在第二轮改文件后不变） | evidence/cases/S13.json |
| S14 | 输出含 HTML/脚本文本 | PASS（API 文本通道原样返回，不执行） | evidence/cases/S14.json |
| G01 | 网关主链路 + usage | PASS（网关计数增长、2 次模型调用 usage 完整） | evidence/cases/G01.json |
| G02/G05 | 后端故障回退 / 全挂有界失败 | PASS | 前文 §2 |
| G04 | 网关错误分类 | 部分 PASS（401/400 正确；未知模型 503 `no_available_backend`，与 404 预期不同） | evidence/cases/G04.json |
| G06 | 多后端策略 | PASS（round-robin / least-active / priority 三种策略均加载两后端） | evidence/cases/G06-*.json |
| G07 | 登录并发 1/10/50 + 任务并行 | PASS（p50 34/77/147ms，max 293ms，0 失败；并发提交 24-52ms） | evidence/cases/G07.json |
| G11 | 备份/恢复 | PASS（VACUUM INTO 一致性副本：377 runs/66265 events/433 checkpoints 可读，107 产物文件复制） | evidence/recovery/restore-check |
| X12 | 登录风暴 + 历史查询 + 新任务 + 撤销 | PASS（10 并发登录 37-91ms；30 条历史 9ms；审计 8ms；登出后 401） | evidence/cases/X12.json |
| §9 突发 | 1 秒内 20 任务（4 租户） | PASS（20/20 完成，p50 36.3s，p95 67.4s） | evidence/load/burst.jsonl |

## 8.2 未执行 / 不可执行（如实登记）

> ⚠️ **本节矩阵已过时，别据此判断当前覆盖。** 它写于第二轮，之后 S05–S08/G09/G10/X10、X05、G03、C06、G04 全矩阵、G08、R10/R11/R12、C09、U04/U06/U08/U09/U10/U12、X02/X07、Q08、X04/X06、R05、§9 分族基线与 λ\* 都已执行。
> 当前合并账见 **[scenario-coverage-consolidated.zh-CN.md](scenario-coverage-consolidated.zh-CN.md)**。

| 范围 | 状态 | 原因 |
| --- | --- | --- |
| S05–S08、G09、G10、X10（容器隔离/资源上限/warm pool） | **已执行（见 §8.4）** | 装入 gVisor runsc 后于独立 E2 实例（13002）执行。S05/S07/S08/G09/G10/X10 PASS；S06 首轮 FAIL（N13），N13 修复后复验转 **PASS** |
| X05（PREPARED 边界 kill + 真实写盘回执） | **已执行（PASS，见 §8.4）** | 用真实 bash 工具 `echo MARKER >> file; sleep N` 构造"已写盘、COMPLETE 未提交"窗口，窗口内 `kill -9` Worker。marker 恰好一次、工具停在 PREPARED/UNKNOWN_EFFECT 未伪成功、恢复被诚实拒绝；遗留 UX 缺口见 N16 |
| G03（SSE 中途断流） | **已执行（PASS，见 §8.4）** | 自建 1.2KB 后掐断的 SSE 代理作第一后端：不拼接、不把残缺当成功；期间发现并修复 N17 |
| X07（浏览器断网 30s + 取结果） | NOT_RUN | 需浏览器断网注入；服务端断流部分已由 G03 覆盖 |
| U04、U06、U08、U09、U10、U12（浏览器：项目切换、失败/恢复 UX、滚动复制与嵌套下载、20 标签页、断网重连、多浏览器与响应式） | NOT_RUN | 时间与预算；浏览器已可用（N1 修复后），可直接补 |
| C06（工具返回超长文本） | **已执行（PASS，见 §8.4）** | 253,890 字节工具输出被收敛到 ~105KB，主进程 RSS 稳定 |
| C09 浏览器侧注入渲染 | NOT_RUN | 同上 |
| Q08（预算权重/maxUnits）、Q12（开环到达率阶梯 0.5/0.8/1.0/1.2/2.0 λ*） | NOT_RUN | 本轮只做了闭环与突发；开环到达率需更长排期 |
| R05（未知副作用不重放，真实写盘）、R07（30/60min 长任务）、R10（会话/Checkpoint 损坏）、R11（恢复入队后资源再紧张）、R12（迟到/重复事件覆盖终态） | NOT_RUN | 需更长时长或专用夹具 |
| G04 全矩阵、G08（SQLite 只读/磁盘满）、G12（2/8/24h soak） | NOT_RUN | 需受限卷/长时运行 |
| §9 单用户分族基线、并发阶梯 2/4/8/32/64、稳定吞吐 ≥30min、热点租户、耐久 2h/8h/24h | NOT_RUN | 只完成 4/2、16/8 两档闭环 + 20 任务突发 |
| X01（5 租户高峰期完整版）、X02（11 轮 + 断线）、X04（Checkpoint+资源不足+重启）、X06（超限+网关故障联合）、X08（barrier 保证同读旧版）、X09（业务日长稳） | 部分/未跑 | 由 Q05、C07+U02、R04+X11、C03/C04+G02/G05、S11+S13 分别覆盖了核心断言；完整剧本未跑 |

## 8.3 本轮新发现问题

| # | 级别 | 问题 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| **N5** | **部署/配置（高）** | 资源准入按 host 显存已用比例判定（BUSY 70%/CRITICAL 90% 默认），而推理框架（vLLM）默认预分配约 90% 显存——平台在只有自己一个模型服务时也会长期判 CRITICAL，新任务全部排队并在 TTL 后批量熔断 | 13 字符任务也 `QUEUE_TIMEOUT`；`QUEUE_BLOCKED reasonCode=RESOURCE_CRITICAL`；GPU 已用 44.9/49.1GB（其中 vLLM 42.1GB） | 未改默认值（避免影响其它部署）；本轮按部署校准为 93%/98% 并写入报告，建议文档明确"阈值必须按推理框架预分配校准"，或改用 KV cache/请求数为主判据 |
| **N6** | **P1（已修复）** | 网关单次模型请求超时硬编码 60s 且**无任何环境变量可配**：长输入/长输出任务每次调用都在 ~60s 被掐断，重试 4 次后以 `Stream ended without finish_reason` 失败（50k 字符任务实测 4×~60s）；错误信息对用户不可读 | C03-L3 事件链（4 次 MODEL_COMPLETED stopReason=error，各 ~58-60s） | **已修复**：新增 `LLM_REQUEST_TIMEOUT_MS`（默认 300s）接线；失败原因归类（流中断→"模型流式响应中断（多为超时/断流）"、4xx 无 body→"模型后端拒绝请求（HTTP 400，常见原因：输入超出上下文上限）"）。复验：同一 50k 任务由 FAILED 变为 **109s COMPLETED**；超限任务给出可读原因。回归测试 `tests/runs/model-failure-classification.test.ts` |
| **N7** | **UI（中）** | 工作台连点两次"发送"会提交**两个任务**并都执行：前端无在途防重（按钮未禁用、无幂等键） | 浏览器实测：两次点击后出现 2 条 88+88 回答 | 未修（本轮只记录）；建议发送后立即禁用按钮 + 以 runId 去重 |
| **N8** | **API 契约（中）** | 超大输入不做提交期校验：78 万字符被 202 接受后才在模型侧 400 失败；且提交响应把整个 userInput 回显（响应体同量级） | C04：body 780KB → 202 → FAILED(400) | 未修；建议提交期按模型上下文做上界校验并返回 413/400，且响应不回显全量输入 |
| N9 | 观察 | 未知模型返回 503 `no_available_backend`（语义清晰但与"未知模型 404"的常见契约不同） | evidence/cases/G04.json | 记录，未改 |
| N10 | 观察 | Q05 洪泛下正常租户尾延迟可达 215s（无永久饥饿，但体验退化明显） | evidence/cases/Q05.json | 记录；需要时再调公平策略 |
| **N12** | **隔离/资源（高，已修复）** | `OciSandboxSpecCompiler` 以"Docker 的 runsc 集成在受支持镜像上启动阶段会拒绝 `--pids-limit`"为由，对 runsc **不下发任何 PID 上限**。实测该结论在 `runsc release-20260817.0` 上不成立：不传该参数时 900/900 个子进程全部创建成功；传 `--pids-limit 128 / 512` 时分别约在 40 / 229 个子进程处被拦停。后果是沙箱内进程数无上限（本机自身 `smoke:container:attacks` 的 PID 项因此 FAIL） | `e2-runsc/evidence/runsc-install.txt`、`e2-runsc/evidence/n12-pids-limit-probe.txt`；修复前 `bun run smoke:container:attacks` 报 "PID 耗尽没有返回受限结果"；修复后 9 项全 PASS | **已修复**：runsc 与 runc 统一下发 `--pids-limit 128`，`pidLimitEnforced` 随之变为 true；补 `tests/sandbox/container-sandbox-provider.test.ts` 断言。全套 399 pass / 0 fail |
| **N13** | **安全（P0，未修）** | 容器 Secret 以 `--env NAME=<明文>` 注入：①创建期明文出现在宿主 docker CLI argv；②创建后明文长期留在容器 `Config.Env`，**任何 docker 组成员**执行 `docker inspect --format '{{json .Config.Env}}'` 即可读出该容器全部 Secret。指南 S06 明确"已知 argv 风险如复现必须 FAIL" | `evidence/cases/s08-s06-sandbox-limits.json`：`hostVisibleSecretLeak=true`；直接复现 `docker inspect` 返回 `["TOKEN=PLAINTEXT-CANARY-DEMO", ...]` | **已修复并复验**：Secret 不再进入容器创建参数（也没有占位符），改为执行期 `docker exec --env NAME`（只带名字）由 docker CLI 从客户端进程环境取值注入；明文因此既不在 argv、也不在容器 `Config.Env`。复验 `evidence/cases/s06-n13-after-fix.json`：`hostVisibleSecretLeak=false`、本人 Secret 可见、他租户不可见 → S06 转 PASS。残留边界：同机同用户仍可读 docker CLI 子进程的 `/proc/<pid>/environ`（与 owner 权限同级），已在 known-issues 记录 |
| N14 | 观察（隔离语义） | gVisor 下**触达 PID 上限会终结整个沙箱**（`docker exec` 随后报 `container ... is not running`，runsc 以 `urpc ... WaitPID failed: EOF` 收尾），而 runc 只是 fork 失败、容器继续存活。harness 能把前者正确对账为 `LOST` 并发事件、且不留残留容器，属 fail-closed 的正确收敛，但"一条命令吃满 PID"会连带中断该 Run | `evidence/cases/s08-s06-sandbox-limits.json`（`sandboxStillRunning=false`）；`scripts/e2-container-failure.ts` | 记录；运行时语义差异，建议文档写明 |
| **N17** | **网关可用性（中，已修复）** | 后端在 `finish_reason` 之前断流时，网关只以 HTTP 首包状态判定成功，**断流不记为该后端失败**；而且 `recordSuccess` 在首包时就执行，会把失败计数清零。后果：熔断器永不打开、健康备用后端永不被使用，每次重试都再撞同一个坏后端（G03 实测连续 5 次被同一代理掐断后 Run FAILED） | `evidence/cases/g03.json`（5 次掐断 → FAILED）；修复后 `evidence/cases/g03-after-n17.json`（3 次掐断 → 熔断 → 切到健康后端 → **COMPLETED**） | **已修复**：流式响应统一走包装器，把成败裁决推迟到流结束（见 `finish_reason`/`[DONE]` 记成功，提前断开记失败，下游取消不计）；新增回归 `tests/llm-gateway/stream-usage.test.ts` N17 用例。全套 403 pass / 0 fail |
| N16 | 体验缺口（中） | Worker 崩溃后工具停在 `PREPARED/UNKNOWN_EFFECT`（副作用可能已发生），但**没有任何产品流程让用户或运维确认并消解这个状态**：`resume` 因无 Checkpoint 被拒，Run 停在 FAILED，界面无法表达"这条命令可能已经执行过，请人工核对外部效果" | `evidence/cases/x05.json`：`statusA=FAILED(WORKER_CRASHED)`、工具 `PREPARED/UNKNOWN_EFFECT`、resume 返回 `Run 没有可用 Checkpoint` | 未修（属产品设计选择）；建议为 UNKNOWN_EFFECT 提供显式的"人工确认/标记已核对"出口，而不是让用户面对一个没有下一步的失败 |

## 8.4 E2 容器隔离执行记录（2026-09-10 第二轮）

### 环境准备
| 步骤 | 结果 |
| --- | --- |
| 获取 gVisor runsc | `release-20260817.0`（105,378,363 B）；SHA-512 与官方 `.sha512` 一致（`84936438…9fb2ef`） |
| 安装 | `/usr/local/bin/runsc`（root:root 0755） |
| 注册运行时 | `/etc/docker/daemon.json` 追加 `runtimes.runsc.path`，保留原 `registry-mirrors`；`systemctl reload docker`（**SIGHUP 热加载**） |
| 影响面核验 | dockerd PID 260689 **未变**；`docker info` 新增 `runsc`；22 个 `polar-*` 容器全程 Up |
| 内核级隔离证据 | 同一镜像 `uname -a`：runsc → `4.19.0-gvisor`；runc → `5.15.0-139-generic`（宿主） |

### 独立 E2 实例
`/home/f630/cxr/harness-deploy/campaign-e2-20260910/`：端口 **13002**，独立 DB/工作区/日志/凭证，`code` 软链到已修复源码树。沙箱配置 `HARNESS_SANDBOX_PROVIDER=container`、`PROFILE=default`、`RUNTIME=runsc`、`CONTAINER_IMAGE=alpine:3.20`、`CONTAINER_USER_ID=1000`、`WARM_POOL_SIZE=2`。共享 13000 / 18000 / 48809 全程未触碰。

### 基础沙箱验证（指南 §5.1）
| 命令 | 结果 |
| --- | --- |
| `bun run smoke:container` | **PASS**（runsc 运行时证据 / 非 root UID / 工作区写入 / 只读 rootfs / network=none） |
| `bun run smoke:container:attacks` | **PASS**（9 项：运行时证据、跨租户工作区、宿主路径、路径穿越、租户 Secret、网络、PID、tmpfs、容器消失收敛 LOST） |

### 逐场景结果
| ID | 结果 | 验收要点（均从真实 Pi 工具入口，非仅 Provider） | 证据 |
| --- | --- | --- | --- |
| **S05** | **PASS** | 单条探测夹具在容器内跑完 12 段：`uname`=`4.19.0-gvisor`、宿主内核串不出现；宿主哨兵 `cat` rc≠0 且内容不可得；租户 B 机密文件 rc≠0；`/workspace/..` 是容器 root（含 `.dockerenv`）；`ln -s /` 符号链接逃逸 rc≠0；宿主 `/home/f630`、`/var/run/docker.sock` 均 No such file；**正向对照**（读自己的 a-marker、写自己的 workspace）均成功 → 证明不是"命令没跑"的假通过 | `evidence/cases/s05.json` |
| **S06** | 首轮 **FAIL** → 修复后 **PASS** | 首轮：容器内边界正确，但宿主 `docker inspect` 可读出明文 Secret（N13）。修复后复验：宿主泄漏消失、本人 Secret 仍可见、他租户仍不可见 | `evidence/cases/s08-s06-sandbox-limits.json`（首轮）、`evidence/cases/s06-n13-after-fix.json`（修复后） |
| **S07** | **PASS** | 注入夹具被模型读到后：`wget` 直连 IP `Network unreachable`、DNS `bad address`、`ping` unreachable；`ip addr` **只有 `lo`**；`ip link set eth0 down` → `No such device`（容器内无可用网卡、也无法自行启用） | `evidence/cases/s07.json` |
| **S08** | **PASS** | 四类限额均由运行环境执行：CPU 同工作量 **6898ms → 15602ms（2.26×，--cpus 0.5）**；内存 128MiB 上限下指数分配在 **41.9MB 被杀（exit 128）**；PID 风暴被拦停；tmpfs 写 128MiB **在 67,108,864 B（恰好 64MiB）ENOSPC**；邻居沙箱同刻执行仅 34ms；全部容器最终清理 | `evidence/cases/s08-s06-sandbox-limits.json` |
| **G09** | **PASS** | Provider 级：镜像缺失 → create 抛错、记录 `FAILED`、无残留容器；容器被 `rm -f` 后 → `LOST` + 生命周期事件；随后仍能新建并执行。运行级：真实 Run 执行中杀掉其容器 → 工具以 `No such container` 失败、Run 收敛到终态、Sandbox 对账 `TERMINATED`、最终回答**如实告知失败**、下一个 Run 正常 COMPLETED | `evidence/cases/g09-container-failure.json`、`evidence/cases/g09-run-level.json` |
| **G10** | **PASS** | 冷启动 **275ms** vs 热启动 **49ms（5.61×，warmHit=true）**；热容器内 `/tmp` 为空、无上轮文件/env/Secret 残留；**跨租户不重用**（另一租户 warmHit=false）；关闭后池内无残留容器 | `evidence/cases/g10-warm-pool.json` |
| **X10** | **PASS** | 邻居在受限容器内制造 CPU/内存/PID/tmpfs 压力（110s 内启动 165 个受限容器，峰值约 20 并发）：B 侧 6/6 COMPLETED 且产物 token 正确；p50 **1673ms → 2502ms**、max 2497ms → 3321ms（**1.33×**，指南阈值 p95 ≤ 3×）；压力容器与 harness 容器均无残留 | `evidence/cases/x10-baseline.json`、`evidence/cases/x10-under-stress.json`、`evidence/cases/x10-stress.log` |

### 本轮新增脚本（随仓库提供）
- `scripts/e2-sandbox-limits.ts`——CPU/内存/PID/tmpfs 限额执行 + Secret 边界与宿主泄漏探针（S06/S08）。
- `scripts/e2-warm-pool.ts`——warm pool 冷/热延迟、无残留、跨租户不重用（G10）。
- `scripts/e2-container-failure.ts`——镜像缺失 / 容器消失 / 失败后仍可服务（G09）。
- 服务器端：`e2_probe.py`（S05/S07 真实工具入口夹具驱动）、`e2_g09_run.py`、`e2_x10_b.py`、`x10-stress.sh`。

### X05：不确定写入 + Worker 崩溃 + 人工恢复（E2 实测 PASS）

夹具改用**真实写盘**而非模拟回调：让 bash 执行 `echo <marker> >> /workspace/x05-marker.txt; echo APPEND_DONE; sleep 30`。追加在工具开始后立刻完成，而 COMPLETE 要等 sleep 结束才提交——这段窗口正是剧本第 2 步要求的"已保存 PREPARED、已真实写盘、COMPLETE 未提交"。

| 观测点 | 实测 |
| --- | --- |
| 崩溃前工具状态 | `tool_executions.status=PREPARED`、`effect=UNKNOWN_EFFECT`，marker 文件已含 1 次 |
| 动作 | `kill -9` 该 Run 的 Worker 子进程（`pgrep -P <master>` 命中） |
| Run 收敛 | `FAILED`，原因 `WORKER_CRASHED: exitCode=137, signal=SIGKILL` |
| 工具是否伪成功 | 否——停在 `PREPARED/UNKNOWN_EFFECT`，未被写成 SUCCEEDED |
| 恢复尝试 | `POST /runs/:id/resume` 被诚实拒绝：`Run 没有可用 Checkpoint` |
| 副作用次数 | marker **恰好 1 次**（恢复未触发不安全重放） |
| 邻居 B | 并发正常任务 `COMPLETED` |

结论：核心断言（恰好一次、停在需人工处理边界、不伪成功）全部通过。遗留体验缺口见 N16：该状态下没有产品流程让用户/运维确认并消解 UNKNOWN_EFFECT。

证据：`evidence/cases/x05.json`；驱动脚本 `e2_x05.py`。

### 未做与原因
- 产品路径下**无任何入口可配置租户/运行的资源限额与授权 Secret**（`PolicyRegistry.setTenantPolicy/setPlatformPolicy` 仅被测试调用，HTTP 也没有对应路由；`StartRunInput.runPolicy` 无调用方），因此默认每次运行都是 `unrestrictedPolicy`（无 CPU/内存限额、无 Secret）。S06/S08 因此只能在 Provider 边界用自建 policy 验收；这本身是一项值得登记的产品缺口（见 known-issues N15）。

## 8.5 第三轮：补跑场景 + 缺陷修复（2026-09-10）

### 新增执行
| 场景 | 结果 | 证据 |
| --- | --- | --- |
| **G03**（模型流已发出部分 token 后断流） | **PASS** | 自建 SSE 代理：转发 1,216 字节后主动掐断，作为 priority 策略下的**第一后端**，第二后端为健康 vLLM。修复 N17 前：连续 5 次掐断后 Run `FAILED`，reason 可读（"模型流式响应中断…Stream ended without finish_reason"），**无拼接**（网关按首包状态决策，结构上不会把两个后端的内容拼进同一个流）。修复 N17 后：3 次掐断即熔断该后端 → 切到健康后端 → Run **COMPLETED** |
| **C06**（单轮小输入 + 工具返回超长文本） | **PASS**（有界） | 夹具输出 253,890 字节 / 5000 行；工具结果被收敛到 ~104,743 字节，Run `COMPLETED`，主进程 RSS 稳定在 ~218MB，无失控。**观察**：截断本身未告知模型，模型据此回答"输出没有被截断"（登记为体验缺口，非阻塞） |

### 本轮修复（全部含回归测试 + 真机复验）
| # | 修复内容 | 复验证据 |
| --- | --- | --- |
| **N13**（P0 安全） | Secret 不再进入容器创建参数；改为执行期 `docker exec --env NAME`（只带名字），明文由 docker CLI 从**客户端进程环境**取值，因此既不出现在 argv、也不写进容器 `Config.Env` | `evidence/cases/s06-n13-after-fix.json`：`hostVisibleSecretLeak=false`、`secret_visible_inside_own_sandbox=true`、`secret_hidden_from_other_sandbox=true`；单测断言创建参数不含明文、exec 只带名字。**S06 → PASS** |
| **N17**（网关可用性） | 流式响应统一走包装器，把"这一轮是否成功"从"首包 200"推迟到**流真正结束**：见到 `finish_reason`/`[DONE]` 记成功，提前断开记失败，下游主动取消不计。修掉了"首包即 recordSuccess 把断流失败清零"的问题 | G03 修复前 5 次掐断 → FAILED；修复后 3 次掐断 → 熔断 → 健康后端接管 → COMPLETED |
| **N7**（UI） | 工作台发送加在途防重：置位前先判、无论成败都复位、在途期间禁用发送按钮 | 真浏览器：同一 tick 内两次触发 `#sendBtn`（比人手连点更极端），服务端只产生 **1 个 Run**（修复前为 2 个）；随后正常运行的单次点击仍能产生第 2 个 Run，确认防重不会把用户永久挡住 |
| **N8**（API 契约） | 提交期输入上界 `HARNESS_MAX_USER_INPUT_CHARS`（默认 100,000），超限返回 **413** 且不创建 Run；提交响应只回显 200 字符摘要（附 `userInputTruncated`/`userInputLength`） | 真机：780,000 字符 → **413**（原文为 202 → 模型侧 400）；正常输入仍 202 且回显收敛 |

回归基线：**403 pass / 0 fail / 4620 断言**，`tsc --noEmit` 干净。

### 仍未执行
浏览器类 U04/U06/U08/U09/U10/U12、X07 浏览器断网、Q08/Q12、R05/R07/R10/R11/R12、G04 全矩阵/G08/G12、§9 并发阶梯与 2/8/24h 长稳、复合剧本 X01/X02/X04/X06/X08/X09。其中长时项需要以小时计的运行时间；其余为可补的短场景。

## 8.6 第四轮：故障与恢复批次（2026-09-10）

均使用独立一次性实例（13004）与故障夹具，未触碰共享 13000/18000。

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| **G04** 网关错误全矩阵（E0+E1 夹具） | **PASS 14/14** | 真实网关 + 本地故障服务器：401/400 原样透传且**不回退**（attempted=1）；429/500 回退到健康后端且**尝试次数有界**（=后端数 2）；坏 JSON / 坏 SSE / 截断 SSE 均不崩溃；usage 缺失**不计入**、usage 重复**只计一次**（promptTokens 120 而非 240） | `scripts/e2-gateway-fault-matrix.ts` |
| **G08** SQLite 忙 / 只读 / 工作区写失败 | **PASS** | 忙：提交直接 **409 "database is locked"**（不伪造成功），释放后下一任务 COMPLETED。只读：启动即 **fail-closed**（"启动失败 attempt to write a readonly database"）且不提供服务，恢复权限后恢复正常。工作区只读（root 所有，沙箱无法自行 chmod）：写入被真实拒绝且未被包装成成功，恢复后写成功 | `evidence/cases/g08-*.json` |
| **R12** 终态不可被迟到/重复事件覆盖 | **PASS** | 对 COMPLETED Run 连续 interrupt/resume 各 2 次全部被拒；夹具追加 2 条迟到/重复 `RUN_FAILED` 事件后状态仍为 COMPLETED，无重复副作用 | `evidence/cases/r12.json` |
| **R10** Checkpoint/会话损坏 | **FAIL（新发现 N18）** | 基线恢复可用（202 → COMPLETED）；夹具把 Checkpoint 的 `runtime_session_ref` 指向不存在文件后，恢复**仍然 202 并 COMPLETED**，日志无任何告警——恢复静默降级，用户/运维看不到"此前上下文已丢" | `evidence/cases/r10.json` |
| **R11** 恢复入队后资源再紧张 | **部分通过 + 新发现 N19** | r11a/r11b：正常资源下造出带 Checkpoint 的 INTERRUPTED Run；把阈值压到 1%/2% 强制 CRITICAL 后恢复 → Run 停在 `QUEUED`，队列 `reasonCode=RESOURCE_CRITICAL`（未绕过准入）→ **PASS**。r11c：资源恢复并重启后，该 Run **无法推进**，陷入活锁（见 N19） | `evidence/cases/r11a|r11b|r11c.json`、`evidence/cases/r11-instance-livelock.txt` |

### 新发现
| # | 级别 | 问题 | 证据 |
| --- | --- | --- | --- |
| **N18** | **恢复正确性（高）** | 损坏的 Checkpoint（会话引用指向不存在路径）在恢复时被**静默忽略**：Run 照常 `COMPLETED`，`harness.log` 无任何 session/checkpoint 相关告警。用户无法得知这次恢复其实没有续接此前的会话上下文 | `evidence/cases/r10.json`：`resumeAfterCorruption.httpStatus=202`、`runStatus=COMPLETED`、`failureReason=null` |
| **N19** | **恢复可用性（高）** | 在 Run 执行中被 SIGTERM 重启后，该租户的 `harness_instances` 行停在 **`actual_state=FAILED, active_run_count=1`**（槽位未释放）。此后对该 Run 的每次恢复都以 `RESUME_FAILED: HarnessInstance 无法获取执行槽位` 结束并被重新入队，形成 **INTERRUPTED ↔ QUEUED 活锁**；每个循环还会真实创建并销毁一个沙箱（资源churn），永不推进、也不升人工 | `evidence/cases/r11-instance-livelock.txt`（事件 20→26 两轮循环） |
| **N20** | **关闭顺序（中）** | SIGTERM 关闭途中 queue pump 仍在推进 Run，工作区快照写入落在已关闭的 DB 上：`RangeError: Cannot use a closed database`（同一实例日志出现 **20 次**）。应先停 pump 并等在执行任务收尾，再关闭 DB | `evidence/cases/r11-instance-livelock.txt`（日志第 1173/1188/1203 行） |

### 本轮仍未执行
浏览器类 U06/U09/U10/U12 与 X07 浏览器断网、Q08/Q12、R05（已由 X05 覆盖）/R07、G12 2/8/24h、§9 并发阶梯与 2/8/24h 耐久、复合剧本 X01/X02/X04/X06/X08/X09。长时项需要以小时计的运行时间。

## 8.7 第五轮：浏览器 UI 批次 B1（2026-09-10）

独立一次性实例（13011 / `managed-local` / E1），独立租户 `ui-b1@example.test`、两个 Workspace（UI-A1/UI-A2）与两条对话，未触碰共享 13000/18000。
浏览器操作由**主智能体**执行——`browser-use` 的 skill 明文规定 main-agent-only、子智能体不得加载，所以 U/C09/X07 这类页面场景不能派给子智能体。
本批只取 pass/fail 判定；**延迟/吞吐数字一律作废**（共享主机、含邻居负载）。

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| **C09** Unicode / emoji / 组合字符 / HTML 注入 | **PASS** | 会话内 `script` 元素数 **0**、无 JS 弹窗；`<script>alert(1)</script>` 按**文本**渲染；emoji 🎉、ZWJ 家族 👨‍👩‍👧‍👦、中文文件名 `测试-emoji-ünïcode.txt` 均未损坏。防注入是**结构性**的：控制台先 `esc()` 再 `inlineMd()`，`<script>` 在任何 HTML 组装前已转义。证据 `evidence/cases/C09/`（json + png） |
| **U08** 嵌套路径产物下载 | **PASS（下载部分）** | 产物 chip 出现且真实触发下载事件；整段编码 `docs%2Fnotes%2Fhello.txt` → **200 / 9 字节 / 内容精确 `nested-ok`**；不编码（按路径分段）→ 404，与指南 §5.3 的契约一致。**滚动行为 INCONCLUSIVE**：为造长输出发的任务只产出 3 行代码块，内容不够长，不构成有意义断言。另记一处小 UX：chip 只显示 basename，同名不同目录无法区分 |
| **U04** A1/A2 项目与对话频繁切换 | **FAIL（新发现 N22）** | 受控交错复现：应用状态为对话 B（`89e27447…`）时，`convTitle` 渲染成 **A 的标题「嵌套与长输出」**、正文首条消息是 **A 的**「请在工作目录下创建文件 docs/notes/hello.txt…」。即迟到响应覆盖了当前页。重新打开 B 后恢复正常。证据 `evidence/cases/U04/` |

### 新发现
| # | 级别 | 问题 | 证据 |
| --- | --- | --- | --- |
| **N21** | 前端渲染保真（中） | 行内代码里的下划线被当作 Markdown 强调吞掉：`` `new_python_script.py` `` 渲染成 `<code>new<em>python</em>script.py</code>`，显示与复制的文本变成 `newpythonscript.py`。根因 `src/http/user-console-client.js:48-54`：`inlineMd()` 第 49 行先把反引号包成 `<code>`，其后的强调规则（51–54 行）仍在同一整串上继续替换，于是进入 `<code>` 内部；第 54 行 `_([^_]+)_` 命中 `_python_` 并吃掉两个下划线。触发面很广（文件名、路径、`harness_instances` 这类标识符）。**不是注入问题**：`esc()` 在 `inlineMd()` 之前执行，C09 结论不受影响 | DOM 实测 `outerHTML` = `<code>new<em>python</em>script.py</code>`、`emphasisInsideCode=1` |
| **N22** | 用户旅程正确性（中高） | 切换对话时，**迟到轮询响应无条件覆盖当前页**，造成跨对话串扰。`refreshConversation()`（`src/http/user-console-client.js:207-226`）在请求发出时读 `S.conversationId`，但响应处理里对 `S.conversation`/`S.runs`/`convTitle` 的赋值与 `renderThread()` 没有任何"响应是否仍属于当前对话"的校验；轮询每 **1600ms** 触发且内部还有 `loadOutput`/`loadFacts` 链式请求，窗口可达数百 ms 到数秒。触发条件：对话 A 有 RUNNING/QUEUED 任务（轮询已开）时切到 B，且 A 的在途响应晚于 B 落地 | `evidence/cases/U04/ui-b1-u04.json`：`state=B` 而 `title=A`、`firstMsg=A` |

### B1 仍未执行
U06 / U09 / U10 / U12 / X07（原定 B2 组），以及 U08 的滚动断言。

## 8.8 第六轮：功能场景批次 C（2026-09-10）

独立实例 `campaign-func-20260910`（13013，`managed-local`，E1）与 `campaign-func-e2-20260910`（`container`/runsc，E2），独立租户与 Workspace。

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| **Q08** 预算权重 / maxUnits | **FAIL（新发现 N23）** | E0（真实策略类 + 账本）**全 PASS**：等权 / 不同 weight / maxUnits 的 fair-share、ceiling 与 settle 释放语义都正确。**E1 真机暴露 N23**：ceiling=1 的租户永远启动不了 Run——等权 3 租户全部 `admitted=false`、每个 Run 约 300 次 `QUEUE/TENANT_BUDGET_EXCEEDED` 后 TTL 失败；`maxUnits=1` 同样饿死；ceiling≥2 正常 COMPLETED 且释放后二次提交成功。`evidence/cases/Q08/` |
| **X04** 安全恢复后又遇资源不足 | **PASS** | 对照组带 Checkpoint 的 INTERRUPTED 恢复后 COMPLETED。实验组：资源 CRITICAL → resume 202 但停在 `QUEUED`（`QUEUE_BLOCKED reasonCode=RESOURCE_CRITICAL`）；排队期间二次重启仍 QUEUED 且 runId/checkpointId 不变；恢复后**同一 runId** COMPLETED、该租户 Run 数 2→2（**未新建 Run**）、`RUN_RESUMED` 引用同一 Checkpoint、`userInput` 原样保留。`evidence/cases/X04/` |
| **X06** 长输入超限 + 正常用户 + 网关故障 | **PASS**（网关故障 **SIMULATED**） | L6 500,008 字符 → **413** 且不建 Run；超上下文 70,020 字符 → 202→**FAILED** 且原因可读、无伪成功无无限重试；L5 → COMPLETED；正常用户 B **3/3 COMPLETED** 且答对 391；503 代理 `failureCount=3 / fallbackCount=3`、fault 后端 `circuitOpen=true`、vllm healthy；解除后全新 T3 COMPLETED（diff 新增 `result-x06.json`）。`evidence/cases/X06/` |
| **R05** 不确定写入 + Worker 崩溃（E2 真实容器） | **PASS** | 真实 bash 处于 `PREPARED / UNKNOWN_EFFECT`、marker 已真实追加 1 次、COMPLETE 未提交时 `kill -9` Worker（pid 204332）→ Run **FAILED**（`WORKER_CRASHED exitCode=137 SIGKILL`），工具**未被写成 SUCCEEDED**；marker 崩溃前=崩溃后=resume 后=**1**（**无不安全重放**）；`resume` → **409「Run 没有可用 Checkpoint」**（fail-closed）。邻居 B 全程 COMPLETED，故障后全新 T3 COMPLETED。**指南 §4.3 第 3 条未违反**。`evidence/cases/R05/` |

### 新发现
| # | 级别 | 问题 | 证据 |
| --- | --- | --- | --- |
| **N23** | **公平性 / 可用性（高）** | **任何 ceiling=1 的租户永远无法启动任何 Run**，且这是**预算层错误拦截**而非契约本意：三条 Run 的 `_contractAdmit` 均为 `true`（base policy 本会放行），却被预算装饰器改成 `admitted=false`。等权 3 租户（fairShare 各 1）全部饿死；低权重租户（fairShare 1）在 ceiling=3 的邻居正常运行时也照样饿死。根因：`run-queue-coordinator.ts:320` 已把 `activeTenantRunCount - 1` 传给 base policy，但 `budget-aware-policy.ts:73` 的 `activeUnits()` 绕过该修正、直接重读调度器（含刚 claim 的 Run），导致 `availableUnits = ceiling − 1`，**ceiling==1 时恒为 0** | `evidence/cases/Q08/`、`q08-analysis.json`（`contract_violation=true`）；代码位置已双向核对 |

### 同轮观察（未定级）
反复"带未决 QUEUED Run 重启实例"后 `harness_instances.active_run_count` 可残留（ACTIVE=1 而 Run 未启动），并出现 `/queue` 停在 `AWAITING_SCHEDULING` + `database is locked`。属 N19 家族，由测试自身的重启风暴诱发、未做干净复现，建议独立跟进（`evidence/q08-probe3.json`）。

### 本轮未完成
- R05 未构造"同一 Run 内已有安全 Checkpoint + 随后 bash PREPARED"子变体：模型 5 次尝试均只调用 bash、跳过 read，无法由提示词稳定构造；已改用更严格的 `NO_CHECKPOINT + PREPARED` 路径验收，核心断言全部通过。
- Q08 的 E0 层与 E1 层结论分离：E0 全 PASS（策略语义正确），FAIL 仅由 E1 真机的预算接线缺陷导致。
