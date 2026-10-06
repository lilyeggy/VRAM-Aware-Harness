#!/usr/bin/env bash
# ==============================================================================
# setup-gpu-acl.sh: GPU Service & vLLM ACL Firewall Configuration
#
# Enforces Phase 4 GPU Boundary:
# - vLLM port (default 18000) ONLY accepts traffic from the Harness/LLM Gateway
#   process (matched by process UID or local loopback).
# - Direct connection attempts from microVM tap interfaces or unauthorized
#   users to the vLLM port are REJECTED.
# ==============================================================================
set -euo pipefail

VLLM_PORT="${1:-18000}"
HARNESS_USER="${2:-$(whoami)}"
ACTION="${3:-apply}"

echo "[setup-gpu-acl] Configuring GPU service ACL for vLLM port ${VLLM_PORT} (User: ${HARNESS_USER}, Action: ${ACTION}) ..."

if [[ "${ACTION}" == "teardown" ]]; then
    if command -v nft >/dev/null 2>&1 && [[ "$(uname)" == "Linux" ]] && [[ $EUID -eq 0 ]]; then
        nft delete table inet harness_gpu_acl 2>/dev/null || true
    fi
    echo "[setup-gpu-acl] Teardown complete."
    exit 0
fi

if [[ "$(uname)" != "Linux" ]]; then
    echo "[setup-gpu-acl] Warning: non-Linux OS detected ($(uname)). Simulated GPU ACL setup for vLLM port ${VLLM_PORT}."
    exit 0
fi

if [[ $EUID -ne 0 ]]; then
    echo "[setup-gpu-acl] Warning: non-root execution (EUID=$EUID). Cannot manipulate nftables rules without root."
    exit 0
fi

HARNESS_UID=$(id -u "${HARNESS_USER}")

# Apply nftables table and chain for vLLM port isolation
nft -f - <<EOF
table inet harness_gpu_acl {
    chain input {
        type filter hook input priority -10; policy accept;

        # Inspect connections destined to vLLM port
        tcp dport ${VLLM_PORT} meta skuid ${HARNESS_UID} accept
        tcp dport ${VLLM_PORT} ip saddr 127.0.0.1 meta skuid ${HARNESS_UID} accept

        # Reject all other unauthorized attempts to reach vLLM directly (including VM tap interfaces)
        tcp dport ${VLLM_PORT} log prefix "GPU_ACL_BLOCKED: " counter reject with icmpx type admin-prohibited
    }
}
EOF

echo "[setup-gpu-acl] GPU ACL rules applied successfully. Port ${VLLM_PORT} locked to UID ${HARNESS_UID}."
