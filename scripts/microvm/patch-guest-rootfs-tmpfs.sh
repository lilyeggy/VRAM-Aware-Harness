#!/usr/bin/env bash
# 给"已经存在"的 guest rootfs 打补丁：只读 rootfs 下仍可写 tmpfs（/tmp /run /var/tmp）。
# 幂等：已打过补丁的镜像会直接退出。会用 debugfs 原地改 /etc/inittab，并先留备份
# <image>.bak-tmpfs。新镜像请直接用 scripts/microvm/build-guest-rootfs.sh 构建，不需要本脚本。
#
# 用法（root）：bash scripts/microvm/patch-guest-rootfs-tmpfs.sh /data/harness/images/rootfs.ext4
set -euo pipefail

IMAGE="${1:?用法: patch-guest-rootfs-tmpfs.sh <rootfs.ext4>}"
[ -f "$IMAGE" ] || { echo "镜像不存在：$IMAGE" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

debugfs -R "dump /etc/inittab $WORK/inittab" "$IMAGE" >/dev/null 2>&1 \
  || { echo "无法从 $IMAGE 读取 /etc/inittab" >&2; exit 1; }

if grep -q "tmpfs /tmp" "$WORK/inittab"; then
    echo "PATCH_TMPFS_SKIP 已经包含 tmpfs 挂载：$IMAGE"
    exit 0
fi

cp -a "$IMAGE" "$IMAGE.bak-tmpfs"

# 追加在 sysinit 段末尾即可：busybox init 先跑完所有 sysinit 动作，再进入 respawn。
cat >> "$WORK/inittab" <<'INITTAB'

# 只读 rootfs（HARNESS_VM_SHARE_ROOTFS=1）下的可写层：/tmp /run /var/tmp
::sysinit:/bin/mkdir -p /tmp /run /var/tmp
::sysinit:/bin/mount -t tmpfs -o mode=1777,size=64m tmpfs /tmp
::sysinit:/bin/mount -t tmpfs -o mode=755,size=16m tmpfs /run
::sysinit:/bin/mount -t tmpfs -o mode=1777,size=32m tmpfs /var/tmp
INITTAB

debugfs -w -R "rm /etc/inittab" "$IMAGE" >/dev/null 2>&1
debugfs -w -R "write $WORK/inittab /etc/inittab" "$IMAGE" >/dev/null 2>&1

debugfs -R "dump /etc/inittab $WORK/verify" "$IMAGE" >/dev/null 2>&1
grep -q "tmpfs /tmp" "$WORK/verify" \
  || { echo "补丁校验失败：$IMAGE" >&2; exit 1; }

echo "PATCH_TMPFS_OK image=$IMAGE backup=$IMAGE.bak-tmpfs"
