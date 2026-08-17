import type { Database } from "bun:sqlite";
import type { HarnessSession } from "./harness-session.ts";

export class HarnessSessionStore {
    constructor(private readonly db: Database) {}

    create(session: HarnessSession): void {
        const parameters = { ...session };
        this.db.query<unknown, typeof parameters>(`
            INSERT INTO harness_sessions (
                id, tenant_id, instance_id, runtime_session_ref,
                created_at, updated_at
            ) VALUES (
                $id, $tenantId, $instanceId, $runtimeSessionRef,
                $createdAt, $updatedAt
            );
        `).run(parameters);
    }

    get(id: string): HarnessSession | null {
        return this.db.query<HarnessSession, { id: string }>(`
            SELECT id, tenant_id AS tenantId, instance_id AS instanceId,
                runtime_session_ref AS runtimeSessionRef,
                created_at AS createdAt, updated_at AS updatedAt
            FROM harness_sessions WHERE id = $id;
        `).get({ id });
    }

    update(session: HarnessSession): void {
        const parameters = { ...session };
        this.db.query<unknown, typeof parameters>(`
            UPDATE harness_sessions SET
                runtime_session_ref = $runtimeSessionRef,
                updated_at = $updatedAt
            WHERE id = $id;
        `).run(parameters);
    }
}
