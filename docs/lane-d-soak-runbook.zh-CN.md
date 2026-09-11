# 跑道 D（跨会话长稳）READY-TO-FIRE 手册

> 状态：**未开跑（NO-GO）**。本文件是"门禁一开即可照抄执行"的手册，不是结果。
> 依据：`docs/full-scenario-test-guide.zh-CN.md` §9/§10、`docs/scenario-campaign-split-plan.zh-CN.md` §6.7。
> 门禁器：`runway-d-gate.sh`（本目录，已在真机验证 fail-closed 行为）。

---

## 1. 为什么现在不能开跑（2026-09-10 20:0x 核查）

| 门禁 | 实测 | 结论 |
| --- | --- | --- |
| λ* 存在 | **无**。跑道 A 于 19:54 才建 container 实例，19:54 只做完 `lane-smoke`，20:01 做完 A1（`cap-a1-t1`，C=1，30×T1）；A2/A3 未做 | ❌ 硬阻塞 |
| 无其它负载源 | **有**。A 的 `load-driver.ts` 活跃在 13010；13012(B2)/13013(C) 实例在听且其对话在写文件 | ❌ 硬阻塞 |
| 13010 归属 | 被跑道 A 独占（`campaign-serial-c-20260910`，provider=container/runsc） | ❌ 不能抢 |

→ **D 的所有档位（§9 耐久 2h/8h/24h、G12、X09、R07）本轮一律 `NOT_RUN`。**
按任务"诚实标注"要求：本会话内跑不完/未开跑的一律标 NOT_RUN，不得写成"跑了一半"的结论。

---

## 2. 开跑前必须补的两处配置（否则一定挂）

### 2.1 R07 / T8-60min 的执行超时

`HARNESS_EXECUTION_TIMEOUT_MS` 默认 **30min**（`src/app/harness-config.ts:283`）。
R07 要跑 T8 `slow-job --stages 60 --stage-wait 60`（60min），**默认 30min 必被 `executionTimeoutMs` 强杀**，
那不是"60min 通过"。必须在**实例 env 里显式设**：

```bash
HARNESS_EXECUTION_TIMEOUT_MS=4500000   # 75min
```

- 该值只在 `start.sh` `source campaign.env` 时生效 → **改完必须重启实例**，不是只 export。
- 夹具自身也点名了这点：`/home/f630/homePLUS/harness-fixtures/slow-job/slow-job.sh` 头注释
  "60x60s 需提高执行超时，默认 30min 不够"。

**单工具超时单独核实（已完成）**：`src/worker/worker-tool-gateway.ts:149` 的 `timeoutMs` 默认 10s，
且**没有任何调用点从 env 注入** → 它是"工具治理网关 IPC 往返"的 fail-closed 超时（握手/决策），
**不是单次工具执行时长上限**；容器 `docker exec`（`container-sandbox-provider.ts:226`）也未设命令级超时。
结论：bash 时长只受 `executionTimeoutMs` 约束，10s 不会切 60min 任务。

### 2.2 负载组合缺口（比超时更严重）

`load-driver.ts` 目前**只实现了 `t1` 与 `t3`** 两个任务族（`buildTasks()`，内置验收器只有这两族；
其它族 → `无 <family> 的内置验收器` → NOT_RUN/INCONCLUSIVE）。而：

- 指南 §9.2 要求比例混合 **T1/T2/T3/T4/T6/T7/T8/T10**；
- G12 要求"大量历史查询、eval、Artifact 下载"；
- R07 要求 T8 `slow-job`。

→ **现有发压器无法驱动 D 的必需负载**。在补驱动前，D 只能跑 "t1/t3-only 的耐久基线"
（可作资源曲线初筛，但**不能声称完成了 §9.2 混合 / G12 / R07**）。
补驱动属 `scripts/campaign/` 夹具（非 `src/` 业务代码），但需在真实负载下验证后才能当真。

---

## 3. 门禁一开，照抄执行

```bash
D=/home/f630/cxr/harness-deploy/lane-d-20260910      # 本跑道目录
E=$D/evidence                                        # 证据根（大文件改 homePLUS 见 §5）

# 0) 门禁（NO-GO 就停，别硬上）。λ* 从跑道 A 的交付处抄来。
bash $D/runway-d-gate.sh --lambda-star <A的λ*> --require-r07 \
     --instance-env /home/f630/cxr/harness-deploy/campaign-serial-c-20260910/campaign.env
```

门禁全绿后，**按 2h → 8h → 24h 递进**，每档用 `setsid nohup` 脱离会话：

```bash
L=0.7*<λ*>          # 0.7λ* 正常负载（任务/s）
cd /home/f630/cxr/harness-deploy/campaign-serial-c-20260910
export PATH=/home/f630/.bun/bin:$PATH; set -a; source campaign.env; set +a

# 2h 档：开环 0.7λ*（指数间隔），到点停提交、有界排空
setsid nohup bun run load-driver.ts \
  --base-url http://127.0.0.1:13010 --mode open --rate "$L" --arrival-dist exponential \
  --task t1 --users 4 --duration-s 7200 --drain-s 600 \
  --max-open-inflight 200 --total 100000 \
  --sample-min-ms 5000 --sample-max-ms 5000 \
  --tag soak2h --out $E/soak-2h \
  > $E/soak-2h.runlog 2>&1 &
```

峰值插入（"周期性插入峰值"）：在 soak 运行期间另起短突发，**同一时刻仍只有一个发压源**，
即用同一实例、串行叠加（如每 30min 打 1min 2×λ*），或把突发放进同一驱动窗口：

```bash
# 峰值：1min @ 2×λ*，跑完即退出，不与正常流"同时"开第二个生产进程
setsid nohup bun run load-driver.ts --mode open --rate "$(awk "BEGIN{print 2*$L}")" \
  --arrival-dist exponential --task t1 --duration-s 60 --drain-s 120 \
  --tag peak --out $E/peak-$(date +%H%M) > $E/peak.log 2>&1 &
```

> 8h/24h 档同法，仅 `--duration-s` 与 `--tag/--out` 改。**每档之间必须排空**再开下一档。

---

## 4. 采样（§10.1）

- 资源/网关摘要：驱动自带 `resources.jsonl`，`--sample-min-ms 5000 --sample-max-ms 5000` = **每 5s**。
- 进程/磁盘：驱动自带 `process-samples.jsonl`（含 Master/Worker RSS、FD、容器数）。**每 30–60s** 一段，
  故障前后提高到 1–5s。
- 另开一个 **每 5min `df`** 的看守（根盘是本机最紧资源，见 §5）。
- 证据目录照 §10.1：`manifest.json / plan.md / requests.jsonl / resources.jsonl /
  process-samples.jsonl / faults.jsonl / cases/ / runs/<runId>/ / server-logs/ / recovery/ / report.md`。

---

## 5. 磁盘红线

- 根盘 **余 66G / 已用 97%**（已知基线，非异常）；`homePLUS` 余 1.6T。
- **大文件（Artifact、SQLite 全量备份、服务日志）一律写 `/home/f630/homePLUS/...`**，不进根盘。
- 每 5min `df -BG /`；Artifact/DB 增长逼近红线（余量 <20G）→ **停止新增压力、保留证据**、写 `NOT_RUN` 说明。

---

## 6. 停止条件（命中任一：立即停压 + 保留证据）

跨租户泄露 / 不安全重放 / DB 损坏 / 宿主资源逼近危险阈值 / 控制面失联 >60s /
队列超本轮预设上限 / 30s 内内存异常跃升且持续增长。

**初筛门槛**（预热后空闲窗口）：Master RSS / FD / 存活 Worker 无持续爬升，**RSS 增幅 ≤ 20%**；
超出须解释缓存与回收机制。

---

## 7. 收工清理顺序（照 §9.5 / §6.7）

停生产者 → 撤故障/代理 → 记录残留任务 → 经 API 中断本轮残留 Run → 验证 Worker/容器/槽位 →
导出证据与备份 → 停本轮服务。
清理后核对：`curl http://127.0.0.1:13000/ready` 仍 ready、`docker ps` 里 **22 个 `polar-*` 一个不少**、
**dockerd PID 未变**。

**绝对禁碰**：13000 / 18000 不重启不发压；不重启 dockerd；不碰其他 `campaign-*` 目录；禁止 `pkill bun`；
不改 `src/` 业务代码；不 git commit。
