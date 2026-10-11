set -euo pipefail
ROOT="${HARNESS_DATA_ROOT:-/data/harness/concurrency-test}"
SOCKET="${HARNESS_SANDBOX_BROKER_SOCKET:-/run/harness/sandbox-broker-test.sock}"
TOKEN="${HARNESS_SANDBOX_BROKER_CONTROL_TOKEN:-concurrency-test-control-2026}"
mkdir -p "$ROOT"
export ROOT
export HARNESS_SANDBOX_BROKER_SOCKET="$SOCKET"
export HARNESS_SANDBOX_BROKER_CONTROL_TOKEN="$TOKEN"
export HARNESS_SANDBOX_BROKER_SOCKET_UID=1004
export HARNESS_SANDBOX_BROKER_SOCKET_GID=998
export HARNESS_SANDBOX_BROKER_PEER_UIDS=1004,998
export HARNESS_SANDBOX_BROKER_MASTER_UID=1004
export HARNESS_SANDBOX_BROKER_WORKER_UID=998
export HARNESS_MICROVM_DRIVER=firecracker
export HARNESS_USE_JAILER=true
export HARNESS_VM_SNAPSHOTS_ENABLED=true
export HARNESS_VM_SNAPSHOT_POOL_DIR="$ROOT/snapshots"
export HARNESS_VM_RUNTIME_ROOT="$ROOT/vm-runtime"
export FIRECRACKER_BINARY_PATH=/home/cxr/microvm-test/bin/fc117
export FIRECRACKER_JAILER_PATH=/home/cxr/microvm-test/bin/jailer117
export FIRECRACKER_KERNEL_PATH=/home/cxr/microvm-test/bin/vmlinux
export FIRECRACKER_ROOTFS_PATH=/home/cxr/microvm-test/images/rootfs.ext4
export FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=/home/cxr/microvm-test/images/workspace-template.ext4
cd /home/cxr/agent-harness-mt
setsid bash -c "echo \$\$ > \"$ROOT/broker.pid\"; exec /usr/local/bin/bun run src/sandbox/broker/broker-main.ts" > "$ROOT/broker.log" 2>&1 &
sleep 1
echo "BROKER_STARTED pid=$(cat "$ROOT/broker.pid") socket=$SOCKET"
