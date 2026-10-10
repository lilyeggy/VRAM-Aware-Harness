set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DATA="$ROOT/data/live-broker-flow"
mkdir -p "$DATA/workspaces" "$DATA/vm-runtime"
export HARNESS_DATABASE_PATH="$DATA/harness.sqlite"
export HARNESS_WORKSPACE_ROOT="$DATA/workspaces"
export HARNESS_VM_RUNTIME_ROOT="$DATA/vm-runtime"
export HARNESS_PORT=3100
export HARNESS_BOOTSTRAP_API_KEY=live-flow-key-2026
export HARNESS_SANDBOX_PROVIDER=microvm
export HARNESS_WORKER_ISOLATION=process
export HARNESS_USE_JAILER=false
export HARNESS_VM_SNAPSHOTS_ENABLED=false
export HARNESS_SANDBOX_BROKER_SOCKET=/tmp/harness-sandbox-broker.sock
export HARNESS_SANDBOX_BROKER_CONTROL_TOKEN="${HARNESS_SANDBOX_BROKER_CONTROL_TOKEN:-live-flow-control-2026}"
export FIRECRACKER_BINARY_PATH=/home/cxr/microvm-test/bin/fc117
export FIRECRACKER_KERNEL_PATH=/home/cxr/microvm-test/bin/vmlinux
export FIRECRACKER_ROOTFS_PATH=/home/cxr/microvm-test/images/rootfs.ext4
export FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=/home/cxr/microvm-test/images/workspace-template.ext4
export PI_PROVIDER=opencode-go
export VLLM_MODEL_ID=deepseek-v4.1-flash
export PI_MODELS_PATH=/home/cxr/.pi/agent/models.json
export PI_AUTH_PATH="$DATA/pi-auth.json"
export HARNESS_MICROVM_DRIVER=firecracker
export HARNESS_MODEL_SERVICE_MODE=external
if [ -f "$DATA/server.pid" ]; then kill "$(cat "$DATA/server.pid")" 2>/dev/null || true; fi
rm -f "$DATA/server.log"
setsid /home/cxr/.bun/bin/bun run src/main.ts > "$DATA/server.log" 2>&1 < /dev/null &
echo $! > "$DATA/server.pid"
echo "master(external) started pid $(cat "$DATA/server.pid")"
