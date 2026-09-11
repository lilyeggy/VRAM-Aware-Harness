import { chownSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Workspace, WorkspaceStore } from "./workspace-store.ts";

/** Maps a tenant-owned opaque ID to a server-controlled host directory. */
export class WorkspaceService {
    private readonly root: string;

    constructor(
        rootPath: string,
        private readonly store: WorkspaceStore,
        private readonly executionUid?: number,
    ) {
        this.root = resolve(rootPath);
    }

    create(tenantId: string, name: string): Workspace {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
            throw new Error("Workspace 名称只能包含字母、数字、_ 或 -，且最长 64 位");
        }
        const id = crypto.randomUUID();
        const workspace: Workspace = {
            id,
            tenantId,
            name,
            rootPath: resolve(this.root, tenantId, id),
            createdAt: new Date().toISOString(),
        };
        // D6：分隔符来自 path.sep（POSIX 为 "/"，Windows 为 "\"），
        // 硬编码 "/" 在 Windows 上会把 `C:\root-evil` 误判为合法前缀。
        if (!workspace.rootPath.startsWith(`${this.root}${sep}`)) {
            throw new Error("非法 Workspace 根目录");
        }
        mkdirSync(workspace.rootPath, { recursive: true, mode: 0o700 });
        if (this.executionUid !== undefined) {
            try {
                // A non-root container UID must own its single bind-mounted root.
                // Failure is safer than creating a Run that can never access its Workspace.
                if (statSync(workspace.rootPath).uid !== this.executionUid) {
                    chownSync(workspace.rootPath, this.executionUid, -1);
                }
            } catch (error) {
                rmSync(workspace.rootPath, { recursive: true, force: true });
                throw new Error(`无法将 Workspace 交给容器 UID ${this.executionUid}: ${String(error)}`);
            }
        }
        this.store.create(workspace);
        return workspace;
    }

    getForTenant(id: string, tenantId: string): Workspace | null {
        return this.store.getForTenant(id, tenantId);
    }

    listForTenant(tenantId: string): Workspace[] {
        return this.store.listForTenant(tenantId);
    }
}
