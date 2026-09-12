import { expect, test } from "bun:test";
import { AccessAuditStore } from "../../src/audit/access-audit-store.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

test("访问审计按 Tenant 保存允许与拒绝事实，不保存凭证内容", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new AccessAuditStore(db);
        store.record({
            action: "tasks:read", outcome: "ALLOW",
            tenantId: "tenant-a", resourceType: "HTTP_REQUEST", resourceId: null,
            reason: "scope_granted",
        });
        store.record({
            action: "tasks:write", outcome: "DENY",
            tenantId: "tenant-a", resourceType: "HTTP_REQUEST", resourceId: null,
            reason: "missing_scope",
        });
        expect(store.listForTenant("tenant-a")).toMatchObject([
            { action: "tasks:read", outcome: "ALLOW", reason: "scope_granted" },
            { action: "tasks:write", outcome: "DENY", reason: "missing_scope" },
        ]);
        expect(JSON.stringify(store.listForTenant("tenant-a"))).not.toContain("Bearer");
    } finally {
        db.close();
    }
});

test("D4：DENY 事件记录被尝试密钥的 SHA-256 摘要（不存明文）", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new AccessAuditStore(db);
        store.record({
            action: "AUTHENTICATE", outcome: "DENY",
            tenantId: null, resourceType: "HTTP_REQUEST", resourceId: null,
            reason: "invalid_or_revoked_api_key",
            attemptedKeyDigest: "sha256hex-of-attempted-key",
        });
        const events = store.listForTenant("tenant-a");
        // 无租户归属的 DENY 不会出现在租户视图（归属不可知）——按设计。
        expect(events).toEqual([]);

        const all = db.query<{ attempted_key_digest: string | null }, []>(
            `SELECT attempted_key_digest FROM access_audit_events`,
        ).all();
        expect(all).toHaveLength(1);
        expect(all[0]!.attempted_key_digest).toBe("sha256hex-of-attempted-key");
        expect(JSON.stringify(all)).not.toContain("Bearer");
    } finally {
        db.close();
    }
});

test("D4：审计查询支持 limit/offset 分页", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new AccessAuditStore(db);
        for (let i = 0; i < 5; i += 1) {
            store.record({
                action: `action-${i}`, outcome: "ALLOW",
                tenantId: "tenant-page", resourceType: "HTTP_REQUEST",
                resourceId: null, reason: "scope_granted",
            });
        }

        expect(store.listForTenant("tenant-page", { limit: 2 })
            .map((event) => event.action))
            .toEqual(["action-0", "action-1"]);
        expect(store.listForTenant("tenant-page", { limit: 2, offset: 2 })
            .map((event) => event.action))
            .toEqual(["action-2", "action-3"]);
        // limit 越界安全；上限 500 钳制。
        expect(store.listForTenant("tenant-page", { limit: 10_000 }))
            .toHaveLength(5);
        expect(store.listForTenant("tenant-page", { offset: 4 }))
            .toHaveLength(1);
    } finally {
        db.close();
    }
});
