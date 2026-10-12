import { chmodSync, existsSync, linkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 驱动自有的共享文件（快照 vm.snap / mem.snap）在 VM 目录内的权限位。
 *
 * 0444 = 只读。Firecracker 官方 snapshot-support.md 明确要求内存文件
 * "must be considered immutable from Firecracker and host point of view"。
 * 注意该常量**只用于驱动自己创建、可随时重建的快照文件**：硬链接与源文件共用
 * inode，chmod 会把源文件的权限一起改掉（真机踩坑：把操作员提供的 rootfs 模板
 * 改成 0444 后，后续走"复制"的路径会继承 0444，降权后的 Firecracker 以 O_RDWR
 * 打开直接 EACCES，整个 VM 起不来）。
 */
export const SHARED_BASE_FILE_MODE = 0o444;

export type ShareBaseFileOutcome = "linked" | "copied" | "already-present";

export interface ShareBaseFileOptions {
    /** 硬链接失败（跨设备 EXDEV / 无权限 EPERM）时的复制兜底，行为与旧路径一致。 */
    readonly fallbackCopy: (src: string, dst: string) => Promise<void>;
    /** 硬链接实现；测试注入以模拟跨设备/无权限。 */
    readonly link?: (src: string, dst: string) => void;
    /**
     * 共享后要设置的权限位；省略则保留源文件/复制得到的权限。
     * 只对驱动自有、可重建的文件（快照）传 SHARED_BASE_FILE_MODE；
     * 操作员提供的模板不要传，否则硬链接会把模板本身的权限改掉。
     */
    readonly mode?: number;
}

/**
 * 以"共享只读"方式把基础文件放进 VM 目录：优先硬链接（同 inode、零拷贝），
 * 失败则退化为复制。
 *
 * 为什么多台 VM 共享同一份内存/磁盘文件是安全的（Firecracker 官方设计）：
 * - 加载快照时 Firecracker 对内存文件做 MAP_PRIVATE 只读映射 + 按需分页，
 *   后续写入走 COW 匿名内存，不会回写文件；
 * - 官方原文允许 "sharing of memory pages and read only disks between
 *   multiple microVMs"，前提是该文件不可变。
 *
 * 因此调用方必须保证：
 * 1. 池内快照的发布是"写 staging + rename"，绝不原地截断正在被映射的文件；
 * 2. 共享进来的 rootfs 必须以只读盘（is_read_only: true）挂给 guest。
 *
 * 权限位由调用方通过 options.mode 决定：模板类文件保持原权限（硬链接与源共用
 * inode，改权限等于改模板），驱动自有的快照文件传 SHARED_BASE_FILE_MODE=0444。
 */
export async function shareBaseFile(
    src: string,
    dst: string,
    options: ShareBaseFileOptions,
): Promise<ShareBaseFileOutcome> {
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    if (existsSync(dst)) {
        return "already-present";
    }
    try {
        (options.link ?? linkSync)(src, dst);
        if (options.mode !== undefined) chmodSync(dst, options.mode);
        return "linked";
    } catch {
        await options.fallbackCopy(src, dst);
        if (options.mode !== undefined) chmodSync(dst, options.mode);
        return "copied";
    }
}
