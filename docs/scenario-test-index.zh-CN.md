# 全场景测试总索引

> **这份文件是导航，不是结论。** 它只做一件事：把「86 个场景」和「跑了哪些实验 / 结果写在哪个文档 / 原始证据在主机哪个路径」对上号。
> 任何单条结论都必须回到被指向的那份文档去读，不要只看本文的摘要列。

编制日期：2026-09-11。上游依据：[`full-scenario-test-guide.zh-CN.md`](full-scenario-test-guide.zh-CN.md)（方案，74 基础 + 12 复合）。

---

## 0. 三十秒读完

| 问题 | 答案 | 去哪看 |
| --- | --- | --- |
| 一共要求多少场景？ | **86**（U12 + C12 + Q12 + R12 + S14 + G12 = 74 基础，+ X01–X12 = 12 复合） | [指南](full-scenario-test-guide.zh-CN.md) §1、§7、§8 |
| 实际跑了多少？ | **84 执行 / 2 未跑**（R07、S12）。执行里：67 完整通过、8 部分、8 FAIL（含 2 个当场已修、1 个是模型能力问题）、1 INCONCLUSIVE | [合并账](scenario-coverage-consolidated.zh-CN.md) §1、§2 |
| 系统侧还剩几个没修？ | **5 个**：N22、N25、N23、N18、N19 | [缺陷台账](known-issues.zh-CN.md)、[缺陷登记](defect-register.zh-CN.md) |
| 容量和长稳呢？ | λ\* = 1.146 任务/s；8h 长稳 3505 次沙箱 0 残留 | [合并账](scenario-coverage-consolidated.zh-CN.md) §9；证据见下方「跑道 A / D」 |
| 有没有假装通过？ | 没有。8 个 FAIL、3 个 INCONCLUSIVE/BLOCKED、2 个未跑都逐条登记并给了理由 | 本文 §5、[合并账](scenario-coverage-consolidated.zh-CN.md) §0.5 |

---

## 1. 文档地图（哪份文档是什么角色）

| 文档 | 角色 | 什么时候读 |
| --- | --- | --- |
| [`full-scenario-test-guide.zh-CN.md`](full-scenario-test-guide.zh-CN.md) | **测试方案**：86 个场景的清单、指标口径、环境分层 | 想知道「某个场景到底要求测什么」时 |
| [`scenario-campaign-split-plan.zh-CN.md`](scenario-campaign-split-plan.zh-CN.md) | **实验分工**：跑道 A/B/C/D 的分配、依赖顺序、禁碰清单 | 想知道「这个场景在哪条跑道、用什么环境跑的」时 |
| [`scenario-campaign-prompts.zh-CN.md`](scenario-campaign-prompts.zh-CN.md) | **执行提示词**：各跑道 agent 的 brief | 想复现同一次执行时 |
| [`full-scenario-test-report-20260910.zh-CN.md`](full-scenario-test-report-20260910.zh-CN.md) | **主报告**（365 行）：campaign-20260910-01 的实际执行结论 | 读单场景的原始判定与终端输出时 |
| [`scenario-coverage-consolidated.zh-CN.md`](scenario-coverage-consolidated.zh-CN.md) | **合并账（对账中枢）**：逐 ID 的最终状态、容量数字、未跑清单、范围冻结 | **查任何场景状态的第一入口** |
| [`known-issues.zh-CN.md`](known-issues.zh-CN.md) | **缺陷台账 + 修复记录**（§1–§22）：每条缺陷的现象/根因/修法/真机复验 | 想知道「这个 FAIL 根因是什么、修没修」时 |
| [`defect-register.zh-CN.md`](defect-register.zh-CN.md) | **缺陷登记与收尾边界**：待处理项不再增加的收口头 | 想知道「还剩什么、边界在哪」时 |
| [`e2e-real-run-walkthrough.zh-CN.md`](e2e-real-run-walkthrough.zh-CN.md) | **真实闭环走查**（1004 行）：一个任务从输入到输出的实测 stdout，未改写 | 想看「真实执行长什么样」时 |
| [`lane-d-soak-runbook.zh-CN.md`](lane-d-soak-runbook.zh-CN.md) | **8h/24h 长稳手册**（是手册，不是结果） | 要重跑长稳时；结果见本文跑道 D |
| [`a6000-deployment-report.zh-CN.md`](a6000-deployment-report.zh-CN.md) | **A6000 部署报告**：环境基线 | 想核对硬件/模型/版本基线时 |
| [`test-evidence-map.zh-CN.html`](test-evidence-map.zh-CN.html) | **不变量 → 单元/组件测试 → 代码行** 对照（HTML） | 想知道「某条不变量被哪条单测守住」时 |
| [`completion-status.zh-CN.md`](completion-status.zh-CN.md) | **完成度对账**：逐条「完成定义」的证据位置 | 想知道「产品承诺哪些做到了」时 |
| [`project-handbook.zh-CN.md`](project-handbook.zh-CN.md) | **技术主文档** | 先读这份建立整体认知 |
| [`scenario-atlas.zh-CN.html`](scenario-atlas.zh-CN.html)、[`scenario-mechanisms.zh-CN.html`](scenario-mechanisms.zh-CN.html)、[`scenario-technical-anatomy.zh-CN.html`](scenario-technical-anatomy.zh-CN.html) | **展示材料** | 给外部看时 |

---

## 2. 实验（跑道）→ 覆盖范围 → 结果文档 → 原始证据

跑道定义见 [分工计划](scenario-campaign-split-plan.zh-CN.md) §3。环境档：**E0** 确定性（Fake，证状态机/竞态）、**E1** 真机真实任务、**E2** 隔离（E1 + container/runsc）。

| 跑道 | 端口 | 环境 / provider | 覆盖场景 | 结果写在哪 | 原始证据路径（测试主机） |
| --- | --- | --- | --- | --- | --- |
| **A 串行测量** | 13010 | E2 / container | **Q01–Q07、Q09、Q11、Q12**；**§9 容量 A1–A6**；C03/C04/C08 的长输入档 | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「Q」+ §9 | `campaign-serial-c-20260910/evidence/load/`（`CAPACITY-SUMMARY.md`、`cap-a1-t*/`） |
| **B1 浏览器** | 13011 | E1 / managed-local | **U01–U12**（上半） | 主报告 §U + [合并账](scenario-coverage-consolidated.zh-CN.md) §1「U」 | `campaign-ui-b1-20260910/evidence/`（`report.md`、`cases/`、`runs/`、`server-logs/`） |
| **B2 浏览器** | 13012 | E1 / managed-local | **U01–U12**（下半）+ C09 | 同上 | `campaign-ui-b2-20260910/evidence/`（含 `findings.json`） |
| **C 功能场景** | 13013 / 13014 | E0/E1/E2 | **C01–C12、R01–R12、S01–S14、G01–G11** | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「C/R/S/G」 | `campaign-func-20260910/evidence/`（19 项）、`campaign-func-e2-20260910/evidence/`（2 项） |
| ↳ C 的隔离专项 | — | **E2** / container | **S05–S08、R05**（真实工具边界、Secret、限额、不确定写入） | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「S」「R」 | `campaign-e2-20260910/evidence/`、`campaign-func-e2-20260910/evidence/` |
| ↳ C 的运维专项 | — | E1 | **G03、G08** | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「G」 | `campaign-g03-20260910/evidence/`、`campaign-g08-20260910/evidence/` |
| **D 跨会话长稳** | 复用 13010 | E2 / container | **G12、X09**（量级覆盖）；§9 耐久 8h | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「G12」+ §9 | `/home/f630/homePLUS/soak-evidence/`（`soak-8h/`、`README-soak-8h.md`、`monitor.jsonl`、`*.py`） |
| **复合剧本 X01–X12** | 跨跑道 | 依剧本 | **X01–X12** | 主报告 §8 + [合并账](scenario-coverage-consolidated.zh-CN.md) §1「X」 | 见各自依赖的跑道 |
| **N28 专项复验** | 13030 | E2 / container | N28（会话上下文撑爆） | [台账](known-issues.zh-CN.md) §21 | `/home/f630/homePLUS/soak-evidence/n28-verify*`、`n28-compaction-samples.txt`、`n28-verify-verdict.json` |
| **N28 主机制复验** | 13031 | E2 / container | Pi 摘要式压缩（网关兜底关闭） | [台账](known-issues.zh-CN.md) §22 | `/home/f630/homePLUS/soak-evidence/pi-compact-arm-a*`、`pi-compact-obs*` |

> **证据不进 git**：原始证据含凭证、大文件与运行时产物，只落在测试主机 `ssh f630@100.65.162.35` 上；仓库只保留文档与源码。共享端口 13000（Harness）与 18000（vLLM）全程禁碰。

---

## 3. 逐场景组 → 结果文档定位

| 组 | 数量 | 结果文档与锚点 | 证据根 |
| --- | --- | --- | --- |
| **U 用户旅程与体验** | 12 | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「U 用户旅程」 | 跑道 B1/B2 |
| **C 任务能力、输入与上下文** | 12 | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「C 任务能力与输入」 | 跑道 C + A（长输入档） |
| **Q 并发、公平与背压** | 12 | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「Q 并发、公平与背压」 | 跑道 A |
| **R 长任务、生命周期与恢复** | 12 | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「R 长任务、生命周期与恢复」 | 跑道 C（R05 用 E2） |
| **S 文件、结果、隔离与权限** | 14 | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「S 文件、结果、隔离与权限」 | 跑道 C（S05–S08 用 E2） |
| **G 模型网关、依赖与运维** | 12 | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「G 网关、依赖与运维」 | 跑道 C + D（G12） |
| **X 复合剧本** | 12 | [合并账](scenario-coverage-consolidated.zh-CN.md) §1「X 复合剧本」+ 主报告 §8 | 跨跑道 |

**每个场景要测什么** → [指南](full-scenario-test-guide.zh-CN.md) §7（U/C/Q/R/S/G 各一张表）、§8（X 各一个剧本）。
**每个场景的实际结果** → [合并账](scenario-coverage-consolidated.zh-CN.md) §1 对应组的表。

---

## 4. 容量与长稳（§9，独立于那 86 个场景）

| 档位 | 结果 | 结果文档 | 原始证据 |
| --- | --- | --- | --- |
| A1 单用户分族基线 | t1 30/30；t2/t3/t6/t7 的 0 通过已复核归因（见 [台账](known-issues.zh-CN.md) §20） | [合并账](scenario-coverage-consolidated.zh-CN.md) §9 | `campaign-serial-c-20260910/evidence/load/cap-a1-*` |
| A2 并发阶梯 | C=1/2/4 → 0.293 / 0.580 / **1.153** 任务/s；**C=8+ 未跑（环境阻塞）** | 同上 | 同上 |
| A3 稳定吞吐 | **λ\* = 1.146 任务/s**（1806s、2069 完成 / 0 失败、正确率 96.8%） | 同上 | `.../load/` |
| A4 到达率阶梯（=Q12） | 0.5–1.2×λ\* 稳态；2.0×λ\* 过载 → **拐点在 1.2×–2.0× 之间** | 同上 | 同上 |
| A5 突发 | 3/3 轮 6/6 完成，无过载 | 同上 | 同上 |
| A6 热点租户 | **NOT_RUN**（发压器无加权多租户到达模式）→ X01 完整版未覆盖 | 同上 | — |
| 耐久 8h | **完成**：3505 次沙箱创建/回收、0 残留；RSS/FD/线程全程无泄漏；`/runs` p50 11ms、`/eval` p50 14ms | [合并账](scenario-coverage-consolidated.zh-CN.md) §9 + [台账](known-issues.zh-CN.md) §21 | `/home/f630/homePLUS/soak-evidence/soak-8h/`（`summary.json`、`monitor.jsonl`） |
| 耐久 24h | **未跑**（墙钟；已冻结为不做） | [合并账](scenario-coverage-consolidated.zh-CN.md) §0.5 | — |

> **读容量数字必须一起看的三点**（[合并账](scenario-coverage-consolidated.zh-CN.md) §9）：① λ\* 由**闭环** C=4 定义，会低估容量——开环 2.29× 实际达成 1.887 任务/s，比 λ\* 高约 65%；② A1 的 t4/t6/t7/t8 与另一路发压器并发跑过，数字可能被污染；③ C=8+ 是**宿主 GPU 余量 <1G 的环境阻塞**，不是系统拐点。

---

## 5. 未跑 / 部分 / 不能判定（先读这节，再读任何结论）

已冻结为「不做、不计为欠账」，理由见 [合并账](scenario-coverage-consolidated.zh-CN.md) §0.5。

| 项 | 状态 | 原因 |
| --- | --- | --- |
| **R07**（T8 30/60min 长任务） | NOT_RUN | 需 30/60min 墙钟 + 75min 执行超时（默认 30min 跑不过） |
| **S12**（1000/10000 文件 + 抓取中改源文件） | NOT_RUN | 未排期 |
| **G12 / §9 的 24h 档** | NOT_RUN | 墙钟；8h 档已完成 |
| **X01**（5 租户高峰完整版） | 部分 | 核心断言由 Q05 覆盖；发压器无加权多租户到达模式 |
| **X03**（排队→启动→停止→继续提交） | 部分 | 核心断言由 R02 竞态补活覆盖 |
| **X08**（同 Workspace 并发改 + 产物历史） | 部分 | 核心断言由 S11 + S13 覆盖 |
| **X09**（完整业务日） | 部分 | 8h 长稳覆盖量级；含 eval/历史查询高压的剧本未单独发压 |
| **U08** 滚动断言 / **U09** 长时交互 / **U12** 第二浏览器 / **Q10** 归因 | INCONCLUSIVE / BLOCKED | 环境或夹具限制（IAB 重置标签页、无第二浏览器、显存高位无法隔离归因） |
| **§9 C=8/16/32/64、A6 热点租户** | 未跑 | C=8+ 是环境阻塞（宿主 GPU 余量 <1G）；热点租户是发压器能力缺口 |
| **多机 HA / 主动接管 / p99 承诺** | OUT_OF_SCOPE | 超出单节点产品承诺；p99 样本不足 1000 |

---

## 6. 读结论时必须同时看的边界

1. **「PASS」有三种含义，别混用。** 按[指南](full-scenario-test-guide.zh-CN.md) §2.1，一个任务要分「系统正确性 / 任务能力 / 用户体验」三份结论。**C05、C03、A1 的多族 0 通过都是「系统 PASS / 能力 FAIL」**——系统正确拒绝了、模型没做出来。把这类算进"通过率"会误导。
2. **模型能力是最大短板，但只对特定族成立。** 跑道 A 报出的 T2/T3/T6 "0 通过"已逐案复核为**验收器缺陷 + 驱动复用会话 + 上游 N27**，**只有 T7 是真实的步数/能力失败**（[台账](known-issues.zh-CN.md) §20）。
3. **上游 N27 是真正的硬约束。** vLLM 流式工具调用参数偶发丢末字符（实测 26%，批次间 5%–58%），绕过 Harness 直连 18000 也能复现——直接决定"结构化产物"能否落盘。
4. **E2 的证据只对跑过 E2 的场景成立。** U/C/Q 的大部分在 E1（managed-local）上跑，**不能用来声明 OS 级隔离**；隔离结论只看 S05–S08、R05 这几个真容器场景。
5. **已入库测试相对已入库源码偏旧。** 本轮按约定 9 个改动 + 25 条新增的测试路径**只留本地未入库**（`tests/` 已入库 71 个文件、本地 92 个），因此**在新克隆里 `bun test` 不保证全绿**；本机全量以最后一次提交时的 **417 pass / 0 fail** 为准。
6. **共享主机的一切吞吐/延迟数字不可当独占容量。** 本机 load 长期 ~31、GPU 被 vLLM 预占 44G；只有 pass/fail 与守恒关系是有效结论。

---

## 7. 复现入口

```bash
# 仓库自带全量测试（本机，含未入库测试）
bun run test && bun run typecheck

# 真实闭环走查（需启动 Harness）
bun run smoke:http
bun run scripts/e2e-walkthrough.ts

# 容器隔离 smoke（需 Linux + Docker/runsc）
bun run smoke:container
bun run smoke:container:attacks

# 发压器（本机未入库；测试主机上在 campaign 目录内）
bun run scripts/campaign/load-driver.ts --help
```

测试主机上的实例重建：[`scenario-campaign-split-plan.zh-CN.md`](scenario-campaign-split-plan.zh-CN.md) §3 + `provision-instance.sh`。
