set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DATA="$ROOT/data/live-broker-flow"
mkdir -p "$DATA/vm-runtime"
export HARNESS_SANDBOX_BROKER_SOCKET=/tmp/harness-sandbox-broker.sock
export HARNESS_SANDBOX_BROKER_CONTROL_TOKEN="${HARNESS_SANDBOX_BROKER_CONTROL_TOKEN:-live-flow-control-2026}"
export HARNESS_VM_RUNTIME_ROOT="$DATA/vm-runtime"
export HARNESS_MICROVM_DRIVER=firecracker
export HARNESS_USE_JAILER=false
export HARNESS_VM_SNAPSHOTS_ENABLED=false
export FIRECRACKER_BINARY_PATH=/home/cxr/microvm-test/bin/fc117
export FIRECRACKER_KERNEL_PATH=/home/cxr/microvm-test/bin/vmlinux
export FIRECRACKER_ROOTFS_PATH=/home/cxr/microvm-test/images/rootfs.ext4
export FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=/home/cxr/microvm-test/images/workspace-template.ext4
if [ -f "$DATA/broker.pid" ]; then kill "$(cat "$DATA/broker.pid")" 2>/dev/null || true; fi
rm -f "$DATA/broker.log" "$HARNESS_SANDBOX_BROKER_SOCKET"
setsid /home/cxr/.bun/bin/bun run src/sandbox/broker/broker-main.ts > "$DATA/broker.log" 2>&1 < /dev/null &
echo $! > "$DATA/broker.pid"
echo "broker started pid $(cat "$DATA/broker.pid")"
