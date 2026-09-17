import type { Database } from "bun:sqlite";
import type { Conversation, HarnessSession } from "./harness-session.ts";

export class HarnessSessionStore {
    constructor(private readonly db: Database) {}

    create(session: HarnessSession): void {
        const parameters = {
            id: session.id,
            tenantId: session.tenantId,
            workspaceId: session.workspaceId,
            title: session.title,
            runtimeSessionRef: session.runtimeSessionRef,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
        };
        this.db.query<unknown, typeof parameters>(`
            INSERT INTO harness_sessions (
                id, tenant_id, workspace_id, title, runtime_session_ref,
                created_at, updated_at
            ) VALUES (
                $id, $tenantId, $workspaceId, $title, $runtimeSessionRef,
                $createdAt, $updatedAt
            );
        `).run(parameters);
    }

    get(id: string): HarnessSession | null {
        return this.db.query<HarnessSession, { id: string }>(`
            SELECT id, tenant_id AS tenantId,
                workspace_id AS workspaceId, title,
                runtime_session_ref AS runtimeSessionRef,
                created_at AS createdAt, updated_at AS updatedAt
            FROM harness_sessions WHERE id = $id;
        `).get({ id });
    }

    getForTenant(id: string, tenantId: string): Conversation | null {
        return this.db.query<Conversation, { id: string; tenantId: string }>(`
            SELECT id, tenant_id AS tenantId,
                workspace_id AS workspaceId, title,
                created_at AS createdAt, updated_at AS updatedAt
            FROM harness_sessions
            WHERE id = $id AND tenant_id = $tenantId
                AND workspace_id IS NOT NULL AND title IS NOT NULL;
        `).get({ id, tenantId });
    }

    listForWorkspace(tenantId: string, workspaceId: string): Conversation[] {
        return this.db.query<Conversation, { tenantId: string; workspaceId: string }>(`
            SELECT id, tenant_id AS tenantId,
                workspace_id AS workspaceId, title,
                created_at AS createdAt, updated_at AS updatedAt
            FROM harness_sessions
            WHERE tenant_id = $tenantId AND workspace_id = $workspaceId
                AND title IS NOT NULL
            ORDER BY updated_at DESC, rowid DESC;
        `).all({ tenantId, workspaceId });
    }

    update(session: HarnessSession): void {
        const parameters = {
            id: session.id,
            runtimeSessionRef: session.runtimeSessionRef,
            updatedAt: session.updatedAt,
        };
        this.db.query<unknown, typeof parameters>(`
            UPDATE harness_sessions SET
                runtime_session_ref = $runtimeSessionRef,
                updated_at = $updatedAt
            WHERE id = $id;
        `).run(parameters);
    }

    touch(id: string, tenantId: string, updatedAt = new Date().toISOString()): void {
        this.db.query(`
            UPDATE harness_sessions SET updated_at = $updatedAt
            WHERE id = $id AND tenant_id = $tenantId;
        `).run({ id, tenantId, updatedAt });
    }
}
