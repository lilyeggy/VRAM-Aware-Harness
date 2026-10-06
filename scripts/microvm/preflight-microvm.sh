#!/usr/bin/env bash
set -euo pipefail

echo "=== MicroVM Preflight Check ==="

ERRORS=0

# 1. Check KVM
if [ -e "/dev/kvm" ]; then
    if [ -r "/dev/kvm" ] && [ -w "/dev/kvm" ]; then
        echo "[OK] /dev/kvm is accessible (rw)"
    else
        echo "[FAIL] /dev/kvm exists but current user lacks rw permissions (run: sudo usermod -aG kvm \$USER)"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "[FAIL] /dev/kvm does not exist (hardware virtualization not enabled or nested virt disabled)"
    ERRORS=$((ERRORS + 1))
fi

# 2. Check jailer & firecracker
JAILER_BIN="${FIRECRACKER_JAILER_PATH:-jailer}"
FIRECRACKER_BIN="${FIRECRACKER_BINARY_PATH:-firecracker}"

if command -v "${JAILER_BIN}" >/dev/null 2>&1; then
    echo "[OK] jailer binary found: $(command -v "${JAILER_BIN}")"
elif [ -x "${JAILER_BIN}" ]; then
    echo "[OK] jailer binary found at: ${JAILER_BIN}"
else
    echo "[WARN] jailer binary not found at '${JAILER_BIN}'"
    # In some smoke environments jailer might not be globally in PATH
fi

if command -v "${FIRECRACKER_BIN}" >/dev/null 2>&1; then
    echo "[OK] firecracker binary found: $(command -v "${FIRECRACKER_BIN}")"
elif [ -x "${FIRECRACKER_BIN}" ]; then
    echo "[OK] firecracker binary found at: ${FIRECRACKER_BIN}"
else
    echo "[FAIL] firecracker binary not found at '${FIRECRACKER_BIN}'"
    ERRORS=$((ERRORS + 1))
fi

# 3. 快照能力探测（仅在启用快照时）
# 关键事实：Firecracker 官方**从未**提供 `InstancePause`/`InstanceResume` 动作。
# v1.16 / v1.17 的 swagger 中 InstanceActionInfo 枚举只有
# FlushMetrics / InstanceStart / SendCtrlAltDel，因此用
# `grep InstancePause` 探测必然失败（假阴性），会误导运维去自行编译。
# 暂停/恢复的唯一官方途径是 `PATCH /vm {"state":"Paused"|"Resumed"}`。
# 正确探测信号：二进制里应包含 VcpuResponse::Paused / VcpuResponse::Resumed
# 符号（官方 release 已编译该特性）。
if [ "${HARNESS_VM_SNAPSHOTS_ENABLED:-false}" = "true" ]; then
    FC_ABS=""
    if command -v "${FIRECRACKER_BIN}" >/dev/null 2>&1; then
        FC_ABS="$(command -v "${FIRECRACKER_BIN}")"
    elif [ -x "${FIRECRACKER_BIN}" ]; then
        FC_ABS="${FIRECRACKER_BIN}"
    fi
    if [ -n "${FC_ABS}" ] && grep -a -q "VcpuResponse::Paused" "${FC_ABS}" 2>/dev/null; then
        echo "[OK] Firecracker 支持 pause/resume（PATCH /vm），可启用快照加速"
    else
        echo "[FAIL] 当前 Firecracker 二进制缺少 pause/resume 符号（VcpuResponse::Paused）。"
        echo "       快照加速需要 PATCH /vm {\"state\":\"Paused\"} 支持。"
        echo "       可改用预热池（HARNESS_MICROVM_WARM_POOL_SIZE）实现启动加速。"
        ERRORS=$((ERRORS + 1))
    fi
fi

# 4. Check vhost_vsock
if [ -e "/dev/vhost-vsock" ] || lsmod 2>/dev/null | grep -q "vhost_vsock"; then
    echo "[OK] vhost_vsock kernel module / device present"
else
    echo "[WARN] /dev/vhost-vsock not found. Try running: sudo modprobe vhost_vsock"
fi

# 4. Check images if set
if [ -n "${FIRECRACKER_KERNEL_PATH:-}" ]; then
    if [ -f "${FIRECRACKER_KERNEL_PATH}" ]; then
        echo "[OK] Kernel image found: ${FIRECRACKER_KERNEL_PATH}"
    else
        echo "[FAIL] Kernel image missing: ${FIRECRACKER_KERNEL_PATH}"
        ERRORS=$((ERRORS + 1))
    fi
fi

if [ -n "${FIRECRACKER_ROOTFS_PATH:-}" ]; then
    if [ -f "${FIRECRACKER_ROOTFS_PATH}" ]; then
        echo "[OK] Rootfs image found: ${FIRECRACKER_ROOTFS_PATH}"
    else
        echo "[FAIL] Rootfs image missing: ${FIRECRACKER_ROOTFS_PATH}"
        ERRORS=$((ERRORS + 1))
    fi
fi

if [ ${ERRORS} -gt 0 ]; then
    echo "=== Preflight FAILED with ${ERRORS} error(s) ==="
    exit 1
fi

echo "=== Preflight PASSED ==="
exit 0
