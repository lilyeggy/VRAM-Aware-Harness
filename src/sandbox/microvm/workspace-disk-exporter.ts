import { existsSync, lstatSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join, dirname } from "node:path";

export interface ExportResult {
    readonly filesWritten: number;
    readonly bytesWritten: number;
    readonly skipped: readonly { path: string; reason: string }[];
}

export function isWithin(parent: string, target: string): boolean {
    const rel = relative(resolve(parent), resolve(target));
    return !rel.startsWith("..") && !isAbsolute(rel);
}

export class WorkspaceDiskExporter {
    /**
     * 从 per-run workspace.ext4 (或工作区临时源) 抽取全部文件写入宿主 workspacePath。
     * 实现：优先 debugfs（无需 root）；备选 loop mount。
     * 【硬约束】目标路径必须经 isWithin 校验落在 workspacePath 内（防路径逃逸）；
     * 符号链接一律跳过并记入 skipped。
     */
    async exportToHost(diskPath: string, workspacePath: string): Promise<ExportResult> {
        if (!existsSync(diskPath)) {
            return { filesWritten: 0, bytesWritten: 0, skipped: [] };
        }

        const absWorkspacePath = resolve(workspacePath);
        mkdirSync(absWorkspacePath, { recursive: true, mode: 0o700 });

        // 如果 diskPath 是目录（测试桩或挂载好的目录）
        if (statSync(diskPath).isDirectory()) {
            return await this.exportFromDirectory(diskPath, absWorkspacePath);
        }

        // 优先检查 debugfs
        const hasDebugfs = await this.checkCommandExists("debugfs");
        if (hasDebugfs) {
            return await this.exportWithDebugfs(diskPath, absWorkspacePath);
        }

        // 备选：尝试挂载 (需要 root)
        const euid = typeof process.geteuid === "function" ? process.geteuid() : -1;
        if (euid === 0) {
            return await this.exportWithMount(diskPath, absWorkspacePath);
        }

        // 两个手段皆不可用时报错
        throw new Error(
            `无法导出工作区磁盘 ${diskPath}：未找到 debugfs 且非 root 用户无法 loop mount。`
            + "请安装 e2fsprogs (sudo apt-get install -y debugfs-tools e2fsprogs)。",
        );
    }

    private async checkCommandExists(cmd: string): Promise<boolean> {
        try {
            const proc = Bun.spawn(["which", cmd], { stdout: "ignore", stderr: "ignore" });
            return (await proc.exited) === 0;
        } catch {
            return false;
        }
    }

    /** 使用 debugfs rdump 导出，随后做安全审计与符号链接清理 */
    private async exportWithDebugfs(diskPath: string, workspacePath: string): Promise<ExportResult> {
        const tempDumpDir = resolve(workspacePath, `.tmp-dump-${Date.now()}`);
        mkdirSync(tempDumpDir, { recursive: true, mode: 0o700 });

        try {
            // debugfs -R "rdump / <tempDumpDir>" <diskPath>
            const proc = Bun.spawn(["debugfs", "-R", `rdump / ${tempDumpDir}`, diskPath], {
                stdout: "pipe",
                stderr: "pipe",
            });
            await proc.exited;

            // 真机验证修复：必须 await——此前 `return this.exportFromDirectory(...)`
            // 不等待 Promise 结算，finally 的 rmSync 会在异步扫描进行中
            // 删掉 tempDumpDir，大文件场景下 readFile 必现 ENOENT。
            return await this.exportFromDirectory(tempDumpDir, workspacePath);
        } finally {
            try {
                const { rm } = await import("node:fs/promises");
                await rm(tempDumpDir, { recursive: true, force: true });
            } catch {}
        }
    }

    /** 使用 loop mount 导出 */
    private async exportWithMount(diskPath: string, workspacePath: string): Promise<ExportResult> {
        const mntDir = resolve(workspacePath, `.tmp-mnt-${Date.now()}`);
        mkdirSync(mntDir, { recursive: true, mode: 0o700 });

        try {
            const mountProc = Bun.spawn(["mount", "-o", "loop,ro", diskPath, mntDir]);
            const mountExit = await mountProc.exited;
            if (mountExit !== 0) {
                throw new Error(`Failed to mount ${diskPath} to ${mntDir}`);
            }

            try {
                return await this.exportFromDirectory(mntDir, workspacePath);
            } finally {
                const umountProc = Bun.spawn(["umount", mntDir]);
                await umountProc.exited;
            }
        } finally {
            try {
                const { rmSync } = await import("node:fs");
                rmSync(mntDir, { recursive: true, force: true });
            } catch {}
        }
    }

    /** 核心安全拷贝与审计方法：校验 isWithin 并跳过符号链接 (异步化，避免阻塞事件循环) */
    private async exportFromDirectory(
        srcDir: string,
        destWorkspacePath: string,
    ): Promise<ExportResult> {
        const skipped: { path: string; reason: string }[] = [];
        let filesWritten = 0;
        let bytesWritten = 0;

        const scan = async (currentSrc: string, relPath: string): Promise<void> => {
            const entries = readdirSync(currentSrc, { withFileTypes: true });
            for (const entry of entries) {
                const itemSrc = join(currentSrc, entry.name);
                const itemRel = join(relPath, entry.name);
                const itemDest = resolve(destWorkspacePath, itemRel);

                // 1. isWithin 校验 (防 ../ 逃逸)
                if (!isWithin(destWorkspacePath, itemDest)) {
                    skipped.push({ path: itemRel, reason: "path escapes workspace directory" });
                    continue;
                }

                // 2. 符号链接校验 (严格跳过)
                const lstat = lstatSync(itemSrc);
                if (lstat.isSymbolicLink()) {
                    skipped.push({ path: itemRel, reason: "symbolic link skipped for security" });
                    continue;
                }

                // 3. 忽略 lost+found
                if (entry.name === "lost+found") {
                    continue;
                }

                if (entry.isDirectory()) {
                    mkdirSync(itemDest, { recursive: true, mode: 0o700 });
                    await scan(itemSrc, itemRel);
                } else if (entry.isFile()) {
                    mkdirSync(dirname(itemDest), { recursive: true, mode: 0o700 });
                    // 真机验证修复：readFile+writeFile 会把整个文件读成一个
                    // 大 Buffer（500MB 产物导致 GC 抖动 ~91ms，超事件循环门禁）。
                    // copyFile 走 libuv 线程池流式拷贝，不占事件循环、不爆内存。
                    await copyFile(itemSrc, itemDest);
                    filesWritten++;
                    bytesWritten += statSync(itemDest).size;
                }
            }
        };

        await scan(srcDir, "");
        return { filesWritten, bytesWritten, skipped };
    }
}
