import type { Database } from "bun:sqlite";
import type { Conversation, HarnessSession } from "./harness-session.ts";

export class HarnessSessionStore {
    constructor(private readonly db: Database) {}

    create(session: HarnessSession): void {
        const parameters = {
            id: session.id,
            userId: session.userId,
            workspaceId: session.workspaceId,
            title: session.title,
            runtimeSessionRef: session.runtimeSessionRef,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
        };
        this.db.query<unknown, typeof parameters>(`
            INSERT INTO harness_sessions (
                id, user_id, workspace_id, title, runtime_session_ref,
                created_at, updated_at
            ) VALUES (
                $id, $userId, $workspaceId, $title, $runtimeSessionRef,
                $createdAt, $updatedAt
            );
        `).run(parameters);
    }

    get(id: string): HarnessSession | null {
        return this.db.query<HarnessSession, { id: string }>(`
            SELECT id, user_id AS userId,
                workspace_id AS workspaceId, title,
                runtime_session_ref AS runtimeSessionRef,
                created_at AS createdAt, updated_at AS updatedAt
            FROM harness_sessions WHERE id = $id;
        `).get({ id });
    }

    getForUser(id: string, userId: string): Conversation | null {
        return this.db.query<Conversation, { id: string; userId: string }>(`
            SELECT id, user_id AS userId,
                workspace_id AS workspaceId, title,
                created_at AS createdAt, updated_at AS updatedAt
            FROM harness_sessions
            WHERE id = $id AND user_id = $userId
                AND workspace_id IS NOT NULL AND title IS NOT NULL;
        `).get({ id, userId });
    }

    listForWorkspace(userId: string, workspaceId: string): Conversation[] {
        return this.db.query<Conversation, { userId: string; workspaceId: string }>(`
            SELECT id, user_id AS userId,
                workspace_id AS workspaceId, title,
                created_at AS createdAt, updated_at AS updatedAt
            FROM harness_sessions
            WHERE user_id = $userId AND workspace_id = $workspaceId
                AND title IS NOT NULL
            ORDER BY updated_at DESC, rowid DESC;
        `).all({ userId, workspaceId });
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

    touch(id: string, userId: string, updatedAt = new Date().toISOString()): void {
        this.db.query(`
            UPDATE harness_sessions SET updated_at = $updatedAt
            WHERE id = $id AND user_id = $userId;
        `).run({ id, userId, updatedAt });
    }
}
