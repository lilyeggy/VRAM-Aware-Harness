import { resolve, sep } from "node:path";

/**
 * 路径围栏：path 是否等于 root 或位于 root 之内。
 *
 * 统一各模块原先手写的 `startsWith(root + sep)` 判断：
 * - 分隔符来自 path.sep（POSIX 为 "/"，Windows 为 "\"），硬编码 "/"
 *   在 Windows 上会把 `C:\root-evil` 误判为合法前缀；
 * - 先 resolve 再比较，避免 `..` 绕过。
 */
export function isWithin(path: string, root: string): boolean {
    const resolvedPath = resolve(path);
    const resolvedRoot = resolve(root);
    return resolvedPath === resolvedRoot
        || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}
