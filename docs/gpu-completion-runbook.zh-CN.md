# GPU 真机闭合 Runbook（第 5 条：共享 GPU 压力真实驱动准入）

> 记录日期：2026-08-18。目标：在一台按量 GPU 实例上起真实 vLLM + 下载模型 + 暴露 `/metrics`，
> 让 ECS 侧 harness 的【真实】`VllmResourceObserver` 拉到压力并做出 QUEUE。
> 已实测跑通（AutoDL/GPUSsam `T4 16G`；ECS 47.111.83.126 阿里云）。

## 0. 拓扑与分工

```text
GPU 机（T4 16G，AutoDL 这类“主机级 GPU 实例/GPU 容器”）    ECS（harness 控制面）
  只跑 vLLM + 推理 + /metrics（:8000）                      真实 VllmResourceObserver 轮询
  └── ssh -R 18000:localhost:8000 ──►  ECS localhost:18000/metrics
```

关键点：**不在 GPU 机上跑 runsc 沙箱，不 docker-in-docker**。GPU 机只当"真实推理/显存/压力提供者"。
判断标准（三选）：有 NVIDIA 卡 + 能 `pip install vllm` + 能开端口被拉 `/metrics`。**纯 CPU 容器云不行**（无 GPU + dind 受限）。

## 1. 环境与版本（实测组合，避开版本地狱）

```text
Tesla T4 16G · CUDA 13 driver（nvcc 可无，只需 driver）
Python 3.12
venv 建于数据盘（/root/rivermind-data/venv，别占满 30G 系统盘）
vllm==0.7.3 + torch==2.5.1(cu121) + transformers==4.48.3 + tokenizers==0.21.0
```

踩坑记录（重要）：
- **vllm 与 transformers/tokenizers 三环版本必须自洽**：给 vllm 0.7.3 用
  `transformers==4.48.3` + `tokenizers==0.21.0`（transf. 4.48 要 tok>=0.21）；
  若你装到 transformers 5.x 会崩 `Qwen2Tokenizerhas no attribute all_special_tokens_extended`。
- **slow tokenizer 缺 `all_special_tokens_extended` 的兜底**：放一个 `sitecustomize.py`
  到 `venv/lib/python3.12/site-packages/sitecustomize.py`，给
  `PreTrainedTokenizerBase` 补 property 返回
  `[{"content": v, "name": k} for k,v in special_tokens_map_extended.items()]`。
  实测 vllm 0.7.3 + 4.48.3 加该垫片可正常启动（不加则崩）。
- 下载走 `HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1`（用普通 HTTP，避免 xet 401）。
- 后台任务用 `nohup ... > log 2>&1 &`，别用复杂 heredoc/setsid 内联（ssh 会话结束易丢）。

安装序列（GPU 机）：
```bash
cd /root/rivermind-data && python3 -m venv venv
./venv/bin/pip install -U pip -i https://pypi.tuna.tsinghua.edu.cn/simple
./venv/bin/pip install "torch==2.4.1" -i https://pypi.tuna.tsinghua.edu.cn/simple   # 先验 cuda
./venv/bin/python -c "import torch;print(torch.cuda.is_available())"                 # True
./venv/bin/pip install "vllm==0.7.3" "transformers==4.48.3" "tokenizers==0.21.0" \
  -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## 2. 下载模型

```bash
export HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1
cd /root/rivermind-data
nohup ./venv/bin/hf download Qwen/Qwen2.5-7B-Instruct-AWQ \
  --local-dir ./models/Qwen2.5-7B-AWQ > /root/dl.log 2>&1 &
# 5.2G；完成后：
```
注意：`use_fast` 选择会导致 slow/fast 差异；上面 sitecustomize 垫片已兜底。

## 3. 起 vLLM serve（暴露 /metrics）

```bash
cd /root/rivermind-data
nohup ./venv/bin/vllm serve ./models/Qwen2.5-7B-AWQ \
  --port 8000 --host 0.0.0.0 \
  --gpu-memory-utilization 0.90 \
  --max-model-len 4096 --enforce-eager > /root/vllm.log 2>&1 &
# 等加载完成；验证：
curl -s localhost:8000/health
curl -s localhost:8000/metrics | grep gpu_cache_usage_perc   # vllm>=0.7 指标名
```

## 4. 推理冒烟（model 名用 serve 时的原路径）

```bash
curl -s -X POST localhost:8000/v1/completions -H "Content-Type: application/json" \
  -d '{"model":"./models/Qwen2.5-7B-AWQ","prompt":"The capital of France is","max_tokens":20}'
```

## 5. ECS 侧：指标版本兼容 + 隧道 + e2e

### 5.1 observer 指标兼容（本地代码已改并提交）
`VllmResourceObserver.parseVllmMetrics` 现在 `kv_cache_usage_perc` 回退到
`gpu_cache_usage_perc`（vllm>=0.7 改名）。cloned 提交 `fab7c12`。

### 5.2 隧道（GPU 机 → ECS，用 ECS 私钥反连）
```bash
# 把 ECS 私钥传到 GPU 机，chmod 600（/root/ecs.pem）
nohup ssh -i /root/ecs.pem -o StrictHostKeyChecking=no \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -N -R 18000:localhost:8000 ecs-user@47.111.83.126 > /root/tunnel.log 2>&1 &
# ECS 侧验证：
curl -s http://localhost:18000/metrics | grep -E "^vllm:num_requests_running |^vllm:gpu_cache_usage_perc"
```

### 5.3 ECS 端到端（真实 observer）
```bash
# 在 ECS /data/harness/code 同步脚本后：
HARNESS_E2E_DB_PATH=/tmp/gpu-e2e.db bun run scripts/e2e-gpu-pressure.ts
# 采样期间在 GPU 机制造压力：
nohup bash /root/load2.sh 120 1500 > /root/load3.out 2>&1 &   # 120 并发长生成
```
预期：`running≈120 · kv≈62% → pressure=CRITICAL → action=QUEUE → reasonCode=RESOURCE_CRITICAL`
（写进 SQLite）。见 `scripts/e2e-gpu-pressure.ts`（真实 observer，非 Fake）。

## 6. 验收与停止

- 验收：ECS 采样出现 `RESOURCE_CRITICAL/QUEUE` 且由真实 /metrics 驱动。
- 停止省计费：GPU 机 `pkill -f completions`（停压测）；如需省费可停 vllm / 隧道 / 释放实例。
- 诚实边界：strict microVM、显存 MiB 绝对公平份额仍缺对应证据；这是真实 vLLM 压力的真机闭合，不是生产级声明。

## 7. 相关文件
- `scripts/e2e-gpu-pressure.ts`（ECS 端到端采样）
- `scripts/tenant-budget-demo.ts` / `scripts/server-budget-control.ts`（租户预算账本）
- `src/evidence/*`、`src/resources/{vllm-resource-observer,tenant-budget,resource-ledger,budget-aware-policy}.ts`
