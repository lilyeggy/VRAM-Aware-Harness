import type { Database } from "bun:sqlite";

export interface Workspace {
    readonly id: string;
    readonly userId: string;
    readonly name: string;
    readonly rootPath: string;
    readonly createdAt: string;
}

export class WorkspaceStore {
    constructor(private readonly db: Database) {}

    create(workspace: Workspace): void {
        this.db.query<unknown, {
            id: string; userId: string; name: string; rootPath: string; createdAt: string;
        }>(`
            INSERT INTO workspaces (id, user_id, name, root_path, created_at)
            VALUES ($id, $userId, $name, $rootPath, $createdAt);
        `).run(workspace);
    }

    getForUser(id: string, userId: string): Workspace | null {
        return this.db.query<Workspace, { id: string; userId: string }>(`
            SELECT id, user_id AS userId, name, root_path AS rootPath,
                created_at AS createdAt
            FROM workspaces WHERE id = $id AND user_id = $userId;
        `).get({ id, userId });
    }

    listForUser(userId: string): Workspace[] {
        return this.db.query<Workspace, { userId: string }>(`
            SELECT id, user_id AS userId, name, root_path AS rootPath,
                created_at AS createdAt
            FROM workspaces WHERE user_id = $userId ORDER BY created_at ASC;
        `).all({ userId });
    }
}
