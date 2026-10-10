set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DATA="$ROOT/data/live-full-flow"
mkdir -p "$DATA/vm-runtime" "$DATA/workspaces"
export HARNESS_SANDBOX_BROKER_SOCKET=/run/harness/sandbox-broker.sock
export HARNESS_SANDBOX_BROKER_CONTROL_TOKEN="${HARNESS_SANDBOX_BROKER_CONTROL_TOKEN:-live-flow-control-2026}"
export HARNESS_SANDBOX_BROKER_SOCKET_UID=1004
export HARNESS_SANDBOX_BROKER_SOCKET_GID="${HARNESS_SANDBOX_BROKER_SOCKET_GID:-$(getent group harness-worker | cut -d: -f3)}"
export HARNESS_SANDBOX_BROKER_PEER_UIDS="${HARNESS_SANDBOX_BROKER_PEER_UIDS:-1004,998}"
export HARNESS_SANDBOX_BROKER_MASTER_UID="${HARNESS_SANDBOX_BROKER_MASTER_UID:-1004}"
export HARNESS_SANDBOX_BROKER_WORKER_UID="${HARNESS_SANDBOX_BROKER_WORKER_UID:-998}"
export HARNESS_MICROVM_DRIVER=firecracker
export HARNESS_USE_JAILER=true
export HARNESS_VM_SNAPSHOTS_ENABLED=true
export HARNESS_VM_SNAPSHOT_POOL_DIR=/home/cxr/microvm-test/snapshots-mt
export HARNESS_VM_RUNTIME_ROOT="$DATA/vm-runtime"
export FIRECRACKER_BINARY_PATH=/home/cxr/microvm-test/bin/fc117
export FIRECRACKER_JAILER_PATH=/home/cxr/microvm-test/bin/jailer117
export FIRECRACKER_KERNEL_PATH=/home/cxr/microvm-test/bin/vmlinux
export FIRECRACKER_ROOTFS_PATH=/home/cxr/microvm-test/images/rootfs.ext4
export FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=/home/cxr/microvm-test/images/workspace-template.ext4
mkdir -p /run/harness /home/cxr/microvm-test/snapshots-mt
chmod 0755 /run/harness
rm -f "$HARNESS_SANDBOX_BROKER_SOCKET"
if [ -f "$DATA/broker.pid" ]; then kill "$(cat "$DATA/broker.pid")" 2>/dev/null || true; fi
rm -f "$DATA/broker.log"
setsid /home/cxr/.bun/bin/bun run src/sandbox/broker/broker-main.ts > "$DATA/broker.log" 2>&1 < /dev/null &
echo $! > "$DATA/broker.pid"
echo "broker(os-split,jailer,snapshots) started pid $(cat "$DATA/broker.pid")"
