import { AccessAuditStore } from "../src/audit/access-audit-store.ts";
import { openHarnessDatabase } from "../src/storage/database.ts";

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(`审计链 smoke 断言失败：${message}`);
    }
}

function runSelfTest(): void {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new AccessAuditStore(db);
        for (let i = 0; i < 3; i += 1) {
            store.record({
                action: `smoke-${i}`,
                outcome: i === 1 ? "DENY" : "ALLOW",
                userId: "smoke-user",
                resourceType: "HTTP_REQUEST",
                resourceId: null,
                reason: `reason-${i}`,
            });
        }

        const ok = store.verifyChain();
        assert(ok.ok && ok.checked === 3, `初始链应通过，实际 ${JSON.stringify(ok)}`);

        let updateRejected = false;
        try {
            db.exec(`UPDATE access_audit_events SET reason = 'tampered'`);
        } catch {
            updateRejected = true;
        }
        assert(updateRejected, "触发器应拒绝 UPDATE");

        let deleteRejected = false;
        try {
            db.exec(`DELETE FROM access_audit_events`);
        } catch {
            deleteRejected = true;
        }
        assert(deleteRejected, "触发器应拒绝 DELETE");

        // 绕过触发器直接改库，模拟攻击者拿到数据库写权限后的篡改。
        db.exec(`DROP TRIGGER access_audit_events_no_update`);
        db.exec(`UPDATE access_audit_events SET reason = 'tampered' WHERE rowid = 1`);
        const tampered = store.verifyChain();
        assert(!tampered.ok, "绕过触发器的篡改应被 hash 链发现");
        assert(tampered.reason === "hash 不匹配", `篡改原因应为 hash 不匹配，实际 ${tampered.reason}`);

        console.log(JSON.stringify({
            updateRejected,
            deleteRejected,
            tamperDetected: !tampered.ok,
            checked: ok.checked,
        }));
        console.log("AUDIT_CHAIN_SMOKE_OK");
    } finally {
        db.close();
    }
}

function verifyDatabase(databasePath: string): void {
    const db = openHarnessDatabase(databasePath);
    try {
        const store = new AccessAuditStore(db);
        const result = store.verifyChain();
        console.log(JSON.stringify({ database: databasePath, ...result }));
        if (!result.ok) {
            process.exit(1);
        }
        console.log("AUDIT_CHAIN_VERIFY_OK");
    } finally {
        db.close();
    }
}

const args = process.argv.slice(2);
if (args[0] === "--database") {
    const databasePath = args[1];
    if (!databasePath) {
        console.error("用法：bun run scripts/audit-chain-smoke.ts --database <path>");
        process.exit(2);
    }
    verifyDatabase(databasePath);
} else {
    runSelfTest();
}
