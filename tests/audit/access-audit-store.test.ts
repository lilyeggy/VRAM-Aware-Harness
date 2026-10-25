import { expect, test } from "bun:test";
import { AccessAuditStore } from "../../src/audit/access-audit-store.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

test("访问审计按 User 保存允许与拒绝事实，不保存凭证内容", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new AccessAuditStore(db);
        store.record({
            action: "tasks:read", outcome: "ALLOW",
            userId: "user-a", resourceType: "HTTP_REQUEST", resourceId: null,
            reason: "scope_granted",
        });
        store.record({
            action: "tasks:write", outcome: "DENY",
            userId: "user-a", resourceType: "HTTP_REQUEST", resourceId: null,
            reason: "missing_scope",
        });
        expect(store.listForUser("user-a")).toMatchObject([
            { action: "tasks:read", outcome: "ALLOW", reason: "scope_granted" },
            { action: "tasks:write", outcome: "DENY", reason: "missing_scope" },
        ]);
        expect(JSON.stringify(store.listForUser("user-a"))).not.toContain("Bearer");
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
            userId: null, resourceType: "HTTP_REQUEST", resourceId: null,
            reason: "invalid_or_revoked_api_key",
            attemptedKeyDigest: "sha256hex-of-attempted-key",
        });
        const events = store.listForUser("user-a");
        // 无用户归属的 DENY 不会出现在用户视图（归属不可知）——按设计。
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
                userId: "user-page", resourceType: "HTTP_REQUEST",
                resourceId: null, reason: "scope_granted",
            });
        }

        expect(store.listForUser("user-page", { limit: 2 })
            .map((event) => event.action))
            .toEqual(["action-0", "action-1"]);
        expect(store.listForUser("user-page", { limit: 2, offset: 2 })
            .map((event) => event.action))
            .toEqual(["action-2", "action-3"]);
        // limit 越界安全；上限 500 钳制。
        expect(store.listForUser("user-page", { limit: 10_000 }))
            .toHaveLength(5);
        expect(store.listForUser("user-page", { offset: 4 }))
            .toHaveLength(1);
    } finally {
        db.close();
    }
});

test("§9.7 v1.3：审计存储只追加，UPDATE/DELETE 被触发器拒绝", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new AccessAuditStore(db);
        store.record({
            action: "tasks:read", outcome: "ALLOW",
            userId: "user-immutable", resourceType: "HTTP_REQUEST",
            resourceId: null, reason: "scope_granted",
        });

        expect(() => db.exec(
            `UPDATE access_audit_events SET reason = 'tampered'`,
        )).toThrow(/只追加审计存储/);
        expect(() => db.exec(
            `DELETE FROM access_audit_events`,
        )).toThrow(/只追加审计存储/);
        expect(store.verifyChain()).toEqual({ ok: true, checked: 1, legacy: 0 });
    } finally {
        db.close();
    }
});

test("§9.7 v1.3：hash 链可检测绕过触发器的内容篡改", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new AccessAuditStore(db);
        store.record({
            action: "tasks:read", outcome: "ALLOW",
            userId: "user-chain", resourceType: "HTTP_REQUEST",
            resourceId: null, reason: "scope_granted",
        });
        store.record({
            action: "tasks:write", outcome: "DENY",
            userId: "user-chain", resourceType: "HTTP_REQUEST",
            resourceId: null, reason: "missing_scope",
        });
        expect(store.verifyChain().ok).toBe(true);

        // 攻击者绕过触发器直接改库：hash 链仍应发现内容被篡改。
        db.exec(`DROP TRIGGER access_audit_events_no_update`);
        db.exec(`UPDATE access_audit_events SET reason = 'tampered' WHERE rowid = 1`);

        const result = store.verifyChain();
        expect(result.ok).toBe(false);
        expect(result.brokenAt).toBeDefined();
        expect(result.reason).toBe("hash 不匹配");
    } finally {
        db.close();
    }
});

test("§9.7 v1.3：hash 链可检测删除中间审计行", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new AccessAuditStore(db);
        for (let i = 0; i < 3; i += 1) {
            store.record({
                action: `action-${i}`, outcome: "ALLOW",
                userId: "user-delete", resourceType: "HTTP_REQUEST",
                resourceId: null, reason: "scope_granted",
            });
        }
        expect(store.verifyChain().ok).toBe(true);

        db.exec(`DROP TRIGGER access_audit_events_no_delete`);
        db.exec(`DELETE FROM access_audit_events WHERE rowid = 2`);

        const result = store.verifyChain();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("prev_hash 不匹配");
    } finally {
        db.close();
    }
});
