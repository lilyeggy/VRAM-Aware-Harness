#!/usr/bin/env bash
# 跑道 D（跨会话长稳）开跑门禁。只读检查，**不发任何负载**。
#
# 用法：
#   bash runway-d-gate.sh --lambda-star 0.42 --instance-env <campaign.env> [--require-r07]
#
# 退出码：0 = GO（可 setsid 起 soak）；2 = NO-GO（门禁未过）；64 = 参数错误。
# 设计为 fail-closed：任一硬门禁缺失即 NO-GO，绝不"带着未知量开跑"。
set -uo pipefail

BASE_URL="${HARNESS_BASE_URL:-http://127.0.0.1:13010}"
METRICS_URL="${VLLM_METRICS_URL:-http://127.0.0.1:18000/metrics}"
LAMBDA_STAR="${LAMBDA_STAR:-}"
INSTANCE_ENV=""
REQUIRE_R07=0
SAMPLES=3
SAMPLE_GAP=2
ROOT_REDLINE_GB=20      # 根盘余量红线（低于此值直接 NO-GO）
DISK_WARN_PCT=97        # 根盘占用告警线（本机已知基线就是 97%，只告警不拦）

usage() {
  sed -n '2,9p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url)      BASE_URL="$2"; shift 2;;
    --metrics-url)   METRICS_URL="$2"; shift 2;;
    --lambda-star)   LAMBDA_STAR="$2"; shift 2;;
    --instance-env)  INSTANCE_ENV="$2"; shift 2;;
    --require-r07)   REQUIRE_R07=1; shift;;
    --samples)       SAMPLES="$2"; shift 2;;
    -h|--help)       usage; exit 0;;
    *) echo "未知参数：$1"; usage; exit 64;;
  esac
done

fail=0
ok()   { echo "  [OK]   $*"; }
bad()  { echo "  [FAIL] $*"; fail=1; }
warn() { echo "  [WARN] $*"; }

echo "== 跑道 D 开跑门禁 @ $(date -Is) =="
echo "   base=$BASE_URL metrics=$METRICS_URL require_r07=$REQUIRE_R07"

# ---- 1. λ* 必须存在且为正 -------------------------------------------------
echo "[1] λ* 门禁（必须由跑道 A 的 A3「稳定吞吐 ≥30min」产出）"
if [ -z "$LAMBDA_STAR" ]; then
  bad "未提供 λ*：A3 未产出或未交接 → 不许开跑"
elif ! awk -v v="$LAMBDA_STAR" 'BEGIN{exit !(v>0)}' 2>/dev/null; then
  bad "λ* 不是正数：'$LAMBDA_STAR' → 不许开跑"
else
  ok "λ* = $LAMBDA_STAR 任务/s；0.7λ* 目标 = $(awk "BEGIN{printf \"%.4f\", $LAMBDA_STAR*0.7}") 任务/s"
fi

# ---- 2. 共享 vLLM 必须静默（= 没有别的负载源在打） ------------------------
echo "[2] 共享 vLLM 静默检查（采样 ${SAMPLES}×${SAMPLE_GAP}s）"
max_run=0; max_wait=0; kv=0; got=0
for _ in $(seq 1 "$SAMPLES"); do
  m="$(curl -s -m 5 "$METRICS_URL" 2>/dev/null || true)"
  if [ -z "$m" ]; then
    bad "vLLM metrics 取不到（$METRICS_URL）"
    break
  fi
  got=1
  r="$(awk '/^vllm:num_requests_running\{/{print $2; exit}' <<<"$m")"
  w="$(awk '/^vllm:num_requests_waiting\{/{print $2; exit}' <<<"$m")"
  k="$(awk '/^vllm:gpu_cache_usage_perc\{/{print $2; exit}' <<<"$m")"
  r="${r%%.*}"; w="${w%%.*}"; k="${k%%.*}"
  [ "${r:-0}" -gt "$max_run" ] 2>/dev/null && max_run="$r"
  [ "${w:-0}" -gt "$max_wait" ] 2>/dev/null && max_wait="$w"
  [ "${k:-0}" -gt "$kv" ] 2>/dev/null && kv="$k"
  sleep "$SAMPLE_GAP"
done
if [ "$got" = 1 ]; then
  if [ "$max_run" -eq 0 ] && [ "$max_wait" -eq 0 ]; then
    ok "vLLM running/waiting 峰值 = 0/0，KV 峰值 ${kv}% → 未见其它负载源"
  else
    bad "vLLM 有活动：running峰=$max_run waiting峰=$max_wait → 有别的负载在跑，D 不许开跑（约束 2：容量/长稳串行）"
  fi
fi

# ---- 3. 不允许别的发压器进程 ----------------------------------------------
echo "[3] 其它发压器进程检查"
others="$(pgrep -fa 'load-driver\.ts' 2>/dev/null | grep -v "runway-d-gate" || true)"
if [ -n "$others" ]; then
  bad "发现其它 load-driver 进程："
  sed 's/^/         /' <<<"$others"
else
  ok "无其它 load-driver 进程"
fi

# ---- 4. 目标实例 /ready ---------------------------------------------------
echo "[4] 目标实例就绪（$BASE_URL/ready）"
ready="$(curl -s -m 5 "$BASE_URL/ready" 2>/dev/null || true)"
if grep -q '"ready":true' <<<"$ready"; then
  ok "$BASE_URL 就绪：$ready"
else
  bad "$BASE_URL 未就绪：${ready:-<无响应>}"
fi

# ---- 5. 资源红线（根盘：本机最紧） ----------------------------------------
echo "[5] 磁盘红线"
root_line="$(df -BG --output=avail,pcent / 2>/dev/null | tail -1 || true)"
root_avail="$(awk '{gsub(/G/,"",$1); print $1}' <<<"$root_line")"
root_pct="$(awk '{gsub(/%/,"",$2); print $2}' <<<"$root_line")"
if [ -n "${root_avail:-}" ] && [ "$root_avail" -lt "$ROOT_REDLINE_GB" ] 2>/dev/null; then
  bad "根盘余量 ${root_avail}G < ${ROOT_REDLINE_GB}G 红线（Artifact/DB 增长会先吃掉根盘）"
elif [ -n "${root_pct:-}" ] && [ "$root_pct" -ge "$DISK_WARN_PCT" ] 2>/dev/null; then
  warn "根盘占用 ${root_pct}%（本机已知基线≈97%），余 ${root_avail}G — 长稳期间须每 5min df 盯住；大文件写 homePLUS"
else
  ok "根盘占用 ${root_pct:-?}%，余 ${root_avail:-?}G"
fi
for m in /home/f630/homePLUS; do
  [ -d "$m" ] && ok "$m 余 $(df -h --output=avail "$m" | tail -1 | tr -d ' ')"
done

# ---- 6. R07/T8-60min 的执行超时（默认 30min 必挂） -------------------------
if [ "$REQUIRE_R07" = 1 ]; then
  echo "[6] R07 执行超时（必须 ≥75min）"
  if [ -z "$INSTANCE_ENV" ] || [ ! -f "$INSTANCE_ENV" ]; then
    bad "需要 --instance-env <campaign.env> 才能核实 HARNESS_EXECUTION_TIMEOUT_MS"
  else
    val="$(grep -E '^HARNESS_EXECUTION_TIMEOUT_MS=' "$INSTANCE_ENV" | tail -1 | cut -d= -f2)"
    if [ -z "$val" ]; then
      bad "实例 env 未设 HARNESS_EXECUTION_TIMEOUT_MS（默认 30min=1800000）→ 60min T8 必被强杀"
    elif [ "$val" -lt 4500000 ] 2>/dev/null; then
      bad "HARNESS_EXECUTION_TIMEOUT_MS=$val < 4500000(75min) → 60min T8 必被强杀"
    else
      ok "HARNESS_EXECUTION_TIMEOUT_MS=$val ≥ 75min"
    fi
    # 单工具超时单独核实：worker-tool-gateway 的 10s 只是治理 IPC 往返，不是工具执行上限
    echo "  [info] 单工具超时：src/worker/worker-tool-gateway.ts:149 timeoutMs 默认 10s 且未接 env；"
    echo "         它是治理握手 fail-closed 超时，不限制 bash 执行时长；bash 时长只受 executionTimeoutMs 约束。"
  fi
fi

echo
if [ "$fail" = 0 ]; then
  echo "== 门禁结果：GO =="
  exit 0
else
  echo "== 门禁结果：NO-GO（不发任何负载）=="
  exit 2
fi
