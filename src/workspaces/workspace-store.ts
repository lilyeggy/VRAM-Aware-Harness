import type { Database } from "bun:sqlite";

export interface Workspace {
    readonly id: string;
    readonly tenantId: string;
    readonly name: string;
    readonly rootPath: string;
    readonly createdAt: string;
}

export class WorkspaceStore {
    constructor(private readonly db: Database) {}

    create(workspace: Workspace): void {
        this.db.query<unknown, {
            id: string; tenantId: string; name: string; rootPath: string; createdAt: string;
        }>(`
            INSERT INTO workspaces (id, tenant_id, name, root_path, created_at)
            VALUES ($id, $tenantId, $name, $rootPath, $createdAt);
        `).run(workspace);
    }

    getForTenant(id: string, tenantId: string): Workspace | null {
        return this.db.query<Workspace, { id: string; tenantId: string }>(`
            SELECT id, tenant_id AS tenantId, name, root_path AS rootPath,
                created_at AS createdAt
            FROM workspaces WHERE id = $id AND tenant_id = $tenantId;
        `).get({ id, tenantId });
    }

    listForTenant(tenantId: string): Workspace[] {
        return this.db.query<Workspace, { tenantId: string }>(`
            SELECT id, tenant_id AS tenantId, name, root_path AS rootPath,
                created_at AS createdAt
            FROM workspaces WHERE tenant_id = $tenantId ORDER BY created_at ASC;
        `).all({ tenantId });
    }
}
