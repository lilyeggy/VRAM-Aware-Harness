set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DATA="$ROOT/data/live-full-flow"
mkdir -p "$DATA/workspaces" "$DATA/vm-runtime"
export HARNESS_DATABASE_PATH="$DATA/harness.sqlite"
export HARNESS_WORKSPACE_ROOT="$DATA/workspaces"
export HARNESS_VM_RUNTIME_ROOT="$DATA/vm-runtime"
export HARNESS_PORT=3100
export HARNESS_BOOTSTRAP_API_KEY="${HARNESS_BOOTSTRAP_API_KEY:-live-flow-key-2026}"
export HARNESS_SANDBOX_PROVIDER=microvm
export HARNESS_WORKER_ISOLATION="${HARNESS_WORKER_ISOLATION:-in-process}"
export HARNESS_USE_JAILER=false
export HARNESS_VM_SNAPSHOTS_ENABLED=false
export FIRECRACKER_BINARY_PATH=/home/cxr/microvm-test/bin/fc117
export FIRECRACKER_KERNEL_PATH=/home/cxr/microvm-test/bin/vmlinux
export FIRECRACKER_ROOTFS_PATH=/home/cxr/microvm-test/images/rootfs.ext4
export FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=/home/cxr/microvm-test/images/workspace-template.ext4
export PI_PROVIDER=opencode-go
export VLLM_MODEL_ID=deepseek-v4-flash
export PI_MODELS_PATH=/home/cxr/.pi/agent/models.json
export PI_AUTH_PATH=/home/cxr/.pi/agent/auth.json
export HARNESS_MICROVM_DRIVER=firecracker
rm -f "$DATA/server.log"
setsid /home/cxr/.bun/bin/bun run scripts/live-server.ts > "$DATA/server.log" 2>&1 < /dev/null &
echo $! > "$DATA/server.pid"
echo "started pid $(cat "$DATA/server.pid")"
