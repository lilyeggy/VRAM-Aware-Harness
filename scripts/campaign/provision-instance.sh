#!/usr/bin/env bash
# 为一条测试跑道生成完全隔离的 Harness 实例（目录 + env + 启动脚本）。
#
#   provision-instance.sh <name> <port> [managed-local|container]
#
# 设计约束（对应 docs/scenario-campaign-split-plan.zh-CN.md）：
#   - 绝不复用共享端口 13000（Harness）与 18000（vLLM）；端口被占用直接拒绝
#   - code 只做软链到共享仓库，避免在只剩 ~66G 的根盘上复制代码
#   - 凭证每次随机生成，只写入该实例目录，不进任何仓库
#   - 生成的 env 已按本机部署校准 GPU 阈值（93/98），否则 vLLM 预占 44G 会让 N5 把一切判 CRITICAL
#
# 本脚本只在测试主机上运行：ssh f630@100.65.162.35
set -euo pipefail

NAME="${1:?用法: provision-instance.sh <name> <port> [managed-local|container]}"
PORT="${2:?用法: provision-instance.sh <name> <port> [managed-local|container]}"
PROVIDER="${3:-managed-local}"

DEPLOY=/home/f630/cxr/harness-deploy
VLLM_PORT=18000
SHARED_HARNESS_PORT=13000
DIR="${DEPLOY}/campaign-${NAME}-$(date +%Y%m%d)"

case "${PROVIDER}" in
    managed-local|container) ;;
    *) echo "拒绝：provider 只能是 managed-local 或 container" >&2; exit 2 ;;
esac

if [ "${PORT}" = "${SHARED_HARNESS_PORT}" ] || [ "${PORT}" = "${VLLM_PORT}" ]; then
    echo "拒绝：${PORT} 是共享服务端口，不可用于测试实例" >&2
    exit 3
fi
if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
    echo "拒绝：端口 ${PORT} 已被占用" >&2
    exit 4
fi
if [ -e "${DIR}" ]; then
    echo "拒绝：目录已存在 ${DIR}（改名或先归档）" >&2
    exit 5
fi
if [ ! -d "${DEPLOY}/code" ]; then
    echo "拒绝：找不到共享代码目录 ${DEPLOY}/code" >&2
    exit 6
fi

mkdir -p "${DIR}"/{logs,runtime,evidence,fixtures} "${DIR}/.pi/spike"
ln -s "${DEPLOY}/code" "${DIR}/code"

AGENT_KEY="$(openssl rand -hex 24)"
BOOT_KEY="$(openssl rand -hex 24)"

# Pi 的 baseUrl 指回本实例 Harness 的 /v1（Harness 再把请求转给 vLLM），不能直连 vLLM。
cat > "${DIR}/.pi/spike/models.json" <<JSON
{
  "providers": {
    "local-vllm": {
      "baseUrl": "http://127.0.0.1:${PORT}/v1",
      "api": "openai-completions",
      "apiKey": "${AGENT_KEY}",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": true
      },
      "models": [
        {
          "id": "qwen2.5-7b-instruct",
          "name": "Qwen2.5 7B (A6000 vLLM)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 4096,
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        }
      ]
    }
  }
}
JSON

if [ "${PROVIDER}" = "container" ]; then
    SANDBOX_BLOCK="HARNESS_SANDBOX_PROVIDER=container
HARNESS_SANDBOX_PROFILE=default
HARNESS_SANDBOX_RUNTIME=runsc
HARNESS_CONTAINER_IMAGE=alpine:3.20
HARNESS_CONTAINER_USER_ID=1000
HARNESS_SANDBOX_WARM_POOL_SIZE=2"
else
    SANDBOX_BLOCK="HARNESS_SANDBOX_PROVIDER=managed-local
HARNESS_SANDBOX_PROFILE=development
HARNESS_SANDBOX_RUNTIME=runc"
fi

cat > "${DIR}/campaign.env" <<ENV
# campaign-${NAME} 隔离实例 —— 端口 ${PORT} / provider ${PROVIDER}
# 生成于 $(date -Iseconds)；与共享 13000/18000 及其他 campaign 完全独立。

VLLM_MODEL_ID=qwen2.5-7b-instruct
VLLM_BASE_URL=http://127.0.0.1:${VLLM_PORT}/v1
VLLM_METRICS_URL=http://127.0.0.1:${VLLM_PORT}/metrics
PI_PROVIDER=local-vllm
PI_MODELS_PATH=${DIR}/.pi/spike/models.json

HARNESS_DATABASE_PATH=${DIR}/runtime/harness.sqlite
HARNESS_WORKSPACE_ROOT=${DIR}/runtime/workspaces
HARNESS_HOST=127.0.0.1
HARNESS_PORT=${PORT}
HARNESS_PUMP_INTERVAL_MS=1000

${SANDBOX_BLOCK}

HARNESS_MAX_ACTIVE_RUNS=4
HARNESS_MAX_ACTIVE_RUNS_PER_TENANT=2
HARNESS_QUEUE_TTL_MS=300000
HARNESS_GPU_IDS=0
HARNESS_RESOURCE_TIMEOUT_MS=3000

VLLM_BASE_URLS=http://127.0.0.1:${VLLM_PORT}/v1
LLM_GATEWAY_STRATEGY=round-robin
LLM_HEALTH_PROBE_INTERVAL_MS=10000
LLM_PREFIX_CACHE=1
LLM_STREAM_USAGE_CAPTURE=1

# 本机 vLLM 预分配约 44G/49G（~90%），必须校准，否则默认 70/90 会把实例长期判 CRITICAL（N5）。
HARNESS_BUSY_GPU_MEMORY_PERCENT=93
HARNESS_CRITICAL_GPU_MEMORY_PERCENT=98
HARNESS_BUSY_KV_CACHE_PERCENT=70
HARNESS_CRITICAL_KV_CACHE_PERCENT=90
LLM_REQUEST_TIMEOUT_MS=300000

HARNESS_AGENT_API_KEY=${AGENT_KEY}
HARNESS_BOOTSTRAP_API_KEY=${BOOT_KEY}
ENV
chmod 600 "${DIR}/campaign.env" "${DIR}/.pi/spike/models.json"

cat > "${DIR}/start.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
export PATH=/home/f630/.bun/bin:$PATH
cd "$(dirname "$0")/code"
set -a
source "$(dirname "$0")/campaign.env"
set +a
exec bun run src/main.ts >> "$(dirname "$0")/logs/harness.log" 2>&1
SH
chmod +x "${DIR}/start.sh"

echo "实例已就绪：${DIR}"
echo "  端口        : ${PORT}"
echo "  provider    : ${PROVIDER}"
echo "  DB/工作区   : ${DIR}/runtime/"
echo "  启动        : setsid nohup ${DIR}/start.sh >/dev/null 2>&1 &"
echo "  健康检查    : curl -s http://127.0.0.1:${PORT}/ready"
echo "  凭证        : 只在本目录落地，勿写入仓库或证据文件"
