# Day 7：A6000 上的 Pi / Harness 对照实验手册

本文只定义真实环境验收方法，不预填任何性能结论。Fake Runtime 用来证明状态机、
恢复、资源准入与审计语义；完成率、延迟和 GPU 峰值必须来自同一台真实 A6000 上的
Pi + vLLM 实验。

## 1. 实验目标

回答三个问题：

1. Harness 是否在资源受限时真正把新 Run 排队，并在恢复后自动推进？
2. 发生进程中断后，已完成的工具副作用是否不会被重复执行？
3. 与直接调用 Pi 相比，Harness 引入了多少控制面开销，并换来了哪些可靠性证据？

本实验不预设 Harness 延迟更低。资源充足、单任务场景下，经过控制面通常会有少量
开销；项目价值主要由可恢复性、资源背压和审计事实证明。

## 2. 固定环境

每轮实验必须记录：

- GPU 型号与驱动版本；
- vLLM commit、启动命令和关键参数；
- 模型 ID、量化方式、上下文长度与 chat template；
- Pi SDK 版本；
- Harness commit 与阈值配置；
- 是否为冷启动、是否执行 warm-up；
- 服务器上是否存在其他 GPU 工作负载。

先检查服务与设备：

```bash
nvidia-smi
curl -sS http://<vllm-host>:<port>/v1/models
curl -sS http://<vllm-host>:<port>/metrics | head
```

`.pi/spike/models.json` 必须指向同一个 OpenAI-compatible `/v1` 地址，
`.env.example` 中的 `VLLM_MODEL_ID`、`VLLM_BASE_URL` 与它保持一致。

## 3. 固定任务集

至少选择三类任务，每类保留完全相同的 prompt、workspace 快照和工具权限：

1. 只读：读取 `README.md` 并提取指定事实；
2. 多步只读：检查测试目录并总结覆盖层级；
3. 可控写入：在一次性临时 workspace 中修改一个指定文件并运行测试。

每条路径先 warm-up 2 次，再正式运行至少 10 次。直接 Pi 与 Harness 交替执行，避免
把温度、缓存或后台负载的时间趋势全部偏向某一组。写入任务每次使用全新的临时副本。

## 4. 直接 Pi 基线

先验证模型—工具—模型循环：

```bash
VLLM_MODEL_ID="<模型ID>" bun run src/spikes/pi-vllm-tool.ts
```

正式重复实验时，为每次运行记录开始/结束时间、终态、工具调用次数、错误和
`nvidia-smi`/vLLM metrics 的峰值。只有出现 `tool_execution_start`、
`tool_execution_end`、最终回答和 `agent_end` 才算完成。

## 5. Harness 路径

导入配置并启动进程：

```bash
set -a
source .env.example
set +a
bun run start
```

另一个终端执行固定 smoke；可用环境变量替换输入和 workspace：

```bash
HARNESS_SMOKE_USER_INPUT="请使用 read 工具读取 README.md，并只回答第一行。" \
HARNESS_SMOKE_WORKSPACE_PATH="$PWD" \
bun run smoke:http
```

输出 JSON 中的 `status` 必须为 `COMPLETED`，并保存 `elapsedMs`、`decisions` 和
`timeline`。另外保存 `GET /queue`、`GET /resources` 和对应 Run 的 events 响应，
用来解释排队时间与资源决策。

## 6. 中断恢复与资源压力验收

至少执行一次真实故障实验：

1. 让任务完成一个可重放或幂等工具调用并写入 Checkpoint；
2. 使用 `SIGTERM` 关闭 Harness，确认进程走优雅关闭；
3. 使用同一个 SQLite 数据库重启；
4. 验证 Run 被重建到队列，并经过新的 PolicyDecision 与 slot 后调用 resume；
5. 对比 ToolExecution，确认已成功的副作用没有重复执行。

资源压力实验应通过受控并发或测试时降低阈值制造 `CRITICAL`，不能伪造为真实 GPU
数据。压力解除后，验证无需再次提交或人工点击，排队 Run 自动进入执行。

## 7. 结果表

| 路径 | 任务 | 正式次数 | 完成率 | 排队 P50/P95 | 总延迟 P50/P95 | GPU 内存峰值 | 重复工具执行 | 备注 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 直接 Pi | 只读 | 10 | 待填 | 不适用 | 待填 | 待填 | 待填 | |
| Harness | 只读 | 10 | 待填 | 待填 | 待填 | 待填 | 待填 | |
| 直接 Pi | 多步只读 | 10 | 待填 | 不适用 | 待填 | 待填 | 待填 | |
| Harness | 多步只读 | 10 | 待填 | 待填 | 待填 | 待填 | 待填 | |
| 直接 Pi | 可控写入 | 10 | 待填 | 不适用 | 待填 | 待填 | 待填 | |
| Harness | 可控写入 | 10 | 待填 | 待填 | 待填 | 待填 | 待填 | |

延迟统一使用单调时钟计算；P50/P95 的样本集合只包含正式轮次，但失败次数必须计入
完成率。排队时间定义为 Run 创建到 `RUN_STARTED` 或 `RUN_RESUMED`；控制面开销不能
用“总延迟差”直接替代，因为模型生成和缓存波动也包含在其中。

## 8. 结论门槛

只有满足以下条件后，才能将 Day 7 标记为真实环境全部完成：

- 固定任务集的原始输出、配置与指标可以复查；
- `CRITICAL -> NORMAL` 的真实 PolicyDecision 和事件时间线完整；
- 重启恢复实验不存在已成功副作用的重复执行；
- 直接 Pi 与 Harness 使用相同模型、任务、workspace 与工具集合；
- 报告同时写明收益、开销和异常样本，而不是只报告成功案例。
