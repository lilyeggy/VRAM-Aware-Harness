#!/usr/bin/env bash
set -u
ROOT=/home/cxr/agent-harness-mt
DATA=/data/harness/fullcoverage-test
BUN=/home/cxr/.bun/bin/bun
SOCKDIR=/run/harness-fullcov
SOCKET="$SOCKDIR/sandbox-broker-test.sock"
BASE_URL=http://127.0.0.1:3210

log() { echo "[phases $(date +%H:%M:%S)] $*"; }

start_broker() {
  mkdir -p "$SOCKDIR"
  chown cxr:cxr "$SOCKDIR"
  chmod 755 "$SOCKDIR"
  cd "$ROOT"
  setsid nohup env \
    HARNESS_SANDBOX_BROKER_SOCKET="$SOCKET" \
    HARNESS_SANDBOX_BROKER_CONTROL_TOKEN=fullcov-control \
    HARNESS_SANDBOX_BROKER_SOCKET_UID=1004 \
    HARNESS_SANDBOX_BROKER_SOCKET_GID=1004 \
    HARNESS_SANDBOX_BROKER_PEER_UIDS=1004 \
    HARNESS_SANDBOX_BROKER_MASTER_UID=1004 \
    HARNESS_SANDBOX_BROKER_WORKER_UID=1004 \
    HARNESS_MICROVM_DRIVER=firecracker \
    HARNESS_USE_JAILER=true \
    HARNESS_VM_SNAPSHOTS_ENABLED=true \
    HARNESS_VM_SNAPSHOT_POOL_DIR="$DATA/pool" \
    HARNESS_VM_RUNTIME_ROOT="$DATA/runtime" \
    FIRECRACKER_BINARY_PATH=/home/cxr/microvm-test/bin/fc117 \
    FIRECRACKER_JAILER_PATH=/home/cxr/microvm-test/bin/jailer117 \
    FIRECRACKER_KERNEL_PATH=/data/harness/images/vmlinux \
    FIRECRACKER_ROOTFS_PATH=/data/harness/images/rootfs.ext4 \
    FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=/data/harness/images/workspace-template.ext4 \
    HARNESS_VM_SHARE_ROOTFS=1 \
    HARNESS_GUEST_AGENT_VERSION=2.0.0 \
    "$BUN" run src/sandbox/broker/broker-main.ts > "$DATA/broker.log" 2>&1 &
  for _ in $(seq 1 100); do [ -S "$SOCKET" ] && break; sleep 0.2; done
  if [ -S "$SOCKET" ]; then log "BROKER_UP socket=$SOCKET"; else log "BROKER_DOWN"; return 1; fi
}

stop_master() {
  for pid in $(pgrep -u cxr -f "src/main.ts" || true); do
    if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -q "^HARNESS_PORT=3210$"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
}

start_master() {
  local phase="$1"; shift
  cd "$ROOT"
  setsid nohup runuser -u cxr -- env \
    HARNESS_DATA_ROOT="$DATA/data" \
    HARNESS_DATABASE_PATH="$DATA/data/harness.sqlite" \
    HARNESS_WORKSPACE_ROOT="$DATA/data/workspaces" \
    HARNESS_VM_RUNTIME_ROOT="$DATA/data/vm-runtime" \
    HARNESS_HOST=127.0.0.1 \
    HARNESS_PORT=3210 \
    HARNESS_BOOTSTRAP_API_KEY=fullcov-key-2026 \
    HARNESS_SANDBOX_PROVIDER=microvm \
    HARNESS_WORKER_ISOLATION=in-process \
    HARNESS_USE_JAILER=true \
    HARNESS_VM_SNAPSHOTS_ENABLED=true \
    HARNESS_SANDBOX_BROKER_SOCKET="$SOCKET" \
    HARNESS_SANDBOX_BROKER_CONTROL_TOKEN=fullcov-control \
    HARNESS_MICROVM_DRIVER=firecracker \
    FIRECRACKER_BINARY_PATH=/home/cxr/microvm-test/bin/fc117 \
    FIRECRACKER_JAILER_PATH=/home/cxr/microvm-test/bin/jailer117 \
    FIRECRACKER_KERNEL_PATH=/data/harness/images/vmlinux \
    FIRECRACKER_ROOTFS_PATH=/data/harness/images/rootfs.ext4 \
    FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=/data/harness/images/workspace-template.ext4 \
    PI_PROVIDER=opencode-go \
    PI_MODEL_ID=deepseek-v4.1-flash \
    VLLM_MODEL_ID=deepseek-v4.1-flash \
    PI_MODELS_PATH=/home/cxr/.pi/agent/models.json \
    PI_AUTH_PATH=/home/cxr/.pi/agent/auth.json \
    HARNESS_REGISTRATION_MODE=invite \
    HARNESS_REGISTRATION_INVITE_CODE=fullcov-2026 \
    "$@" \
    "$BUN" run src/main.ts > "$DATA/master-$phase.log" 2>&1 &
  for _ in $(seq 1 150); do
    if curl -fsS "$BASE_URL/health" > /dev/null 2>&1; then log "MASTER_UP phase=$phase"; return 0; fi
    sleep 0.4
  done
  log "MASTER_DOWN phase=$phase"
  return 1
}

run_matrix() {
  local phase="$1"; shift
  local out="$DATA/report-$phase.json"
  cd "$ROOT"
  env HARNESS_BASE_URL="$BASE_URL" \
    HARNESS_API_KEY=fullcov-key-2026 \
    HARNESS_BOOTSTRAP_API_KEY=fullcov-key-2026 \
    HARNESS_FULLCOVER_INVITE=fullcov-2026 \
    HARNESS_FULLCOVER_OUT="$out" \
    "$@" \
    "$BUN" run scripts/full-coverage-smoke.ts > "$DATA/phase-$phase.log" 2>&1
  log "$(tail -3 "$DATA/phase-$phase.log" | tr '\n' ' ')"
  python3 - "$out" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception as exc:
    print("REPORT_UNREADABLE", exc); raise SystemExit(0)
items = data if isinstance(data, list) else data.get("results", [])
counts = {}
for item in items:
    counts[item.get("status")] = counts.get(item.get("status"), 0) + 1
print("COUNTS", counts)
for item in items:
    if item.get("status") == "FAIL":
        print("  FAIL", item.get("id"), "::", str(item.get("detail"))[:160])
PY
}

phase_base() {
  stop_master
  start_master base || return 1
  run_matrix base
}

phase_backpressure() {
  stop_master
  start_master backpressure HARNESS_MAX_ACTIVE_RUNS=1 HARNESS_MAX_ACTIVE_RUNS_PER_TENANT=1 HARNESS_MAX_QUEUED_RUNS=1 || return 1
  run_matrix backpressure FULLCOVER_BACKPRESSURE=1 FULLCOVER_ONLY=run.backpressure
}

phase_ratelimit() {
  stop_master
  start_master ratelimit HARNESS_RATE_LIMIT_MAX_PER_IP=2 HARNESS_RATE_LIMIT_WINDOW_MS=30000 || return 1
  # SKIP_BOOTSTRAP：脚本自己的注册/登录也会撞 429，必须只跑限流这一步。
  run_matrix ratelimit FULLCOVER_RATELIMIT=1 FULLCOVER_ONLY=system.ratelimit FULLCOVER_SKIP_BOOTSTRAP=1
}

phase_mcp() {
  stop_master
  start_master mcp 'HARNESS_MCP_SERVERS=[{"name":"echo","command":"/home/cxr/.bun/bin/bun","args":["run","/home/cxr/agent-harness-mt/tests/mcp/fixtures/echo-mcp-server.ts"],"requestTimeoutMs":5000}]' || return 1
  run_matrix mcp FULLCOVER_MCP=1 FULLCOVER_ONLY=mcp.echo
}

main() {
  log "START"
  start_broker || { log "ABORT broker"; exit 1; }
  for p in ${PHASES:-base backpressure ratelimit mcp}; do
    log "PHASE $p begin"
    "phase_$p" || log "PHASE $p ERROR"
    log "PHASE $p end"
  done
  stop_master
  log "ALL_DONE"
}

main "$@"
