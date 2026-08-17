import type { Database } from "bun:sqlite";

export interface AccessAuditEvent {
    readonly id: string;
    readonly timestamp: string;
    readonly action: string;
    readonly outcome: "ALLOW" | "DENY";
    readonly subjectId: string | null;
    readonly tenantId: string | null;
    readonly resourceType: string | null;
    readonly resourceId: string | null;
    readonly reason: string;
}

export class AccessAuditStore {
    constructor(private readonly db: Database) {}

    record(input: Omit<AccessAuditEvent, "id" | "timestamp">): void {
        this.db.query<unknown, {
            id: string; timestamp: string; action: string; outcome: "ALLOW" | "DENY";
            subjectId: string | null; tenantId: string | null; resourceType: string | null;
            resourceId: string | null; reason: string;
        }>(`
            INSERT INTO access_audit_events (
                id, timestamp, action, outcome, subject_id, tenant_id,
                resource_type, resource_id, reason
            ) VALUES (
                $id, $timestamp, $action, $outcome, $subjectId, $tenantId,
                $resourceType, $resourceId, $reason
            );
        `).run({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...input });
    }

    listForTenant(tenantId: string): AccessAuditEvent[] {
        return this.db.query<AccessAuditEvent, { tenantId: string }>(`
            SELECT id, timestamp, action, outcome, subject_id AS subjectId,
                tenant_id AS tenantId, resource_type AS resourceType,
                resource_id AS resourceId, reason
            FROM access_audit_events WHERE tenant_id = $tenantId
            ORDER BY timestamp ASC, rowid ASC;
        `).all({ tenantId });
    }
}
