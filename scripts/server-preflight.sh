#!/usr/bin/env bash
set -u

# Read-only deployment gate. It may run a small alpine container to prove the
# configured Docker runtime; it never installs packages or changes system state.

HARNESS_SERVER_ROOT="${HARNESS_SERVER_ROOT:-/data/${USER:-harness}/vram-aware-harness}"
HARNESS_CONTAINER_USER_ID="${HARNESS_CONTAINER_USER_ID:-$(id -u 2>/dev/null || echo 0)}"
failures=0
warnings=0

pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; failures=$((failures + 1)); }
warn() { printf '[WARN] %s\n' "$*"; warnings=$((warnings + 1)); }
info() { printf '[INFO] %s\n' "$*"; }

printf '%s\n' '=== VRAM-Aware Harness server preflight ==='
printf 'server root: %s\n' "$HARNESS_SERVER_ROOT"
printf 'container uid: %s\n' "$HARNESS_CONTAINER_USER_ID"

if [ "$(uname -s 2>/dev/null || true)" = "Linux" ]; then
  pass "Linux host"
else
  fail "需要 Linux host；当前不是 Linux"
fi

arch="$(uname -m 2>/dev/null || true)"
if [ "$arch" = "x86_64" ]; then
  pass "x86_64 architecture"
elif [ "$arch" = "aarch64" ]; then
  warn "aarch64 architecture；当前 A6000/vLLM/Kata/Firecracker 目标验收建议使用 x86_64"
else
  fail "不支持的架构：${arch}"
fi

if command -v nproc >/dev/null 2>&1; then
  cores="$(nproc)"
  if [ "$cores" -ge 8 ]; then pass "CPU cores: ${cores}"; else warn "CPU cores: ${cores}，低于推荐的 8 vCPU"; fi
else
  warn "没有 nproc，无法检查 CPU 核数"
fi

if command -v free >/dev/null 2>&1; then
  memory_mib="$(free -m | awk '/^Mem:/{print $2}')"
  if [ "${memory_mib:-0}" -ge 16384 ]; then pass "memory: ${memory_mib} MiB"; else warn "memory: ${memory_mib:-unknown} MiB，建议至少 16 GiB"; fi
else
  warn "没有 free，无法检查内存"
fi

root_for_disk="$HARNESS_SERVER_ROOT"
if [ ! -d "$root_for_disk" ]; then root_for_disk="$(dirname "$root_for_disk")"; fi
if [ -d "$root_for_disk" ] && command -v df >/dev/null 2>&1; then
  available_kib="$(df -Pk "$root_for_disk" | awk 'NR==2 {print $4}')"
  available_gib=$(( ${available_kib:-0} / 1024 / 1024 ))
  if [ "$available_gib" -ge 30 ]; then
    pass "disk available: ${available_gib} GiB at ${root_for_disk}"
  else
    fail "磁盘可用空间只有 ${available_gib} GiB，至少需要 30 GiB"
  fi
else
  fail "找不到可检查的服务器数据目录：${root_for_disk}"
fi

if [ "${HARNESS_CONTAINER_USER_ID}" -gt 0 ] 2>/dev/null; then
  pass "non-root container UID: ${HARNESS_CONTAINER_USER_ID}"
else
  fail "HARNESS_CONTAINER_USER_ID 必须是正整数，不能使用 root"
fi
current_uid="$(id -u 2>/dev/null || echo 0)"
if [ "$current_uid" = "$HARNESS_CONTAINER_USER_ID" ]; then
  pass "service UID matches container UID: ${current_uid}"
elif [ "$current_uid" = "0" ]; then
  warn "preflight 以 root 执行；部署时仍建议使用非 root harness 用户，并让其 UID 与容器 UID 一致"
else
  fail "当前服务 UID ${current_uid} 与 HARNESS_CONTAINER_USER_ID ${HARNESS_CONTAINER_USER_ID} 不一致；Workspace 0700 权属可能失败"
fi

if command -v docker >/dev/null 2>&1; then
  pass "Docker CLI: $(docker --version 2>/dev/null || true)"
else
  fail "没有 Docker CLI"
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/tmp/harness-docker-info.$$ 2>&1; then
    pass "Docker daemon reachable"
    if grep -qiE 'Cgroup Version: *2|Cgroup.*v2' /tmp/harness-docker-info.$$; then
      pass "Docker cgroups v2"
    else
      warn "没有从 docker info 确认 cgroups v2；请人工检查"
    fi
    runtime_json="$(docker info --format '{{json .Runtimes}}' 2>/dev/null || true)"
    if printf '%s' "$runtime_json" | grep -q 'runsc'; then
      pass "Docker runsc runtime registered"
    else
      fail "Docker daemon 没有注册 runsc runtime"
    fi
  else
    fail "Docker daemon 不可连接"
  fi
  rm -f /tmp/harness-docker-info.$$
fi

if command -v runsc >/dev/null 2>&1; then
  pass "runsc executable: $(runsc --version 2>/dev/null | head -n 1 || true)"
else
  warn "宿主 PATH 没有 runsc；如果 Docker daemon 已注册 runtime，请人工确认 daemon 使用的 runsc 路径"
fi

if [ -e /dev/kvm ]; then
  pass "/dev/kvm available (Kata/Firecracker candidate possible)"
else
  warn "/dev/kvm 不存在；runc/runsc 仍可验证，但不能做真实 Kata/Firecracker 验收"
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet docker 2>/dev/null; then pass "Docker systemd service active"; else warn "Docker systemd service 未报告 active"; fi
fi

if command -v bun >/dev/null 2>&1; then
  pass "Bun: $(bun --version 2>/dev/null || true)"
else
  fail "没有 Bun；部署 Harness 前需要安装 Bun"
fi

if [ -d "$HARNESS_SERVER_ROOT" ]; then
  if [ -w "$HARNESS_SERVER_ROOT" ]; then pass "server root writable"; else fail "server root 不可写：$HARNESS_SERVER_ROOT"; fi
else
  if [ -w "$(dirname "$HARNESS_SERVER_ROOT")" ]; then
    pass "server root parent writable; service can create it"
  else
    fail "server root 及其 parent 不可写：$HARNESS_SERVER_ROOT"
  fi
fi

# This is the only mutating check: Docker creates/removes its own temporary
# container and does not touch the Harness Workspace.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker run --rm --runtime runsc alpine:3.20 true >/tmp/harness-runsc-smoke.$$ 2>&1; then
    pass "real docker + runsc smoke"
  else
    fail "docker --runtime runsc smoke failed"
    sed -n '1,20p' /tmp/harness-runsc-smoke.$$ >&2
  fi
  rm -f /tmp/harness-runsc-smoke.$$
fi

printf '\n=== RESULT ===\n'
printf 'failures: %s\nwarnings: %s\n' "$failures" "$warnings"
if [ "$failures" -eq 0 ]; then
  printf 'RESULT: PASS\n'
  exit 0
fi
printf 'RESULT: FAIL\n'
exit 1
