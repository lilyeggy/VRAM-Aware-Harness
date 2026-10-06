#!/usr/bin/env bash
# 用法: build-guest-rootfs.sh <agentBinary> <outputRootfs.ext4> <outputWorkspaceTemplate.ext4>
# 依赖: mkfs.ext4、debugfs 或挂载权限。禁止 sudo 交互——检测不到权限直接退出码 2。
set -euo pipefail

# 步骤说明：
# 1. 下载 Alpine minirootfs (版本固定为 3.20.3 x86_64，校验 sha256)
# 2. 创建 256MB ext4 rootfs 镜像 (dd + mkfs.ext4)
# 3. 解包 Alpine、写入 /agent/main 并 chmod 755，准备 socat
# 4. 写入 /etc/inittab 启动 agent
# 5. 创建 64MB (或 HARNESS_VM_WORKSPACE_DISK_MIB 指定大小) 空白 ext4 作为 workspace 模板
# 6. 输出结果路径并做基本自检

ALPINE_VERSION="3.20.3"
ALPINE_TAR="alpine-minirootfs-${ALPINE_VERSION}-x86_64.tar.gz"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/${ALPINE_TAR}"
# Alpine 3.20.3 x86_64 official sha256（以官方 .sha256 文件为准；
# Alpine 曾重发 3.20.3 minirootfs，旧值 7c493c... 已失效，真机验证时发现并修正）
ALPINE_SHA256="d4e6fd67dcf75e40c451560ac7265166c2b72a0f38ddc9aae756a7de3d1efa0c"

if [ "$#" -lt 3 ]; then
    echo "Usage: $0 <agentBinary> <outputRootfs.ext4> <outputWorkspaceTemplate.ext4>" >&2
    exit 2
fi

AGENT_BIN="$1"
OUT_ROOTFS="$2"
OUT_WORKSPACE="$3"

# 真机验证修复：后续 debugfs 写入在 ( cd ROOT_STAGING ) 子壳内执行，
# 相对路径会在那里失效并导致“静默构建出空镜像”。此处一律转为绝对路径。
abspath() {
    case "$1" in
        /*) printf '%s\n' "$1" ;;
        *)  printf '%s/%s\n' "$(pwd)" "$1" ;;
    esac
}
AGENT_BIN="$(abspath "${AGENT_BIN}")"
OUT_ROOTFS="$(abspath "${OUT_ROOTFS}")"
OUT_WORKSPACE="$(abspath "${OUT_WORKSPACE}")"

if [ ! -f "${AGENT_BIN}" ]; then
    echo "Error: agent binary '${AGENT_BIN}' not found!" >&2
    exit 2
fi

if ! command -v mkfs.ext4 >/dev/null 2>&1; then
    echo "Error: mkfs.ext4 command not found. Please install e2fsprogs." >&2
    exit 2
fi

WORKDIR=$(mktemp -d /tmp/build-rootfs.XXXXXX)
trap 'rm -rf "${WORKDIR}"' EXIT

mkdir -p "$(dirname "${OUT_ROOTFS}")"
mkdir -p "$(dirname "${OUT_WORKSPACE}")"

# 1. 下载并校验 Alpine minirootfs
CACHED_TAR="/tmp/${ALPINE_TAR}"
if [ ! -f "${CACHED_TAR}" ]; then
    echo "Downloading ${ALPINE_TAR}..."
    curl -fsSL -o "${CACHED_TAR}" "${ALPINE_URL}"
fi

ACTUAL_SHA256=$(sha256sum "${CACHED_TAR}" 2>/dev/null | awk '{print $1}' || shasum -a 256 "${CACHED_TAR}" | awk '{print $1}')
if [ "${ACTUAL_SHA256}" != "${ALPINE_SHA256}" ]; then
    echo "Error: Checksum mismatch for ${ALPINE_TAR}. Expected ${ALPINE_SHA256}, got ${ACTUAL_SHA256}" >&2
    exit 2
fi

# 2. 解包到临时目录并组织根文件系统
ROOT_STAGING="${WORKDIR}/rootfs_staging"
mkdir -p "${ROOT_STAGING}"
tar -xzf "${CACHED_TAR}" -C "${ROOT_STAGING}"

mkdir -p "${ROOT_STAGING}/agent"
mkdir -p "${ROOT_STAGING}/workspace"
cp "${AGENT_BIN}" "${ROOT_STAGING}/agent/main"
chmod 755 "${ROOT_STAGING}/agent/main"

# 2.1 安装 socat（vsock 桥接必需）：Alpine minirootfs 不含 socat。
# 不依赖宿主 apk 工具：直接解析 APKINDEX 定位版本、下载 .apk（tar.gz）解包进 staging。
ALPINE_REPO="https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64"
APKINDEX="${WORKDIR}/APKINDEX"
# 仓库现仅提供 APKINDEX.tar.gz（含签名），不再有 APKINDEX.gz——真机验证时发现并修正
curl -fsSL "${ALPINE_REPO}/APKINDEX.tar.gz" -o "${WORKDIR}/APKINDEX.tar.gz"
tar -xzf "${WORKDIR}/APKINDEX.tar.gz" -C "${WORKDIR}" APKINDEX

fetch_apk() {
    local pkg="$1"
    # APKINDEX 按空行分隔 stanza；取 P:<pkg> 段的 V:<version>
    local ver
    ver=$(awk -v pkg="P:${pkg}" '
        BEGIN { RS=""; FS="\n" }
        {
            p=""; v=""
            for (i=1; i<=NF; i++) {
                if ($i ~ /^P:/) p=$i
                if ($i ~ /^V:/) v=substr($i, 3)
            }
            if (p == pkg) { print v; exit }
        }' "${APKINDEX}")
    if [ -z "${ver}" ]; then
        echo "Error: package '${pkg}' not found in APKINDEX" >&2
        exit 2
    fi
    local file="${pkg}-${ver}.apk"
    echo "Fetching ${file}..."
    curl -fsSL -o "${WORKDIR}/${file}" "${ALPINE_REPO}/${file}"
    # .apk 即 gzip tar；data 段解进 staging
    tar -xzf "${WORKDIR}/${file}" -C "${ROOT_STAGING}" 2>/dev/null || true
}

# socat 运行时依赖（musl 已在 minirootfs 内）
fetch_apk "socat"
fetch_apk "libcrypto3"
fetch_apk "libssl3"
fetch_apk "readline"
fetch_apk "libncursesw"
fetch_apk "ncurses-terminfo-base"

# 真机验证修复：bun --compile 的 musl 产物仍动态依赖 C++ 运行时
# （_Unwind_SetGR/_ZSt4cerr 等），Alpine minirootfs 不含，
# 缺了会在 guest 内 Error relocating、agent 以 127 退出。
fetch_apk "libstdc++"
fetch_apk "libgcc"

# bash：agent 平台执行的命令常用 bash -c；minirootfs 只有 busybox ash。
# 依赖 readline/ncurses-terminfo-base 已在上方安装。
fetch_apk "bash"

if [ ! -x "${ROOT_STAGING}/usr/bin/socat" ]; then
    echo "Error: socat was not installed into staging rootfs." >&2
    exit 2
fi
echo "[OK] socat installed into rootfs staging"

# 写入 /etc/inittab
# 注意：工作区盘（Firecracker 第二块盘 = /dev/vdb）必须在 guest 内挂载到 /workspace，
# 否则 agent 的 cwd=/workspace 落在 rootfs 副本上，产物无法随工作区盘导出。
# /proc 与 /sys 也必须显式挂载（busybox init 不会自动挂），
# 否则 mdev 报错、cat /proc/1/cmdline 等诊断命令全部失败（真机验证发现）。
cat << 'EOF' > "${ROOT_STAGING}/etc/inittab"
::sysinit:/bin/mount -t proc proc /proc
::sysinit:/bin/mount -t sysfs sysfs /sys
::sysinit:/sbin/mdev -s
::sysinit:/bin/mount -t ext4 -o noatime /dev/vdb /workspace
::respawn:/usr/bin/socat VSOCK-LISTEN:5000,fork EXEC:/agent/main
::ctrlaltdel:/sbin/reboot
::shutdown:/bin/umount -a -r
EOF

# 写入 DNS 与 hosts 基础配置
echo "nameserver 1.1.1.1" > "${ROOT_STAGING}/etc/resolv.conf"
echo "127.0.0.1 localhost" > "${ROOT_STAGING}/etc/hosts"

# 3. 创建 256MB rootfs 镜像并写入
echo "Creating 256MB ext4 rootfs..."
rm -f "${OUT_ROOTFS}"
dd if=/dev/zero of="${OUT_ROOTFS}" bs=1M count=256 status=none
mkfs.ext4 -F -q -L "rootfs" "${OUT_ROOTFS}"

# 尝试 loop mount 或 debugfs / e2tools
HAS_MOUNT_PERM=0
if [ "$(id -u)" -eq 0 ]; then
    HAS_MOUNT_PERM=1
fi

MNT_DIR="${WORKDIR}/mnt"
mkdir -p "${MNT_DIR}"

if [ "${HAS_MOUNT_PERM}" -eq 1 ] && mount -o loop "${OUT_ROOTFS}" "${MNT_DIR}" 2>/dev/null; then
    echo "Populating rootfs via loop mount..."
    cp -a "${ROOT_STAGING}/." "${MNT_DIR}/"
    umount "${MNT_DIR}"
else
    echo "Falling back to debugfs / e2fs population..."
    if command -v debugfs >/dev/null 2>&1; then
        # 递归使用 debugfs 写入目录与文件
        (
            cd "${ROOT_STAGING}"
            find . -type d | while read -r d; do
                [ "$d" = "." ] && continue
                debugfs -w -R "mkdir ${d#./}" "${OUT_ROOTFS}" 2>/dev/null || true
            done
            find . -type f | while read -r f; do
                debugfs -w -R "write ${f} ${f#./}" "${OUT_ROOTFS}" 2>/dev/null || true
            done
            # 真机验证修复：Alpine 的 /sbin/init、/bin/sh 等几乎全部是
            # 指向 busybox 的符号链接；此前只处理 d/f 导致 guest 内核
            # 找不到 init 直接 panic。debugfs 语法：symlink <链接路径> <目标>。
            find . -type l | while read -r l; do
                target=$(readlink "${l}")
                debugfs -w -R "symlink ${l#./} ${target}" "${OUT_ROOTFS}" 2>/dev/null || true
            done
        )
    else
        echo "Error: neither loop mount nor debugfs is available." >&2
        exit 2
    fi
fi

# 4. 创建可配置大小的空白 workspace ext4 模板 (默认 512MB)
WORKSPACE_MIB="${HARNESS_VM_WORKSPACE_DISK_MIB:-512}"
echo "Creating ${WORKSPACE_MIB}MB ext4 workspace template..."
rm -f "${OUT_WORKSPACE}"
dd if=/dev/zero of="${OUT_WORKSPACE}" bs=1M count="${WORKSPACE_MIB}" status=none
mkfs.ext4 -F -q -L "workspace" "${OUT_WORKSPACE}"

# 5. 基本自检
if command -v debugfs >/dev/null 2>&1; then
    echo "Verifying rootfs with debugfs..."
    if debugfs -R "ls /agent" "${OUT_ROOTFS}" 2>/dev/null | grep -q "main"; then
        echo "[OK] /agent/main exists in rootfs"
    else
        echo "Error: /agent/main missing from built rootfs — refusing to ship an empty image." >&2
        exit 2
    fi
    if ! debugfs -R "ls /usr/bin" "${OUT_ROOTFS}" 2>/dev/null | grep -q "socat"; then
        echo "Error: socat missing from built rootfs." >&2
        exit 2
    fi
    if ! debugfs -R "stat /sbin/init" "${OUT_ROOTFS}" 2>/dev/null | grep -q "Type: symlink\|Type: regular"; then
        echo "Error: /sbin/init missing from built rootfs (symlink population failed?)." >&2
        exit 2
    fi
fi

echo "Successfully built:"
echo "Rootfs: ${OUT_ROOTFS}"
echo "Workspace Template: ${OUT_WORKSPACE}"
