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
  --property="ReadWritePaths=$WORKER_RW_PATHS" \
  --property="RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" \
  --setenv="PATH=$WORKER_PATH" \
  --setenv="HOME=$WORKER_HOME" \
  --setenv=TMPDIR=/tmp \
  --setenv="HARNESS_RUN_ID=$RUN_ID" \
  "$WORKER_BUN" run "$WORKER_SCRIPT"
