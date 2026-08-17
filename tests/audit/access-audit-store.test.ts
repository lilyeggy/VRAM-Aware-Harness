import { expect, test } from "bun:test";
import { AccessAuditStore } from "../../src/audit/access-audit-store.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

test("访问审计按 Tenant 保存允许与拒绝事实，不保存凭证内容", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new AccessAuditStore(db);
        store.record({
            action: "tasks:read", outcome: "ALLOW", subjectId: "user-a",
            tenantId: "tenant-a", resourceType: "HTTP_REQUEST", resourceId: null,
            reason: "scope_granted",
        });
        store.record({
            action: "tasks:write", outcome: "DENY", subjectId: "user-a",
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
