import type { Database } from "bun:sqlite";

export interface AccessAuditEvent {
    readonly id: string;
    readonly timestamp: string;
    readonly action: string;
    readonly outcome: "ALLOW" | "DENY";
    readonly tenantId: string | null;
    readonly resourceType: string | null;
    readonly resourceId: string | null;
    readonly reason: string;
    /**
     * D4：鉴权失败时被尝试密钥的 SHA-256 摘要（仅摘要，绝不存明文）。
     * 对无效密钥租户归属天然不可知（tenantId 为 NULL），
     * 摘要让爆破/重放尝试可以被关联分析。
     */
    readonly attemptedKeyDigest: string | null;
}

export interface ListAuditEventsOptions {
    /** 返回条数上限；未指定时默认 200，最大 500。 */
    limit?: number;
    /** 跳过条数（配合 limit 做分页）。 */
    offset?: number;
}

const AUDIT_PAGE_DEFAULT_LIMIT = 200;
const AUDIT_PAGE_MAX_LIMIT = 500;

export class AccessAuditStore {
    constructor(private readonly db: Database) {}

    record(
        input: Omit<AccessAuditEvent, "id" | "timestamp" | "attemptedKeyDigest">
            & { attemptedKeyDigest?: string | null },
    ): void {
        this.db.query<unknown, {
            id: string; timestamp: string; action: string; outcome: "ALLOW" | "DENY";
            tenantId: string | null; resourceType: string | null;
            resourceId: string | null; reason: string;
            attemptedKeyDigest: string | null;
        }>(`
            INSERT INTO access_audit_events (
                id, timestamp, action, outcome, tenant_id,
                resource_type, resource_id, reason, attempted_key_digest
            ) VALUES (
                $id, $timestamp, $action, $outcome, $tenantId,
                $resourceType, $resourceId, $reason, $attemptedKeyDigest
            );
        `).run({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            ...input,
            attemptedKeyDigest: input.attemptedKeyDigest ?? null,
        });
    }

    listForTenant(
        tenantId: string,
        options: ListAuditEventsOptions = {},
    ): AccessAuditEvent[] {
        const limit = normalizePageLimit(options.limit);
        const offset = Math.max(0, Math.floor(options.offset ?? 0));
        return this.db.query<AccessAuditEvent, {
            tenantId: string; limit: number; offset: number;
        }>(`
            SELECT id, timestamp, action, outcome,
                tenant_id AS tenantId, resource_type AS resourceType,
                resource_id AS resourceId, reason,
                attempted_key_digest AS attemptedKeyDigest
            FROM access_audit_events WHERE tenant_id = $tenantId
            ORDER BY timestamp ASC, rowid ASC
            LIMIT $limit OFFSET $offset;
        `).all({ tenantId, limit, offset });
    }
}

function normalizePageLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) {
        return AUDIT_PAGE_DEFAULT_LIMIT;
    }
    return Math.min(AUDIT_PAGE_MAX_LIMIT, Math.max(1, Math.floor(raw)));
}
