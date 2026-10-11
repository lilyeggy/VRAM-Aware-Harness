#!/bin/sh
set -eu

CONFIG=/etc/harness/worker-launcher.conf
if [ ! -f "$CONFIG" ]; then
  echo "harness-worker-run: missing $CONFIG" >&2
  exit 78
fi
. "$CONFIG"

STOP=0
UNIT_NAME=""
RUN_ID=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --unit-name) UNIT_NAME="$2"; shift 2 ;;
    --stop) STOP=1; shift ;;
    *) echo "harness-worker-run: unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [ -n "$UNIT_NAME" ]; then
  case "$UNIT_NAME" in
    harness-worker-*) ;;
    *) echo "harness-worker-run: unit name must start with harness-worker-" >&2; exit 64 ;;
  esac
fi

if [ "$STOP" = "1" ]; then
  if [ -z "$UNIT_NAME" ]; then
    echo "harness-worker-run: --stop requires --unit-name" >&2
    exit 64
  fi
  exec /usr/bin/systemctl stop "$UNIT_NAME"
fi

if [ -z "$RUN_ID" ]; then
  echo "harness-worker-run: --run-id required" >&2
  exit 64
fi
if [ -z "$UNIT_NAME" ]; then
  UNIT_NAME="${UNIT_PREFIX:-harness-worker}-$RUN_ID"
fi

# 控制面 egress ACL（§9.7 v1.3 第 3 项）：
# 默认只允许 loopback（DNS stub 在 127.0.0.53）；要访问外部模型服务时，
# 必须在 /etc/harness/worker-launcher.conf 用 WORKER_EGRESS_ALLOW 显式放行（IPv4 与 IPv6 CIDR 均可，
# 双栈同时启用；模型服务若只有 IPv6 可达，需放行其 IPv6 前缀）
# 模型服务 CIDR（例如 opencode.ai 的 Cloudflare 段 172.64.0.0/13）。
EGRESS_ALLOW_RAW="${WORKER_EGRESS_ALLOW:-127.0.0.0/8}"
EGRESS_ALLOW="$(printf '%s' "$EGRESS_ALLOW_RAW" | tr ',' ' ')"

exec /usr/bin/systemd-run \
  --quiet \
  --collect \
  --pipe \
  --wait \
  --unit="$UNIT_NAME" \
  --uid="$WORKER_USER" \
  --gid="$WORKER_GROUP" \
  --working-directory="$WORKER_CWD" \
  --property="MemoryMax=$WORKER_MEMORY_MAX" \
  --property="CPUQuota=$WORKER_CPU_QUOTA" \
  --property="TasksMax=$WORKER_TASKS_MAX" \
  --property=NoNewPrivileges=yes \
  --property=PrivateTmp=yes \
  --property=ProtectSystem=strict \
  --property=ProtectHome=read-only \
  --property=PrivateDevices=yes \
  --property=ProtectKernelTunables=yes \
  --property=ProtectKernelModules=yes \
  --property=ProtectControlGroups=yes \
  --property=ProtectClock=yes \
  --property=ProtectHostname=yes \
  --property=ProtectProc=invisible \
  --property=ProcSubset=pid \
  --property=RestrictRealtime=yes \
  --property=RestrictSUIDSGID=yes \
  --property=RemoveIPC=yes \
  --property=LockPersonality=yes \
  --property=IPAddressDeny=any \
  --property="IPAddressAllow=$EGRESS_ALLOW" \
  --property="SystemCallFilter=@system-service landlock_create_ruleset landlock_add_rule landlock_restrict_self" \
  --property=SystemCallErrorNumber=EPERM \
  --property="ReadWritePaths=$WORKER_RW_PATHS" \
  --property="RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" \
  --setenv="PATH=$WORKER_PATH" \
  --setenv="HOME=$WORKER_HOME" \
  --setenv=TMPDIR=/tmp \
  --setenv="HARNESS_RUN_ID=$RUN_ID" \
  --setenv=HARNESS_WORKER_LANDLOCK=required \
  --setenv="HARNESS_WORKER_LANDLOCK_WRITABLE_PATHS=$WORKER_RW_PATHS" \
  "$WORKER_BUN" run "$WORKER_SCRIPT"
