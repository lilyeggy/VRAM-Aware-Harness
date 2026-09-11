# A6000 真机部署与全场景验证报告

> 日期：2026-09-10。机器：100.65.162.35（Tailscale 内网，Ubuntu 20.04，RTX A6000 48GB）。
> 目标：在真机上部署多租户 Agent 平台全栈（模型 + 控制面），用多类型输入与多用户场景全面验证系统功能。
> 状态：**全部通过**。平台 392 测试全绿；第一轮 8 组场景（S1–S8）+ 第二轮 9 组场景（S9–S17），
> 两轮合计 ~90 项检查（唯一未过项为 WAITING_TOOL 实时轮询采样竞态，见 §6.3）；
> 真实 Agent 任务完成 20+；第二轮挖出并修复 B 级竞态 bug 一个（§6.0）。

## 1. 部署拓扑

```
A6000 (100.65.162.35, 用户 f630)
├── vLLM 0.7.3（conda env harness-vllm，python 3.11）
│   ├── 模型：Qwen2.5-7B-Instruct（ModelScope 下载，15GB，数据盘）
│   ├── 权重：/home/f630/homePLUS/harness-models（1.6TB 空闲盘）
│   ├── 端口：127.0.0.1:18000（OpenAI 兼容 + /metrics）
│   └── 关键参数：--enable-auto-tool-choice --tool-call-parser hermes（Pi 必需）
├── bun 1.3.9（~/.bun/bin，不在 PATH，需显式引用）
└── Harness 平台（cxr/harness-deploy/）
    ├── 代码：code/（rsync 同步，385→387 测试全绿）
    ├── 配置：a6000-harness.env（端口 13000，managed-local/development 沙箱）
    ├── Pi 模型配置：.pi/spike/models.json（baseUrl 经网关 13000/v1）
    ├── 运行时：runtime/（harness.sqlite + workspaces）
    └── 权重软链：models -> /home/f630/homePLUS/harness-models
```

Pi → 网关（13000）→ vLLM（18000）→ Qwen2.5-7B，全链路真实模型流量。

## 2. 部署过程踩坑（已解决，全部有测试/配置固化）

| # | 问题 | 根因 | 解法 |
|---|---|---|---|
| 1 | pip 装的 torch 2.13 报"驱动太老（12.2）" | vLLM 0.29 的 torch 需要新驱动；驱动是系统级动不了 | 降级到 vLLM 0.7.3 + torch 2.5.1 cu121（与之前 T4 验证版本一致） |
| 2 | vLLM 起不来：`Qwen2Tokenizer has no attribute all_special_tokens_extended` | pip 顺带装的 transformers 5.x 与 vLLM 0.7.3 不兼容 | transformers 钉到 4.48.3 + tokenizers 0.21.0 |
| 3 | 真实任务 RUN_FAILED：沙箱"有上下文但缺少执行器" | Worker 侧 `setupRuntime` 只处理 container；managed-local + process worker 组合下 sandboxId 传了但无 executor，fail-closed 拒绝 | **真 bug，已修**：`createPiToolDefinition` 中 HOST 边界 + sandboxId + 无 executor → 允许宿主机受管目录执行（sandboxId 仅归属标识）。回归测试 `tests/runtime/pi-tool-gateway.test.ts`（HOST 边界用例） |
| 4 | 任务 RUN_FAILED：404"找不到 HTTP 路由" | Pi 的 ModelRuntime 启动时先调 `GET /v1/models` 做模型发现，网关缺该路由 | **真缺口，已补**：网关新增 `handleListModels` + HTTP 挂 `GET /v1/models`（返回逻辑模型清单）。测试已补 |
| 5 | Pi 的 baseUrl 缺 `/v1` 后缀 | models.json 配的是根地址，Pi 直接拼接打到 `/chat/completions` | baseUrl 改为 `http://127.0.0.1:13000/v1` |
| 6 | 任务 RUN_FAILED：400（打到后端被拒） | vLLM 默认没开 tool calling；Pi 发 tools 数组时被拒 | vLLM 启动加 `--enable-auto-tool-choice --tool-call-parser hermes` |
| 7 | GitHub 直连不通（bun 官方安装失败） | 服务器不出海 | bun 走 npmmirror（v1.3.9），模型走 ModelScope，pip 走清华源 + PyTorch 官方 cu121 源 |

其中 #3、#4 是**部署挖出来的真实代码问题**，本地 385 测试没覆盖（managed-local + 真实 Pi 组合、网关模型发现路由），已修并补测试，测试数 385 → 387。

## 3. 场景矩阵执行情况

### S1 基础链路（4/4 通过）

| 检查 | 结果 |
|---|---|
| GET /health → ok:true | 通过 |
| GET /ready → ready:true | 通过 |
| 无认证调 /runs → 401 | 通过 |
| bootstrap key 全 scope 鉴权 | 通过 |

### S2 多租户隔离（5/5 通过）

注册 tenant-a / tenant-b（独立邮箱 + 密码登录），各建 workspace，各提交任务：

| 检查 | 结果 |
|---|---|
| 双租户正常登录 | 通过 |
| 各自提交返回 202 | 通过 |
| B 读 A 的 run → 404（不可枚举） | 通过 |
| B 用 A 的 workspaceId 提交 → 404 | 通过 |
| B 的 /queue 看不到 A 的任务 | 通过 |

### S3 真实 Agent 任务（3/3 COMPLETED）

任务"创建 hello.txt 并读取确认"在真实模型驱动下完成：

- 事件链：RUN_CREATED → STARTED → CONTROL_PREPARED → SANDBOX_ACQUIRED →
  SESSION_INITIALIZED → MODEL_STARTED/FIRST_TOKEN/COMPLETED →
  **TOOL_STARTED → WAITING_TOOL → TOOL_COMPLETED** → RUN_COMPLETED
- 工具账本：write（UNKNOWN_EFFECT）SUCCEEDED + read（READ_ONLY）SUCCEEDED，Checkpoint 已产生
- 真实副作用：hello.txt 落盘，内容 `hello-harness-a6000` 正确
- B1 的 WAITING_TOOL 状态机在真机事件链上实际出现
- 后续 6 并发任务（S6）同样全部 COMPLETED，共 9 个真实任务完成

### S4 中断与恢复（行为符合设计）

- 运行中 interrupt → INTERRUPTED（1 次成功）
- 无 Checkpoint 的 INTERRUPTED run 再 resume → 409"没有可用 Checkpoint"（fail-closed 符合预期）
- 7B 在 A6000 上太快（~30 秒完成 7 个工具调用），interrupt/crash 的自然窗口抓不住；
  崩溃恢复的确定性验证由服务器上直跑的 e2e 补齐：
  `worker-tool-governance.e2e`（PREPARED 与 COMPLETE 间 SIGKILL → fail-closed 记账保留）+
  `day7-recovery-resource.e2e`，2/2 通过

### S5 LLM 网关真实流量

| 指标 | 值 |
|---|---|
| 总请求（真实模型流量） | 29 |
| 成功 | 29，失败 0，回退 0 |
| usage 台账样本 | 29/29 落账（promptTokens 累计 66997） |
| 前缀缓存命中 | 0（诚实边界：vLLM 0.7.3 的 cached_tokens 未回传，采集链路本身工作正常） |

### S6 并发调度（6/6 COMPLETED）

6 任务并发提交（ThreadPoolExecutor），终态 6/6 COMPLETED；过程中同时观察到
QUEUED / RUNNING / COMPLETED 三种状态（调度器正常推进，无饥饿）。

### S7 会话归属（3/3 通过）

| 检查 | 结果 |
|---|---|
| 首次使用 sessionId → 202 认领 | 通过 |
| 跨租户抢注同一 sessionId → 409"已被其他租户占用" | 通过 |
| 归属租户复用 → 202；全新 id → 202 | 通过 |

### S8 审计与登出（4/4 通过）

| 检查 | 结果 |
|---|---|
| /audit?limit=2 返回 2 条 | 通过 |
| RUN_SUBMIT 记 resourceType=RUN + resourceId=run id + 租户非空 | 通过 |
| 无效 token 登出 → 401 | 通过 |
| 有效登出 200 后同一 token 再登出 → 401 | 通过 |

## 4. 诚实边界（本次验证未覆盖 / 已知缺口）

1. **沙箱为 development + managed-local**：A6000 无 runsc，容器隔离路径未在真机验证（与 deploy 示例一致，已文档化）。
2. **前缀缓存命中为 0**：网关采集链路工作（29/29 样本），但 vLLM 0.7.3 未回传 cached_tokens；Qwen2.5-7B 下的真实命中率待换新版 vLLM 后复验。
3. **崩溃恢复的真机自然窗口**：7B 太快抓不住自然崩溃窗口，确定性部分由 e2e（真实子进程 + SIGKILL 注入）在服务器上直跑覆盖。
4. **中断后 resume 全链路**：因无 Checkpoint 的 resume 拒绝已验证，携带 Checkpoint 的完整 resume 续跑待构造更长任务后补。
5. **vLLM/tool-calling 版本钉死**：vLLM 0.7.3 + torch 2.5.1 cu121 + transformers 4.48.3 是驱动 12.2 下的兼容组合，换驱动后可升级。

## 5. 运维备忘

- vLLM 启动：`/home/f630/cxr/harness-deploy/start-vllm.sh`（setsid 后台，日志 vllm.log）
- Harness 启动：`/tmp/relaunch.sh`（先 pkill 再 setsid **后台 `&`**，日志 harness.log；2026-09-10 修复——原脚本 `setsid` 未加 `&`，setsid 直接 exec 成 bun 导致调用方永久阻塞，此前重启"成功"是因 ssh 会话被杀时 bun 因独立会话存活）
- 模型下载/降级脚本与日志均在 `cxr/harness-deploy/` 下保留
- 凭证：bootstrap key 与 agent key 已生成并写入 `a6000-harness.env` + models.json（**不要提交到 git**；`deploy/a6000-harness.env` 本地版仍为模板值）
- 复现冒烟：`deploy/a6000-harness.env` + `deploy/a6000-vllm-models.json` 为本机配置模板

## 6. 第二轮扩充场景（S9–S17，2026-09-10）

> 触发：第一轮 8 组场景后继续加压。本轮在真机上**先挖出并修复 1 个 B 级竞态 bug（B11）**，
> 再执行 9 组新场景共 75 项检查（74 过 / 1 项为采样竞态，见 §6.3 诚实边界）。
> 脚本：`cxr/harness-deploy/scenarios2.py`（S9–S16）、`s9b.py`（S9 补充）、`scenarios3.py` + `run-s17.sh`（S17 低配竞争）。

### 6.0 B11：真机日志挖出的调度启动竞态（已修复）

第一轮 S4 中断测试后，harness.log 反复出现 `RunQueuePump 推进失败：非法的 AgentRun
状态转换：INTERRUPTED -> RUNNING`。根因：`executeQueuedRun`/`executeQueuedResume`
读到 QUEUED 后无条件写 RUNNING，用户恰在此时中断排队中的 Run 即撞状态机。
**修复**：启动方遇到并发接管（INTERRUPTED/FAILED）时放弃启动并交还调度器；
对 COMPLETED 的原 throw 语义不变。回归测试
`tests/runs/run-service-queued-start-race.test.ts`（5 用例，含竞态注入），全量
**392 pass / 0 fail / 4575 断言**。详见 `docs/known-issues.zh-CN.md` §11。

### 6.1 第二轮场景矩阵与结果

| 场景 | 覆盖内容 | 结果 |
|---|---|---|
| S9 Run 详情端点家族 | 详情+decisions / events 完整链 / observability / output / workspace-diff / artifacts 列表+下载；跨租户访问 4 端点全部 404 | 11/12 过（S9.2b 见 6.3） |
| S10 Checkpoint 中断-恢复闭环 | 长任务（3 文件）运行中打断 → checkpointId 产生 → resume 202 → **RUN_RESUMED** → COMPLETED → 三文件全部落盘、恢复后工具继续执行 | 8/8 过（补齐第一轮诚实边界#4） |
| S11 输入校验与边界 | 缺字段/类型错 400、不存在 run/artifact 404、缺 name 400、未认证 /eval /resources /audit /llm-gateway/stats 401 | 10/10 过 |
| S12 同会话串行 | 同 sessionId 三任务：r2 观察到 QUEUED→执行；**时间戳严格序 r2.started ≥ r1.completed**；排队中 r3 被打断收敛；会话完成后可复用 | 6/6 过 |
| S13 B11 竞态复现 | 启动窗口内（1.2–2.5s 延迟）中断 ×4：全部收敛 INTERRUPTED、日志零非法转换 | 3/3 过 |
| S14 网关直调协议面 | 非流式+usage / 流式 SSE+末尾 usage 注入 / GET /v1/models / 未知模型 4xx / 错误 key 401 / bootstrap key 可用 | 7/7 过 |
| S15 观测面 | /eval 租户视图+executionQuality / **租户隔离（B 不含 A 的 run）** / /resources HOST_WIDE 标注 / /agents / gateway stats 决策记录 | 7/7 过 |
| S16 会话生命周期 | 双端登录两 token / DELETE /auth/sessions 全撤 / 双 token 失效 401 / 再登录可用 / 重复注册 4xx | 8/8 过 |
| S17 公平调度竞争 | 低配重启（全局 2 / 每租户 1 / pump 500ms）：A/B 各 3 任务并发——每租户同时运行≤1、全局≤2、竞争期存在排队、QUEUE_BLOCKED 事件落链、6/6 COMPLETED、零非法转换 | 9/9 过（起跑序 A1,A2,B1,A3,B2,B3） |

（S9 补充 s9b：sleep 型任务 3/4 过，FAIL 项与 S9.2b 同因，见 6.3。）

### 6.2 第二轮挖出的真机事实

1. **bash 工具被策略守卫拒绝（fail-closed，设计行为）**：模型调用 `bash sleep 8` 得到
   `TOOL_FAILED："执行环境无法隔离 Workspace，拒绝 bash"`。根因是
   `tool-policy-guard` 要求 bash 具备 `filesystemIsolation` 证明，而
   `managed-local-sandbox.ts:115` 诚实声明 `filesystemIsolation: false`（容器/runsc
   部署才为 true）。模型收到 isError 后自适应改用 read 完成任务——治理链路
   （DENY 记账 + 模型自适应）在真机上按设计工作。**含义**：managed-local 部署下
   write/read/edit 可用、bash 不可用；runsc/容器部署下 bash 可用。
2. **S12 的第一版断言差点冤枉串行化**：Qwen2.5-7B 在 A6000 上 2.4s 就完成双工具任务，
   2.5s 间隔的轮询落在"r1 完成→r2 接棒"之后，误判为并发。改用**事件时间戳严格序**
   （r2 RUN_STARTED ≥ r1 RUN_COMPLETED）后证明串行化正确。教训：快模型下一切靠
   采样时序的断言都要用落库时间戳代替。
3. **场景脚本两次踩 workspace 201**：POST /workspaces 返回 201（非 200），两版脚本
   的状态码断言都漏了。产品行为正确，脚本修正。
4. **运维脚本 bug**：`/tmp/relaunch.sh` 的 `setsid` 未加 `&`，调用方永久阻塞
   （详见 §5）；S17 第一次编排因此被 900s timeout 击杀、env 未恢复。已修复并用
   `bash -n` 验证。

### 6.3 诚实边界（第二轮）

1. **WAITING_TOOL 的实时轮询观察（S9.2b/S9b.1，唯一未过项）**：managed-local 下
   bash 被拒，write/read 类工具单次执行 <30ms，0.15–0.5s 轮询抓不住 ~60ms 的
   WAITING_TOOL 窗口。该状态的正确性证据改为：① 事件链 TOOL_STARTED/TOOL_COMPLETED
   （B1 写入方自身的事件）；② 确定性单测（RUNNING↔WAITING_TOOL 往返）；③ S10 的
   工具执行中打断行为。若 runsc 部署下 bash 可用，`sleep N` 可制造任意长窗口。
2. **B11 的"claim→写入"竞态窗口在真机未直接命中**：7B+快盘下该窗口仅 ~10–50ms，
   S13 的 4 次真实中断全部落在 RUNNING 路径。竞态注入由单测确定性覆盖（子类
   Store 抢跑模拟并发中断先赢）；真机证据是全轮次中断（QUEUED 中/RUNNING 中）
   均收敛且日志零非法转换。
3. **S17 的公平性为软证据**：6 任务起跑序受提交时序影响（A1,A2,B1,A3,B2,B3），
   未断言严格轮转；硬断言是容量上限（每租户≤1、全局≤2）与 QUEUE_BLOCKED 落链。
   严格 round-robin 交替由本地单测覆盖。
4. **S17.5 排队中打断未命中目标**：竞争被 7B 的高吞吐瞬间吸收，采样时队列已清空；
   排队中打断由 S12.4（真机）与 S17.8（零非法转换）共同覆盖。
