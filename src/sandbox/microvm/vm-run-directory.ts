import { mkdirSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve, join } from "node:path";

export interface VmRunDirectory {
    readonly root: string;        // 本 VM 私有目录绝对路径
    socketPath(): string;         // <root>/firecracker.socket
    vsockUdsPath(): string;       // <root>/vsock.sock
    rootfsPath(): string;         // <root>/rootfs.ext4
    workspaceDiskPath(): string;  // <root>/workspace.ext4
    dispose(): Promise<void>;     // 递归删除 root（best-effort，不得抛错）
}

export interface VmRunDirectoryManagerConfig {
    /** 运行根目录。默认：HARNESS_VM_RUNTIME_ROOT 或 /var/lib/harness/vm（需可写） */
    readonly runtimeRoot?: string;
}

export class VmRunDirectoryManager {
    private readonly runtimeRoot: string;

    constructor(config: VmRunDirectoryManagerConfig = {}) {
        this.runtimeRoot = config.runtimeRoot
            ?? process.env.HARNESS_VM_RUNTIME_ROOT
            ?? "/var/lib/harness/vm";
    }

    /** 创建 <runtimeRoot>/<sandboxId>，mode 0700。sandboxId 只允许 [a-zA-Z0-9-]，长度 ≤ 64，否则抛错。 */
    allocate(sandboxId: string): VmRunDirectory {
        if (!/^[a-zA-Z0-9-]{1,64}$/.test(sandboxId)) {
            throw new Error(`Invalid sandboxId for VM run directory: "${sandboxId}"`);
        }
        const root = resolve(this.runtimeRoot, sandboxId);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        chmodSync(root, 0o700);

        return {
            root,
            socketPath: () => join(root, "firecracker.socket"),
            vsockUdsPath: () => join(root, "vsock.sock"),
            rootfsPath: () => join(root, "rootfs.ext4"),
            workspaceDiskPath: () => join(root, "workspace.ext4"),
            // 真机验证修复：rmSync 递归删除 ~800MB 磁盘副本（rootfs+workspace）
            // 会在 ext4 释放盘块时阻塞事件循环 ~100ms，超 Phase 3 抖动门禁；
            // 改为 fs/promises.rm 走线程池。调用方需 await（或显式 fire-and-forget）。
            dispose: async () => {
                try {
                    await rm(root, { recursive: true, force: true });
                } catch {
                    // best-effort, never throw
                }
            },
        };
    }

    /** 供启动协调器调用：列出 runtimeRoot 下所有现存目录名。不存在 runtimeRoot 返回 []。 */
    listOrphans(): string[] {
        if (!existsSync(this.runtimeRoot)) {
            return [];
        }
        try {
            const entries = readdirSync(this.runtimeRoot, { withFileTypes: true });
            return entries.filter((e) => e.isDirectory()).map((e) => e.name);
        } catch {
            return [];
        }
    }

    /** 删除指定 sandboxId 的目录；不存在时静默成功。 */
    async dispose(sandboxId: string): Promise<void> {
        if (!/^[a-zA-Z0-9-]{1,64}$/.test(sandboxId)) {
            return;
        }
        const root = resolve(this.runtimeRoot, sandboxId);
        try {
            await rm(root, { recursive: true, force: true });
        } catch {
            // best-effort, never throw
        }
    }
}
