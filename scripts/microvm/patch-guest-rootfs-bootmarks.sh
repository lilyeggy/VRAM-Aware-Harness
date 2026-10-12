#!/usr/bin/env bash
# 给"已经存在"的 guest rootfs 打冷启动分段埋点补丁：写入 /etc/boot-mark，并在
# /etc/inittab 的 sysinit 链路上插入 harness-boot 标记。
#
# 为什么需要：宿主侧 [vm-phase] 只能看到两个点——"内核首行"（serial-first-line）
# 与"socat 监听"（vsock-connect-ok）。真机实测这两点之间稳定是 ~1.21s，全在 guest
# 用户态（mount proc/sysfs、mdev -s、tmpfs 挂载、挂载工作区盘、socat 启动），但
# 拆不细。打上本补丁后 guest 会把每个阶段完成时的 /proc/uptime 打到串口
# （配合 HARNESS_VM_SERIAL_LOG_DIR 落盘），即可逐段归因。
#
# 幂等：已打过补丁的镜像直接退出。会先备份 <image>.bak-bootmarks。
# 新镜像请直接用 scripts/microvm/build-guest-rootfs.sh 构建，不需要本脚本。
#
# 用法（root）：bash scripts/microvm/patch-guest-rootfs-bootmarks.sh /data/harness/images/rootfs.ext4
set -euo pipefail

IMAGE="${1:?用法: patch-guest-rootfs-bootmarks.sh <rootfs.ext4>}"
[ -f "$IMAGE" ] || { echo "镜像不存在：$IMAGE" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

debugfs -R "dump /etc/inittab $WORK/inittab" "$IMAGE" >/dev/null 2>&1 \
  || { echo "无法从 $IMAGE 读取 /etc/inittab" >&2; exit 1; }

if grep -q "boot-mark" "$WORK/inittab"; then
    echo "PATCH_BOOTMARKS_SKIP 已经包含启动埋点：$IMAGE"
    exit 0
fi

cp -a "$IMAGE" "$IMAGE.bak-bootmarks"

python3 - "$WORK/inittab" "$WORK/inittab.new" <<'INNERTRANSFORM'
import sys

src, dst = sys.argv[1], sys.argv[2]
known = {
    "::sysinit:/bin/mount -t proc proc /proc",
    "::sysinit:/bin/mount -t sysfs sysfs /sys",
    "::sysinit:/sbin/mdev -s",
    "::sysinit:/bin/mkdir -p /tmp /run /var/tmp",
    "::sysinit:/bin/mount -t tmpfs -o mode=1777,size=64m tmpfs /tmp",
    "::sysinit:/bin/mount -t tmpfs -o mode=755,size=16m tmpfs /run",
    "::sysinit:/bin/mount -t tmpfs -o mode=1777,size=32m tmpfs /var/tmp",
    "::sysinit:/bin/mount -t ext4 -o noatime /dev/vdb /workspace",
    "::respawn:/usr/bin/socat VSOCK-LISTEN:5000,fork EXEC:/agent/main",
    "::ctrlaltdel:/sbin/reboot",
    "::shutdown:/bin/umount -a -r",
}
lines = [line.strip() for line in open(src) if line.strip()]
unknown = [line for line in lines if not line.startswith("#") and line not in known]
if unknown:
    print("inittab 含未知行，拒绝改写（避免覆盖手工定制）：", unknown, file=sys.stderr)
    sys.exit(1)

out = '''::sysinit:/bin/mount -t proc proc /proc
::sysinit:/bin/mount -t sysfs sysfs /sys
::sysinit:/bin/sh /etc/boot-mark proc-sysfs
::sysinit:/sbin/mdev -s
::sysinit:/bin/sh /etc/boot-mark mdev
::sysinit:/bin/mkdir -p /tmp /run /var/tmp
::sysinit:/bin/mount -t tmpfs -o mode=1777,size=64m tmpfs /tmp
::sysinit:/bin/mount -t tmpfs -o mode=755,size=16m tmpfs /run
::sysinit:/bin/mount -t tmpfs -o mode=1777,size=32m tmpfs /var/tmp
::sysinit:/bin/sh /etc/boot-mark tmpfs
::sysinit:/bin/mount -t ext4 -o noatime /dev/vdb /workspace
::sysinit:/bin/sh /etc/boot-mark workspace
::sysinit:/bin/sh /etc/boot-mark before-socat
::respawn:/usr/bin/socat VSOCK-LISTEN:5000,fork EXEC:/agent/main
::ctrlaltdel:/sbin/reboot
::shutdown:/bin/umount -a -r
'''
open(dst, "w").write(out)
INNERTRANSFORM

cat > "$WORK/boot-mark" <<'BOOTMARK'
#!/bin/sh
phase="$1"
up="unknown"
if [ -r /proc/uptime ]; then
    read up _rest < /proc/uptime
fi
echo "harness-boot ${phase} uptime=${up}" > /dev/console 2>/dev/null
exit 0

BOOTMARK

debugfs -w -R "rm /etc/inittab" "$IMAGE" >/dev/null 2>&1
debugfs -w -R "write $WORK/inittab.new /etc/inittab" "$IMAGE" >/dev/null 2>&1
debugfs -w -R "write $WORK/boot-mark /etc/boot-mark" "$IMAGE" >/dev/null 2>&1

debugfs -R "dump /etc/inittab $WORK/verify" "$IMAGE" >/dev/null 2>&1
grep -q "boot-mark" "$WORK/verify" \
  || { echo "补丁校验失败（inittab）：$IMAGE" >&2; exit 1; }
debugfs -R "dump /etc/boot-mark $WORK/verify-mark" "$IMAGE" >/dev/null 2>&1
grep -q "harness-boot" "$WORK/verify-mark" \
  || { echo "补丁校验失败（boot-mark）：$IMAGE" >&2; exit 1; }

echo "PATCH_BOOTMARKS_OK image=$IMAGE backup=$IMAGE.bak-bootmarks"
