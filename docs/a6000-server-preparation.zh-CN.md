# RTX A6000 服务器准备与 ModelScope 模型下载任务单

> 本文是交给 **RTX A6000 服务器上的 AI Agent** 执行的任务单，不是在本地开发机执行的教程。
>
> 当前默认任务只包含：环境检查、创建隔离目录、安装独立下载工具、通过 ModelScope 下载并校验 `Qwen3.5-4B` 和 `Qwen3.5-9B`。
>
> 完成“阶段 D”后必须停止。除非用户另行明确授权，不得安装 vLLM、启动模型服务或修改系统配置。

## 0. 给服务器 AI Agent 的执行契约

### 0.1 任务目标

在不影响现有代码开发和服务器任务的前提下：

1. 确认服务器确实使用 NVIDIA RTX A6000 48 GB；
2. 确认内存、磁盘和 GPU 当前状态满足准备条件；
3. 在独立数据目录中创建 Python/ModelScope 下载环境；
4. 只从 ModelScope 下载以下官方 post-trained 模型：
   - `Qwen/Qwen3.5-4B`；
   - `Qwen/Qwen3.5-9B`；
5. 校验模型目录和关键文件；
6. 输出结构化执行报告后停止。

### 0.2 已授权操作

- 执行只读系统检查命令；
- 在用户有写权限的数据盘目录下创建本任务专属目录；
- 在该目录中安装 `uv`、独立 Python 和 ModelScope Python 包；
- 从 `modelscope.cn` 下载两个指定模型；
- 在本任务目录中写入日志、模型文件清单和检查结果；
- 对本任务创建的文件进行断点续传或覆盖同名未完成文件。

### 0.3 未授权操作

服务器 AI Agent **不得**：

- 使用 `sudo`；
- 安装或升级系统 NVIDIA 驱动、CUDA Toolkit、内核或系统 Python；
- 删除任何现有模型、缓存、代码、日志或用户文件；
- 终止、暂停或修改未知 GPU/CPU 进程；
- 修改防火墙、SSH、端口转发、systemd、Docker 或网络配置；
- 克隆或修改 Harness 代码仓库；
- 从 Hugging Face 下载模型；
- 下载 Base、GGUF、AWQ、GPTQ 或任何第三方变体；
- 安装 vLLM、启动模型服务或占用 GPU；
- 因路径权限不足而擅自更改 `/data` 的属主或权限。

### 0.4 必须停止并报告的情况

遇到以下任一情况时停止后续操作，保留现场并向用户报告：

- GPU 不是 `NVIDIA RTX A6000`；
- 没有可写的数据盘路径；
- 目标盘可用空间少于 80 GB；
- 服务器无法访问 `modelscope.cn` 或 Python 包源；
- 安装需要 `sudo` 或修改系统环境；
- ModelScope 上找不到指定的官方 `Qwen/...` 仓库；
- 下载文件完整性校验失败且重试一次后仍失败；
- 发现任何可能覆盖现有非本任务文件的风险；
- 发生本文没有覆盖、且继续执行可能改变服务器现有状态的异常。

### 0.5 执行原则

- 按阶段 A → B → C → D 顺序执行；不得跳过阶段验收。
- 每条命令失败后先判断原因，不得通过扩大权限绕过失败。
- 下载模型不使用 GPU；不要为了下载而占用或清理 GPU。
- 公共 Qwen 模型通常不需要登录，不得向用户索取或输出无必要的 Token。
- 命令中的目录变量只在当前 shell 有效，重新登录后按阶段 B 恢复。
- 阶段 D 完成后输出报告并停止，不自动进入附录中的 vLLM 操作。

## 1. 模型与容量基线

| 用途 | ModelScope 官方模型 ID | 建议上下文 | GPU |
| --- | --- | --- | --- |
| 日常开发、工具调用快速回归 | `Qwen/Qwen3.5-4B` | 16K | 单张 RTX A6000 |
| Day 7 主要集成验证 | `Qwen/Qwen3.5-9B` | 16K | 单张 RTX A6000 |

RTX A6000 具有 48 GB 显存，第一阶段运行上述任一模型的 BF16/FP16 版本即可，不需要多卡或量化版本。下载阶段不加载模型，不占用 GPU 显存。

建议服务器至少具备：

- Linux x86_64；
- NVIDIA RTX A6000 48 GB；
- 64 GB 系统内存，推荐 128 GB；
- 数据盘至少 80 GB 可用空间，推荐预留 150 GB；
- 可访问 ModelScope、PyPI 和 `astral.sh`。

## 2. 阶段 A：只读环境检查

执行：

```bash
set -u

echo '=== SYSTEM ==='
hostname
uname -a

echo '=== GPU ==='
nvidia-smi
nvidia-smi \
  --query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,driver_version \
  --format=csv

echo '=== CPU_AND_MEMORY ==='
nproc
free -h

echo '=== DISKS ==='
df -hT / /data 2>/dev/null || df -hT /

echo '=== PYTHON ==='
python3 --version 2>/dev/null || true

echo '=== NETWORK ==='
curl -I --connect-timeout 10 --max-time 30 https://modelscope.cn 2>/dev/null \
  | head -n 1 || true
curl -I --connect-timeout 10 --max-time 30 https://pypi.org 2>/dev/null \
  | head -n 1 || true
```

阶段 A 验收条件：

- GPU 名称明确包含 `NVIDIA RTX A6000`；
- 目标数据盘可用空间不少于 80 GB；
- 系统内存不少于 64 GB；
- ModelScope 和 Python 包源可访问。

GPU 上存在任务并不阻止模型下载。不得终止这些任务，只需在最终报告中记录 GPU 当前占用。

如果 `/data` 不存在或不可写，停止并要求用户提供本人的数据盘路径。

## 3. 阶段 B：创建隔离目录和下载环境

默认使用 `/data/${USER}/vram-aware-harness`。此路径必须是本任务新建或确认属于当前用户的目录。

```bash
set -euo pipefail

export HARNESS_SERVER_ROOT="/data/${USER}/vram-aware-harness"
export HARNESS_UV_INSTALL_DIR="${HARNESS_SERVER_ROOT}/bin"
export UV_PYTHON_INSTALL_DIR="${HARNESS_SERVER_ROOT}/uv/python"
export UV_CACHE_DIR="${HARNESS_SERVER_ROOT}/uv/cache"
export MODELSCOPE_HOME="${HARNESS_SERVER_ROOT}/modelscope/home"
export MODELSCOPE_CACHE="${HARNESS_SERVER_ROOT}/modelscope/cache"
export MODELSCOPE_DOWNLOAD_MAX_RETRIES=5
export MODELSCOPE_DOWNLOAD_TIMEOUT=120
export HARNESS_MODELS_DIR="${HARNESS_SERVER_ROOT}/models"
export HARNESS_MODEL_4B_DIR="${HARNESS_MODELS_DIR}/Qwen3.5-4B"
export HARNESS_MODEL_9B_DIR="${HARNESS_MODELS_DIR}/Qwen3.5-9B"

mkdir -p \
  "${HARNESS_UV_INSTALL_DIR}" \
  "${UV_PYTHON_INSTALL_DIR}" \
  "${UV_CACHE_DIR}" \
  "${MODELSCOPE_HOME}" \
  "${MODELSCOPE_CACHE}" \
  "${HARNESS_MODELS_DIR}" \
  "${HARNESS_SERVER_ROOT}/venvs" \
  "${HARNESS_SERVER_ROOT}/logs" \
  "${HARNESS_SERVER_ROOT}/reports"

test -w "${HARNESS_SERVER_ROOT}"
df -h "${HARNESS_SERVER_ROOT}"

curl -LsSf https://astral.sh/uv/install.sh \
  | env UV_INSTALL_DIR="${HARNESS_UV_INSTALL_DIR}" sh

export PATH="${HARNESS_UV_INSTALL_DIR}:${PATH}"

uv python install 3.12
uv venv --python 3.12 "${HARNESS_SERVER_ROOT}/venvs/model-download"
source "${HARNESS_SERVER_ROOT}/venvs/model-download/bin/activate"

uv pip install --upgrade modelscope

uv --version
python --version
python - <<'PY'
import modelscope
print("ModelScope:", modelscope.__version__)
PY
modelscope --help >/dev/null
```

阶段 B 验收条件：

- `HARNESS_SERVER_ROOT` 位于数据盘且属于当前用户；
- 独立 Python 环境位于 `venvs/model-download`；
- `modelscope --help` 成功；
- 没有修改系统 Python 或安装全局包。

重新登录服务器后，先恢复环境：

```bash
export HARNESS_SERVER_ROOT="/data/${USER}/vram-aware-harness"
export HARNESS_UV_INSTALL_DIR="${HARNESS_SERVER_ROOT}/bin"
export UV_PYTHON_INSTALL_DIR="${HARNESS_SERVER_ROOT}/uv/python"
export UV_CACHE_DIR="${HARNESS_SERVER_ROOT}/uv/cache"
export MODELSCOPE_HOME="${HARNESS_SERVER_ROOT}/modelscope/home"
export MODELSCOPE_CACHE="${HARNESS_SERVER_ROOT}/modelscope/cache"
export MODELSCOPE_DOWNLOAD_MAX_RETRIES=5
export MODELSCOPE_DOWNLOAD_TIMEOUT=120
export HARNESS_MODELS_DIR="${HARNESS_SERVER_ROOT}/models"
export HARNESS_MODEL_4B_DIR="${HARNESS_MODELS_DIR}/Qwen3.5-4B"
export HARNESS_MODEL_9B_DIR="${HARNESS_MODELS_DIR}/Qwen3.5-9B"
export PATH="${HARNESS_UV_INSTALL_DIR}:${PATH}"
source "${HARNESS_SERVER_ROOT}/venvs/model-download/bin/activate"
```

## 4. 阶段 C：通过 ModelScope 下载官方模型

### 4.1 下载前确认仓库

目标必须严格为：

```text
Qwen/Qwen3.5-4B
Qwen/Qwen3.5-9B
```

不得替换成带 `Base`、`GGUF`、`AWQ`、`GPTQ`、`INT4` 或其他组织名前缀的仓库。

先检查帮助中存在所需参数：

```bash
modelscope download --help
```

确认支持 `--model` 和 `--local_dir` 后继续。

### 4.2 下载 4B

```bash
modelscope download \
  --model "Qwen/Qwen3.5-4B" \
  --local_dir "${HARNESS_MODEL_4B_DIR}" \
  --max-workers 4 \
  2>&1 | tee "${HARNESS_SERVER_ROOT}/logs/modelscope-qwen3.5-4b.log"
```

### 4.3 下载 9B

```bash
modelscope download \
  --model "Qwen/Qwen3.5-9B" \
  --local_dir "${HARNESS_MODEL_9B_DIR}" \
  --max-workers 4 \
  2>&1 | tee "${HARNESS_SERVER_ROOT}/logs/modelscope-qwen3.5-9b.log"
```

注意：

- 两个模型按顺序下载，不要并发下载；
- 不要把模型下载到代码仓库；
- 网络中断后可重试一次相同命令；
- 重试前不要删除目标目录或 ModelScope 缓存；
- 若重试后仍出现完整性错误，停止并报告，不要反复清空重下。

## 5. 阶段 D：校验、记录并停止

### 5.1 校验关键文件

```bash
set -euo pipefail

for model_dir in "${HARNESS_MODEL_4B_DIR}" "${HARNESS_MODEL_9B_DIR}"; do
  echo "=== CHECK ${model_dir} ==="
  test -s "${model_dir}/config.json"
  test -s "${model_dir}/tokenizer_config.json"

  safetensor_count="$(find "${model_dir}" -maxdepth 2 -type f -name '*.safetensors' | wc -l)"
  if [ "${safetensor_count}" -lt 1 ]; then
    echo "ERROR: ${model_dir} 中没有 safetensors 权重文件" >&2
    exit 1
  fi

  echo "safetensors files: ${safetensor_count}"
  du -sh "${model_dir}"
done
```

### 5.2 生成文件清单

文件清单记录相对路径和字节数，不重复读取并计算全部大权重的 SHA256，避免无必要的磁盘 I/O。

```bash
find "${HARNESS_MODEL_4B_DIR}" -type f \
  -printf '%P\t%s\n' | sort \
  > "${HARNESS_SERVER_ROOT}/reports/Qwen3.5-4B-files.tsv"

find "${HARNESS_MODEL_9B_DIR}" -type f \
  -printf '%P\t%s\n' | sort \
  > "${HARNESS_SERVER_ROOT}/reports/Qwen3.5-9B-files.tsv"

sha256sum \
  "${HARNESS_MODEL_4B_DIR}/config.json" \
  "${HARNESS_MODEL_4B_DIR}/tokenizer_config.json" \
  "${HARNESS_MODEL_9B_DIR}/config.json" \
  "${HARNESS_MODEL_9B_DIR}/tokenizer_config.json" \
  > "${HARNESS_SERVER_ROOT}/reports/config-checksums.sha256"

df -h "${HARNESS_SERVER_ROOT}"
```

### 5.3 AI Agent 最终报告格式

服务器 AI Agent 必须按以下格式回复用户，然后停止：

```markdown
## A6000 模型准备结果

- 总体状态：成功 / 部分成功 / 已停止
- 主机名：
- GPU 型号与数量：
- GPU 当前占用：
- 系统内存：
- 数据根目录：
- 下载前可用空间：
- 下载后可用空间：
- ModelScope 版本：
- Qwen3.5-4B：成功/失败，目录，大小
- Qwen3.5-9B：成功/失败，目录，大小
- 文件清单目录：
- 日志目录：
- 警告或异常：
- 是否执行了 vLLM 安装或启动：否
```

阶段 D 完成后，当前任务结束。

---

# 附录：以后获得明确授权后再执行

以下内容不属于当前模型下载任务。服务器 AI Agent 不得自动执行。

## A. 安装 Qwen3.5 兼容的 vLLM

为避免污染下载环境，单独创建 vLLM 虚拟环境：

```bash
export PATH="${HARNESS_UV_INSTALL_DIR}:${PATH}"

uv venv --python 3.12 "${HARNESS_SERVER_ROOT}/venvs/vllm"
source "${HARNESS_SERVER_ROOT}/venvs/vllm/bin/activate"

uv pip install --upgrade vllm \
  --torch-backend=auto \
  --extra-index-url https://wheels.vllm.ai/nightly

python - <<'PY'
import torch
import vllm

print("vLLM:", vllm.__version__)
print("PyTorch:", torch.__version__)
print("PyTorch CUDA runtime:", torch.version.cuda)
print("CUDA available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
    print("Compute capability:", torch.cuda.get_device_capability(0))
PY
```

必须确认 `CUDA available: True`。如果为 `False`，停止，不得通过擅自升级驱动继续。

## B. 启动 4B 开发模型

直接从 ModelScope 已下载的本地目录加载，不再访问 Hugging Face：

```bash
export CUDA_VISIBLE_DEVICES=0
export VLLM_USE_MODELSCOPE=true

vllm serve "${HARNESS_MODEL_4B_DIR}" \
  --served-model-name "qwen3.5-4b" \
  --host 127.0.0.1 \
  --port 8000 \
  --tensor-parallel-size 1 \
  --max-model-len 16384 \
  --gpu-memory-utilization 0.80 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --language-model-only
```

第一次必须在前台启动。默认只绑定 `127.0.0.1`，不得擅自改为公网监听。

## C. 启动 9B 集成验证模型

先正常停止 4B，再启动 9B。第一阶段不要求两个模型同时常驻。

```bash
export CUDA_VISIBLE_DEVICES=0
export VLLM_USE_MODELSCOPE=true

vllm serve "${HARNESS_MODEL_9B_DIR}" \
  --served-model-name "qwen3.5-9b" \
  --host 127.0.0.1 \
  --port 8000 \
  --tensor-parallel-size 1 \
  --max-model-len 16384 \
  --gpu-memory-utilization 0.80 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --language-model-only
```

## D. 服务验收

```bash
curl -sS http://127.0.0.1:8000/v1/models
curl -sS http://127.0.0.1:8000/metrics \
  | grep -E 'vllm:(num_requests_running|num_requests_waiting|kv_cache_usage_perc)' \
  | head
nvidia-smi
```

验证普通对话：

```bash
curl -sS http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "model": "qwen3.5-4b",
  "messages": [
    {"role": "user", "content": "只回复 READY"}
  ],
  "max_tokens": 64,
  "temperature": 0
}
JSON
```

验证工具调用 parser：

```bash
curl -sS http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "model": "qwen3.5-4b",
  "messages": [
    {"role": "user", "content": "请读取 README.md，并告诉我项目名称。必须调用 read_file 工具。"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取文本文件",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {"type": "string"}
          },
          "required": ["path"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "max_tokens": 256,
  "temperature": 0
}
JSON
```

这一请求只验证模型能返回结构化 `tool_calls`；真正读取文件仍由 Pi/Harness 的 ToolGateway 执行。

## E. Harness 连接参数

```text
baseUrl = http://127.0.0.1:8000/v1
metricsUrl = http://127.0.0.1:8000/metrics
modelId = qwen3.5-4b 或 qwen3.5-9b
gpuIds = ["0"]
```

Pi 的 `.pi/spike/models.json` 可使用：

```json
{
  "providers": {
    "local-vllm": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "qwen3.5-4b"
        }
      ]
    }
  }
}
```

## F. 官方参考

- [ModelScope：Qwen/Qwen3.5-4B](https://modelscope.cn/models/Qwen/Qwen3.5-4B/summary)
- [ModelScope：Qwen/Qwen3.5-9B](https://modelscope.cn/models/Qwen/Qwen3.5-9B/summary)
- [ModelScope 官方项目与安装说明](https://github.com/modelscope/modelscope)
- [vLLM GPU 安装文档](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/)
- [vLLM Qwen3 parser 文档](https://docs.vllm.ai/en/latest/api/vllm/parser/qwen3/)

