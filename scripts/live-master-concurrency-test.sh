set -euo pipefail
ROOT="${HARNESS_DATA_ROOT:-/data/harness/concurrency-test}"
mkdir -p "$ROOT/workspaces"
export ROOT
export HARNESS_ENV=production
export HARNESS_DATA_ROOT="$ROOT"
export HARNESS_DATABASE_PATH="$ROOT/harness.sqlite"
export HARNESS_WORKSPACE_ROOT="$ROOT/workspaces"
export HARNESS_VM_RUNTIME_ROOT="$ROOT/vm-runtime"
export HARNESS_HOST=127.0.0.1
export HARNESS_PORT=3200
export HARNESS_BOOTSTRAP_API_KEY=concurrency-test-key-2026
export HARNESS_SANDBOX_PROVIDER=microvm
export HARNESS_WORKER_ISOLATION=systemd
export HARNESS_USE_JAILER=true
export HARNESS_VM_SNAPSHOTS_ENABLED=false
export HARNESS_SANDBOX_BROKER_SOCKET=/run/harness/sandbox-broker-test.sock
export HARNESS_SANDBOX_BROKER_CONTROL_TOKEN=concurrency-test-control-2026
export HARNESS_MICROVM_DRIVER=firecracker
export FIRECRACKER_BINARY_PATH=/home/cxr/microvm-test/bin/fc117
export FIRECRACKER_KERNEL_PATH=/home/cxr/microvm-test/bin/vmlinux
export FIRECRACKER_ROOTFS_PATH=/home/cxr/microvm-test/images/rootfs.ext4
export FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=/home/cxr/microvm-test/images/workspace-template.ext4
export HARNESS_WORKER_SYSTEMD_LAUNCHER_PATH=/usr/local/sbin/harness-worker-run
export HARNESS_WORKER_SYSTEMD_SUDO_PATH=/usr/bin/sudo
export HARNESS_WORKER_PI_AUTH_PATH=/var/lib/harness-worker/auth.json
export HARNESS_WORKER_PI_MODELS_PATH=/var/lib/harness-worker/models.json
export PI_PROVIDER=opencode-go
export PI_MODEL_ID=deepseek-v4.1-flash
export VLLM_MODEL_ID=deepseek-v4.1-flash
export PI_MODELS_PATH=/home/cxr/.pi/agent/models.json
export PI_AUTH_PATH=/home/cxr/.pi/agent/auth.json
export HARNESS_REGISTRATION_MODE=invite
export HARNESS_REGISTRATION_INVITE_CODE=concurrency-test-2026
export HARNESS_RATE_LIMIT_ENABLED=false
export HARNESS_MAX_ACTIVE_RUNS=30
export HARNESS_MAX_ACTIVE_RUNS_PER_USER=10
cd /home/cxr/agent-harness-mt
setsid bash -c "echo \$\$ > \"$ROOT/master.pid\"; exec /usr/local/bin/bun run src/main.ts" > "$ROOT/master.log" 2>&1 &
sleep 1
echo "MASTER_STARTED pid=$(cat "$ROOT/master.pid") port=3200"
