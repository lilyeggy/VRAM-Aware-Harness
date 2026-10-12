!/usr/bin/env bash
# 给"已经存在"的 guest rootfs 换上仓库内的静态 C agent（guest/agent/agent.c）：
# 写入 /agent/main，并把 /etc/inittab 的 socat respawn 行改成 ::respawn:/agent/main。
#
# 为什么需要：旧镜像用 socat 转发 + 96MB Bun 编译产物。真机 A/B 显示换成约 36KB
# 静态 ELF（自己监听 AF_VSOCK）可省约 230ms 冷启动（539 -> 约 310ms），并让镜像少
# 6.9MB 动态库（libssl/libcrypto/libstdc++/readline/…）。
#
# 幂等：已经直接 respawn /agent/main 的镜像直接退出。会先备份 <image>.bak-cagent。
# 新镜像请直接用 build-guest-rootfs.sh（HARNESS_GUEST_AGENT_IMPL=c，默认 auto 有 cc 即 c）。
#
# 改完必须做的两件事（否则会串到旧 agent）：
#   1. 提升 HARNESS_GUEST_AGENT_VERSION（参与快照模板哈希 computeTemplateHash）
#   2. 清空快照池（旧黄金快照里的 /agent/main 是 socat 版本）
#
# 用法（root）：
#   bash scripts/microvm/patch-guest-rootfs-c-agent.sh /data/harness/images/rootfs.ext4
#   bash scripts/microvm/patch-guest-rootfs-c-agent.sh <image> /path/to/agent-binary
set -euo pipefail

IMAGE="${1:?用法: patch-guest-rootfs-c-agent.sh <rootfs.ext4> [agentBinary]}"
AGENT_BIN_ARG="${2:-}"
[ -f "$IMAGE" ] || { echo "镜像不存在：$IMAGE" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_C_SOURCE="${SCRIPT_DIR}/../../guest/agent/agent.c"

command -v debugfs >/dev/null 2>&1 || { echo "需要 debugfs（e2fsprogs）" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

debugfs -R "dump /etc/inittab $WORK/inittab" "$IMAGE" >/dev/null 2>&1 \
  || { echo "无法从 $IMAGE 读取 /etc/inittab" >&2; exit 1; }

if grep -q '^::respawn:/agent/main$' "$WORK/inittab"; then
    echo "PATCH_C_AGENT_SKIP 已经直接 respawn /agent/main：$IMAGE"
    exit 0
fi

if [ -n "$AGENT_BIN_ARG" ]; then
    AGENT_BIN="$AGENT_BIN_ARG"
else
    CC_BIN="${CC:-cc}"
    command -v "$CC_BIN" >/dev/null 2>&1 || { echo "找不到 C 编译器：CC=$CC_BIN" >&2; exit 1; }
    [ -f "$AGENT_C_SOURCE" ] || { echo "找不到源码：$AGENT_C_SOURCE" >&2; exit 1; }
    echo "[..] 编译 $AGENT_C_SOURCE"
    "$CC_BIN" -O2 -static -Wall -o "$WORK/harness-agent" "$AGENT_C_SOURCE"
    AGENT_BIN="$WORK/harness-agent"
fi
[ -f "$AGENT_BIN" ] || { echo "agent 二进制不存在：$AGENT_BIN" >&2; exit 1; }

# 拒绝改写含未知行的 inittab（与 bootmarks/tmpfs 补丁同一套白名单策略）
python3 - "$WORK/inittab" "$WORK/inittab.new" <<'INNERTRANSFORM'
import sys

src, dst = sys.argv[1], sys.argv[2]
known = {
    "::sysinit:/bin/mount -t proc proc /proc",
    "::sysinit:/bin/mount -t sysfs sysfs /sys",
    "::sysinit:/bin/sh /etc/boot-mark proc-sysfs",
    "::sysinit:/sbin/mdev -s",
    "::sysinit:/bin/sh /etc/boot-mark mdev",
    "::sysinit:/bin/mkdir -p /tmp /run /var/tmp",
    "::sysinit:/bin/mount -t tmpfs -o mode=1777,size=64m tmpfs /tmp",
    "::sysinit:/bin/mount -t tmpfs -o mode=755,size=16m tmpfs /run",
    "::sysinit:/bin/mount -t tmpfs -o mode=1777,size=32m tmpfs /var/tmp",
    "::sysinit:/bin/sh /etc/boot-mark tmpfs",
    "::sysinit:/bin/mount -t ext4 -o noatime /dev/vdb /workspace",
    "::sysinit:/bin/sh /etc/boot-mark workspace",
    "::sysinit:/bin/sh /etc/boot-mark before-socat",
    "::respawn:/usr/bin/socat VSOCK-LISTEN:5000,fork EXEC:/agent/main",
    "::respawn:/agent/main",
    "::ctrlaltdel:/sbin/reboot",
    "::shutdown:/bin/umount -a -r",
}
lines = [line.strip() for line in open(src) if line.strip()]
unknown = [line for line in lines if not line.startswith("#") and line not in known]
if unknown:
    print("inittab 含未知行，拒绝改写（避免覆盖手工定制）：", unknown, file=sys.stderr)
    sys.exit(1)

out = []
for line in lines:
    if line.startswith("::respawn:"):
        out.append("::respawn:/agent/main")
    else:
        out.append(line)
open(dst, "w").write("\n".join(out) + "\n")
INNERTRANSFORM

cp -a "$IMAGE" "$IMAGE.bak-cagent"

debugfs -w -R "rm /etc/inittab" "$IMAGE" >/dev/null 2>&1
debugfs -w -R "write $WORK/inittab.new /etc/inittab" "$IMAGE" >/dev/null 2>&1
debugfs -w -R "rm /agent/main" "$IMAGE" >/dev/null 2>&1 || true
debugfs -w -R "write $AGENT_BIN /agent/main" "$IMAGE" >/dev/null 2>&1
debugfs -w -R "sif /agent/main mode 0100755" "$IMAGE" >/dev/null 2>&1 || true

debugfs -R "dump /etc/inittab $WORK/verify" "$IMAGE" >/dev/null 2>&1
grep -q '^::respawn:/agent/main$' "$WORK/verify" \
  || { echo "补丁校验失败（inittab）：$IMAGE" >&2; exit 1; }
debugfs -R "dump /agent/main $WORK/verify-agent" "$IMAGE" >/dev/null 2>&1
cmp -s "$AGENT_BIN" "$WORK/verify-agent" \
  || { echo "补丁校验失败（/agent/main 内容与源文件不一致）：$IMAGE" >&2; exit 1; }

SIZE="$(stat -c %s "$AGENT_BIN")"
echo "PATCH_C_AGENT_OK image=$IMAGE backup=$IMAGE.bak-cagent agentBytes=$SIZE"
