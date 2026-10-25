import { openHarnessDatabase } from "../src/storage/database.ts";
import { UserBillingStore, type UserBillingPricing } from "../src/billing/user-billing.ts";

function readFlag(name: string): string | null {
    const index = process.argv.indexOf(name);
    if (index === -1) {
        return null;
    }
    return process.argv[index + 1] ?? null;
}

function seedSelfTestData(db: ReturnType<typeof openHarnessDatabase>): void {
    db.query(`INSERT INTO agent_runs (
        id, user_id, harness_session_id, status, user_input, workspace_path,
        created_at, updated_at, started_at, finished_at, checkpoint_id,
        failure_reason, run_policy_json, thinking_level
    ) VALUES ('smoke-run', 'smoke-user', 'smoke-session', 'COMPLETED', 'task', '/w',
        '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:10.000Z',
        '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:10.000Z', NULL, NULL, NULL, 'off')`).run();
    db.query(`INSERT INTO effective_policy_snapshots (
        id, run_id, user_id, layers_json, effective_json, created_at
    ) VALUES ('smoke-snapshot', 'smoke-run', 'smoke-user', '[]', '{}', '2026-10-10T00:00:00.000Z')`).run();
    db.query(`INSERT INTO sandboxes (
        id, run_id, policy_snapshot_id, provider, status, workspace_path,
        secret_names_json, created_at, updated_at, failure_reason, profile,
        runtime, spec_json, runtime_evidence_json
    ) VALUES ('smoke-sandbox', 'smoke-run', 'smoke-snapshot', 'microvm', 'TERMINATED', '/w',
        '[]', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:10.000Z', NULL, 'strict',
        'firecracker', '{}', '{}')`).run();
    const payload = JSON.stringify({
        usage: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 1500,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
        },
    });
    db.query(`INSERT INTO run_events (
        event_id, run_id, sequence, type, timestamp, payload_version, payload_json, dedupe_key
    ) VALUES ('smoke-event', 'smoke-run', 1, 'MODEL_COMPLETED', '2026-10-10T00:00:00.000Z', 1, $payload, 'smoke-dedupe')`).run({ payload });
    for (const [id, status] of [["smoke-tool-1", "SUCCEEDED"], ["smoke-tool-2", "SUCCEEDED"], ["smoke-tool-3", "FAILED"]] as const) {
        db.query(`INSERT INTO tool_executions (
            id, run_id, tool_call_id, tool_name, arguments_json, effect, status,
            result_json, error_message, created_at, finished_at
        ) VALUES ($id, 'smoke-run', $toolCallId, 'bash', '{}', 'READ_ONLY', $status,
            $resultJson, $errorMessage, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:01.000Z')`).run({
            id,
            toolCallId: `call-${id}`,
            status,
            resultJson: status === "SUCCEEDED" ? "{}" : null,
            errorMessage: status === "FAILED" ? "boom" : null,
        });
    }
}

function runSelfTest(): void {
    const db = openHarnessDatabase(":memory:");
    try {
        seedSelfTestData(db);
        const pricing: UserBillingPricing = {
            currency: "USD",
            modelInputPerMillionTokens: 0,
            modelOutputPerMillionTokens: 0,
            sandboxSecond: 0.01,
            toolCall: 0.001,
        };
        const summary = new UserBillingStore(db, pricing).summarize("smoke-user");
        const expectedAmount = 0.25 + 10 * 0.01 + 3 * 0.001;
        if (summary.totals.amount !== expectedAmount) {
            throw new Error(`账单金额不符合预期：期望 ${expectedAmount}，实际 ${summary.totals.amount}`);
        }
        if (summary.totals.sandboxSeconds !== 10 || summary.totals.toolCalls !== 3) {
            throw new Error(`账单计数不符合预期：${JSON.stringify(summary.totals)}`);
        }
        console.log(JSON.stringify({ summary }, null, 2));
        console.log("USER_BILLING_SMOKE_OK");
    } finally {
        db.close();
    }
}

function runDatabaseVerification(databasePath: string, userId: string | null): void {
    const db = openHarnessDatabase(databasePath);
    try {
        const store = new UserBillingStore(db);
        if (userId !== null) {
            console.log(JSON.stringify(store.summarize(userId), null, 2));
        } else {
            const users = db.query<{ userId: string; runs: number }, []>(`
                SELECT user_id AS userId, COUNT(*) AS runs
                FROM agent_runs
                GROUP BY user_id
                ORDER BY runs DESC, user_id ASC
                LIMIT 5;
            `).all();
            for (const user of users) {
                console.log(JSON.stringify(store.summarize(user.userId)));
            }
        }
        console.log("USER_BILLING_VERIFY_OK");
    } finally {
        db.close();
    }
}

const databasePath = readFlag("--database");
if (databasePath === null) {
    runSelfTest();
} else {
    runDatabaseVerification(databasePath, readFlag("--user"));
}
