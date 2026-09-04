import type { Database } from "bun:sqlite";
import type { Conversation } from "./conversation.ts";

export class ConversationStore {
    constructor(private readonly db: Database) {}

    create(conversation: Conversation): void {
        const parameters = { ...conversation };
        this.db.query<unknown, typeof parameters>(`
            INSERT INTO conversations (
                id, tenant_id, workspace_id, title, created_at, updated_at
            ) VALUES ($id, $tenantId, $workspaceId, $title, $createdAt, $updatedAt)
        `).run(parameters);
    }

    getForTenant(id: string, tenantId: string): Conversation | null {
        return this.db.query<Conversation, { id: string; tenantId: string }>(`
            SELECT id, tenant_id AS tenantId, workspace_id AS workspaceId,
                title, created_at AS createdAt, updated_at AS updatedAt
            FROM conversations
            WHERE id = $id AND tenant_id = $tenantId
        `).get({ id, tenantId });
    }

    listForWorkspace(tenantId: string, workspaceId: string): Conversation[] {
        return this.db.query<Conversation, { tenantId: string; workspaceId: string }>(`
            SELECT id, tenant_id AS tenantId, workspace_id AS workspaceId,
                title, created_at AS createdAt, updated_at AS updatedAt
            FROM conversations
            WHERE tenant_id = $tenantId AND workspace_id = $workspaceId
            ORDER BY updated_at DESC, rowid DESC
        `).all({ tenantId, workspaceId });
    }

    touch(id: string, tenantId: string, updatedAt = new Date().toISOString()): void {
        this.db.query(`
            UPDATE conversations SET updated_at = $updatedAt
            WHERE id = $id AND tenant_id = $tenantId
        `).run({ id, tenantId, updatedAt });
    }
}
