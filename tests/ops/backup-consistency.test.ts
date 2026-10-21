import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import { AccessAuditStore } from "../../src/audit/access-audit-store.ts";
import { backupSqliteDatabase } from "../../src/ops/harness-maintenance.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

/**
 * §9.9 v1.5 Phase 5 F6：Run 执行期间备份一致性。
 *
 * 备份走 `VACUUM INTO`，必须与 WAL 写入共存（不抛 SQLITE_BUSY），
 * 且产出的备份要能通过审计 hash 链校验。
 */

test("Run 执行期间备份：WAL 下 VACUUM INTO 不与写入冲突，备份可校验审计链", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-backup-"));
    const databasePath = join(dir, "harness.sqlite");
    const backupDir = join(dir, "backups");
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH: databasePath,
        HARNESS_PUMP_INTERVAL_MS: "60000",
        HARNESS_SANDBOX_PROVIDER: "managed-local",
        HARNESS_WORKER_ISOLATION: "in-process",
    });
    const composition = await createHarnessApplication(config, {
        runtime: new FakeAgentRuntime(),
    });

    try {
        await composition.application.start();
        composition.accessAuditStore.record({
            action: "run.submit",
            outcome: "ALLOW",
            tenantId: "tenant-backup",
            resourceType: "run",
            resourceId: "run-backup",
            reason: "phase5-f6",
        });

        // 模拟执行中的写入方：另一连接持有写事务（WAL 下读者不应被阻塞）。
        const writer = new Database(databasePath);
        writer.exec("CREATE TABLE IF NOT EXISTS backup_probe(x TEXT);");
        writer.exec("BEGIN IMMEDIATE;");
        writer.run("INSERT INTO backup_probe VALUES ('in-flight');");
        expect(existsSync(`${databasePath}-wal`)).toBe(true);

        const result = backupSqliteDatabase({
            databasePath,
            backupDir,
            keep: 7,
        });

        writer.exec("COMMIT;");
        writer.close();

        expect(existsSync(result.backupPath)).toBe(true);
        expect(result.bytes).toBeGreaterThan(0);

        const backup = new Database(result.backupPath, { readonly: true });
        try {
            const migrations = backup
                .query<{ version: number }, []>(
                    "SELECT version FROM schema_migrations ORDER BY version",
                )
                .all()
                .map((row) => row.version);
            expect(migrations).toEqual([1, 2, 3, 4]);

            const auditCount = backup
                .query<{ count: number }, []>(
                    "SELECT COUNT(*) AS count FROM access_audit_events",
                )
                .get();
            expect(auditCount?.count).toBeGreaterThan(0);

            const verification = new AccessAuditStore(backup).verifyChain();
            expect(verification.ok).toBe(true);
        } finally {
            backup.close();
        }
    } finally {
        await composition.close();
    }
});
