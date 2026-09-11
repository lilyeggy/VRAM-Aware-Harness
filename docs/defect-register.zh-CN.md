# 缺陷登记表与收尾边界

> 这是一份**收口头**，不是第五份交付物。它存在，是为了让后面不再出现「新东西」。
> 判断标准只有一句：**做完这份表，待处理项的分子不再增加。**

> **2026-09-11 状态补充（截至最后一轮）**：本表登记的是更早一轮的 F 系列自查项；全场景测试暴露的
> **N 系列缺陷已全部修复**：
> ① N18/N19/N22/N23/N25 高危项经真机复验（§23）；
> ② N20/N21/N24/N26 中等项（§24）；
> ③ 最后 7 项 N27/N5/N15/N16/N9/N10/N14 收口（§25）——N27 改为网关侧兜底修复，
> N5 改为"基线之上增量"语义，N15 补策略管理面，N16 补人工消解出口，N9 改 404，
> N10 加老化插队，N14 PID 上限可配置。
> **本项目代码范围内未修缺陷为 0**；仍未修的只剩"测量有效性"（测试驱动 T1–T5）与
> 明确不做的多机/生产级能力。以上 7 项只在本地确定性环境验证，未重跑真机 campaign。
> 见 [known-issues.zh-CN.md](known-issues.zh-CN.md) §23–§25。

## 0. 为什么需要它：先诊断，再定边界

可核验的事实：

| 项 | 实测 |
|---|---|
| 最后一次 commit | `1982a1b` · **09-08 16:35** |
| 此后至今 | **约 3 天，0 次提交** |
| 工作区堆积 | 45 个 `src/` 已改未提交 · 57 个已改/删除 · 54 个未跟踪 · `+2824 / -12808` |
| 本次会话对 `src/` 的改动 | **0 个文件**（今天 `src`/`tests`/`scripts` 仅 1 个变动，是 `tests/.DS_Store`） |

所以「收尾难」是**结构问题**，不是缺陷数量问题：

> 没有封箱点 ⇒ 新探索和旧结论堆在同一个工作区 ⇒ 待处理项的分母只增不减 ⇒ 永远看不到「完成」。

就算一条缺陷都没有，只要三天不 commit，也会感觉收不了尾。

## 1. 三层边界

### 边界一 · 交付边界（定死）
**完成 = 四份文档覆盖已实跑的 13 个场景 + 未跑的 20 个入口只登记、不背书。**

判据（全部满足即封箱）：
1. 每个已跑场景「测什么 / 期望 / 实测 / 暴露了什么」四段齐全
2. 每条核心承诺有 `文件:行` 的断言锚点
3. 未跑清单逐条标明缺什么环境
4. 正文不再出现「待续写」

**停止条件：不再新增文档、不再新增场景章节、不再开启新的分析视角。**

### 边界二 · 缺陷边界（定死处置方式，不定数量）
**新发现一律即时登记，不进入本轮讨论。**

只有满足以下**任一**，才允许升为「必修」：
- **(a)** 使某条**已实跑场景的结论**不成立
- **(b)** 使四条核心承诺之一不成立：沙箱隔离 / 工具幂等 / 恢复 fail-closed / 审计按租户过滤

### 边界三 · 探索边界（关闭）
**不主动通读未跑入口去找缺陷。** 理由：那是无界的——20 个入口 × 每个都能再挖出若干，正是「越改越多」的来源。我之前的提议（按同一把尺子清扫 20 个入口）**属于无界提议，此处撤回**。

只有入口在环境具备时被**真跑**，才允许开启新一轮发现。

## 2. 登记表（5 条，全部已定位）

| 编号 | 症状 | 根因 | 影响半径 | 处置 | 判据 |
|---|---|---|---|---|---|
| **F-4** | 中断失败被静默丢弃 | `settlesWithin` 把 rejection 也算 settled（`supervised-agent-runtime.ts:129-137`） | 库写 INTERRUPTED 而载体可能仍在跑；`stop()` 的「N 个 Run 无法中断」防线不可达 | **必修** | 命中 (a)：场景 8 断言「关闭有序」，F-4 使「所有 Run 已中断」不可证实 |
| F-3 | 两条失败分支终态不一致 | `case "RUN_FAILED"` 只 reject、不发 `agent_failed` | Run 级看不到失败原因 | 归档 | 未命中——状态不失真，只是不完整 |
| F-1 | 阻断事件折叠失效 | 删除判据把「被摘走」当「不再排队」 | 约 1 条/秒写入放大，TTL(5 min) 兜住 | 归档 | 未命中——不撒谎，仅放大 |
| F-5 | 关库竞态 | `stop()` 不回等 in-flight attempt | 报 closed database | 归档 | 未命中——不静默，由 pump `onError` 报出 |
| F-2 | 读路径先查存在性、后鉴权 | `getRequiredRun()` 顺序 | 1 bit 信息边界，UUID 不可枚举 | 归档（可选收紧） | 未命中 |
| F-6 | **t3 的 `result_json_created` 在 workspace 复用时恒为 false** | 判据只看 diff 的 `added` 桶；对既有文件的写入落在 `modified`（`load-driver.ts:1175-1191`） | t3 几乎不可能 PASS（439 个只有 2 个） | 只登记（已定位机制） | 未命中 (a)——soak 不在「已跑 13 场景」内；但使 soak 的 t3 数字失真 |
| F-7 | **`pathOf()` 读不出真实 diff 条目** | `pathOf` 取 `x.path`，真实 API 的 `modified` 条目是 `{before:{path…},after:{path…}}`（`:912-920`） | 所有 `diff_*` 类检查恒真 ⇒ 其「100%」无证明力 | 只登记 | 未命中——不使结论失效，只使若干「通过」失去证明力 |

复现命令：

```bash
bun run tmp/day7-inspect.ts        # F-1
bun run tmp/close-failure-probe.ts # F-4 / F-5
bun run tmp/close-probe.ts         # 场景 8 的补做断言（7/7 PASS）
```

### F-6：已定位到机制（原先记为「待核实」，本轮读检查器源码后升格）

**判据原文**（`campaign-soak-20260911/load-driver.ts:1175-1191`，sha `daa45e7f…`）：

```ts
const added = diffBuckets(diff).added;
const hasResult = added.some((p) => p.endsWith("result.json"));
checks.push({ name: "result_json_created", ok: hasResult, detail: `added=...` });
const allOk = hasResult && contentOk === true;   // ← 两个都为真才 PASS
```

**决定性证据**（回收的 run `000d5508-080b-48e1-91a5-d541822997d1` 的 `workspace-diff.json`）：

```json
"added": [],
"modified": [{ "before": {"path":"result.json","hash":"ca39e114…","size":45},
               "after":  {"path":"result.json","hash":"34142a5a…","size":45} }]
```

同一 run 的验收：`result_json_created=false (added=[])`、`result_json_content=true
(source=disk parsed={"caseId":"soak-8h-13010-001303","answer":42})`。

**机制**：`result.json` 在该 workspace 的**基线里已存在**，本轮写入被 diff 归类为 `modified`
而非 `added`；判据只看 `added` ⇒ 恒 false。而 `content` 从磁盘读出的 caseId
**等于本 run 自己的 caseId** ⇒ 这个文件确实是**本轮**写的（若是上一轮遗留，caseId 会对不上）。

⇒ 原先并列的两种解释里，**「检查器对、内容检查误判」被排除**。t3 的 367 个 FAIL
绝大部分是**判据错**，不是系统错；**「t3 PASS=2」不能读成「t3 任务做不出来」**。

### F-7：`diff_*` 类检查恒真（blast radius 比 F-6 更大）

同一条证据里 `modified` 条目的形状是 `{before:{…}, after:{…}}`，**没有顶层 `path`**。
而 `pathOf(x)` 只认 `x.path` 或字符串 ⇒ 返回 `""` ⇒ 被 `.filter((p) => p.length > 0)` 丢掉。
后果：真实 API 下 **`modified` / `deleted` 两个桶经常是空的**。

| 检查 | 判据 | 后果 |
|---|---|---|
| t1 / t2 `no_file_modification` | `changed === 0` | 只对「新增」敏感，**名不副实** |
| t4 `diff_modified_deleted_only_calc` | `badMods.length === 0` | 桶恒空 ⇒ **恒真** |
| t7 `diff_modified_only_modules` | 同上 | 恒真 |

聚合佐证：这三条**全部正好 100.0%**（t1 696/696、t2 732/732、t4 457/457）——
「永远不会失败」的典型特征。相比之下走 **sha256 对比夹具**的 `test_files_unmodified`(t4)、
`test_file_unmodified`(t10) 是**独立实现**，它们的 100% 才有证明力。

### ★ 更正：上一轮我说「FAIL 集中在 tool-trace 类检查」——**这是错的**

我按**检查名**分组统计，误把**不进判决的装饰性检查**当成了 FAIL 的原因。
读了每个族的 `ok` 判定式后：

| 族 | **决定 PASS/FAIL 的判据** | 判据通过率 | 该族 FAIL |
|---|---|---|---|
| t1 | `output_normalized_equals_391` | 99.4% | 4 |
| t2 | `read_trace_readme` **且** `read_trace_calc` **且** `readme_title_matches_fixture` **且** `add_returns_a_minus_b` | 1.0% / 1.0% / 27.7% / 88.7% | **729** |
| t3 | `result_json_created` **且** `result_json_content` | 0.9% / 43.3% | **367** |
| t4 | `independent_run_tests_pass` | 50.3% | 101 |
| t6 | `summary_values_exact` | 47.3% | 124 |
| t10 | `independent_test_greeting_pass` | 46.1% | 197 |

合计 4+729+367+101+124+197 = **1522** ✓ 与 `byFamily` 完全对上。

**不进判决的**（低通过率没有意义，别当证据）：

- `tool_trace_fail_then_pass` —— t4 代码里自己标了 `(informational)`；t10 没标，但 `ok` 里也没有它。
- `trace_read_orders`、`trace_write_summary`（t6）—— 只进 `checks`，`ok = valuesOk && expected !== null`。
- `greeting_raises_valueerror`（t10）。
- `diff_*` 三条 —— 见 F-7，恒真。

**修正后的读法**：`FAIL=1522` 由两个族主导 —— **t2 (729) + t3 (367) = 1096，占 72%**。
t3 已被证明是**判据错**；t2 的 `read_trace_*` **确实进判决**，它测的是「本轮有没有真的调用
`read` 读 README.md / calc.py」（由 run events 的 `TOOL_STARTED` 重建），
1.0% 的通过率**仍有「模型没读」与「轨迹重建取不到」两种可能，这一点没变**。

⇒ 对外只能说：**1522 个 FAIL 里至少 367 个（t3 全部）已确认是检查器判据问题；
t2 的 729 个方向未定。既不能整体读成「系统失败」，也不能整体读成「检查器全错」。**



## 3. 明确不做的事（写下来，免得反复回来）

- 不修 F-1 / F-2 / F-3 / F-5。
- 不对 20 个未跑入口做代码审查式清扫。
- 不新增第五份交付文档（本表是台账，不是交付物）。
- 不在 `src/` 有 45 个未提交改动的情况下，继续叠加新的 `src/` 改动。

## 4. 封箱动作

1. **认知层先封箱**：`docs/scenario-*.html`（3 份）+ `docs/test-evidence-map.zh-CN.html` + `docs/e2e-real-run-walkthrough.zh-CN.md` + 本文档 + `tmp/` 三个探针 + `.workbuddy/memory/`。
2. **`src/` 的 45 个改动单独处理**：它们全部早于本次会话（09-08 ~ 09-10），意图不明，**需要你确认后再提交**——我不替你判断。
3. 封箱之后的新发现进「下一箱」，不回头污染已完成的结论。

## 5. 2026-09-11 12:40 执行记录（方案 2：回收证据 + 清理）

- **停掉遗留监控**：`soak-monitor.sh`（pid 2743218，已空转 11h36m / 695 条样本）SIGTERM 后确认停止，
  残留 0。注意它自称「只读」，实际每分钟用硬编码账号登录并发 3 个已鉴权请求（`/queue`/`/runs`/`/eval`）。
- **回收证据**（14 MB → 本地 `tmp/remote-evidence/`）：
  - soak 结论层 + 聚合层：`report.md`、`summary.json`、`manifest.json`、`preparation.json`、
    `requests.jsonl`、`resources.jsonl`、`process-samples.jsonl`、`soak-8h.runlog`、`monitor.jsonl`
  - 12 个 campaign 的**顶层脚本与配置**（98 个文件，187 KB）—— 这层才是「到底测过什么」的记录
  - 5 个 run 目录作 schema 样本
- **未回收（待你决定）**：各 campaign 的 `evidence/` 原始数据合计 **328 MB**
  （`campaign-serial-c` 单独占 261 MB / 47038 文件）+ soak 的 `runs/` **179 MB**（3505 个目录）。
- **新增登记**：F-6，以及「FAIL 集中在 tool-trace 类检查」这一解读要点。
- **远程操作均为只读**（唯一写操作是停掉那个遗留进程）。本机 `src/` 改动 = 0。
