import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
    DEFAULT_TENANT_BILLING_PRICING,
    TenantBillingStore,
    resolveTenantBillingPricing,
    type TenantBillingPricing,
} from "../../src/billing/tenant-billing.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

const BASE_TIME = "2026-10-10T00:00:00.000Z";

function seedRun(
    db: Database,
    input: {
        id: string;
        tenantId: string;
        status?: "COMPLETED" | "FAILED" | "RUNNING";
        startedAt?: string | null;
        finishedAt?: string | null;
    },
): void {
    db.query(`
        INSERT INTO agent_runs (
            id, tenant_id, harness_session_id, status, user_input, workspace_path,
            created_at, updated_at, started_at, finished_at, checkpoint_id,
            failure_reason, run_policy_json, thinking_level
        ) VALUES (
            $id, $tenantId, $sessionId, $status, $userInput, $workspacePath,
            $createdAt, $updatedAt, $startedAt, $finishedAt, NULL,
            NULL, NULL, 'off'
        );
    `).run({
        id: input.id,
        tenantId: input.tenantId,
        sessionId: `session-${input.id}`,
        status: input.status ?? "COMPLETED",
        userInput: "billing test task",
        workspacePath: `/workspaces/${input.id}`,
        createdAt: BASE_TIME,
        updatedAt: input.finishedAt ?? BASE_TIME,
        startedAt: input.startedAt ?? BASE_TIME,
        finishedAt: input.finishedAt ?? null,
    });
}

function seedSnapshot(db: Database, input: { id: string; runId: string; tenantId: string }): void {
    db.query(`
        INSERT INTO effective_policy_snapshots (
            id, run_id, tenant_id, layers_json, effective_json, created_at
        ) VALUES ($id, $runId, $tenantId, '[]', '{}', $createdAt);
    `).run({ ...input, createdAt: BASE_TIME });
}

function seedSandbox(
    db: Database,
    input: {
        id: string;
        runId: string;
        snapshotId: string;
        status: "ACTIVE" | "TERMINATED" | "LOST" | "FAILED";
        createdAt: string;
        updatedAt: string;
    },
): void {
    db.query(`
        INSERT INTO sandboxes (
            id, run_id, policy_snapshot_id, provider, status, workspace_path,
            secret_names_json, created_at, updated_at, failure_reason, profile,
            runtime, spec_json, runtime_evidence_json
        ) VALUES (
            $id, $runId, $snapshotId, 'microvm', $status, $workspacePath,
            '[]', $createdAt, $updatedAt, NULL, 'strict', 'firecracker', '{}', '{}'
        );
    `).run({
        ...input,
        workspacePath: `/workspaces/${input.runId}`,
    });
}

function seedModelCompleted(
    db: Database,
    input: {
        eventId: string;
        runId: string;
        sequence: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        providerCost: number;
        timestamp?: string;
    },
): void {
    const payload = JSON.stringify({
        modelCallId: `call-${input.eventId}`,
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        durationMs: 100,
        stopReason: "stop",
        usage: {
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: input.totalTokens,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: input.providerCost,
            },
        },
    });
    db.query(`
        INSERT INTO run_events (
            event_id, run_id, sequence, type, timestamp, payload_version,
            payload_json, dedupe_key
        ) VALUES ($eventId, $runId, $sequence, 'MODEL_COMPLETED', $timestamp, 1, $payload, $dedupeKey);
    `).run({
        eventId: input.eventId,
        runId: input.runId,
        sequence: input.sequence,
        timestamp: input.timestamp ?? BASE_TIME,
        payload,
        dedupeKey: `dedupe-${input.eventId}`,
    });
}

function seedTool(
    db: Database,
    input: {
        id: string;
        runId: string;
        status: "SUCCEEDED" | "FAILED";
    },
): void {
    db.query(`
        INSERT INTO tool_executions (
            id, run_id, tool_call_id, tool_name, arguments_json, effect, status,
            result_json, error_message, created_at, finished_at
        ) VALUES (
            $id, $runId, $toolCallId, 'bash', '{}', 'READ_ONLY', $status,
            $resultJson, $errorMessage, $createdAt, $finishedAt
        );
    `).run({
        id: input.id,
        runId: input.runId,
        toolCallId: `call-${input.id}`,
        status: input.status,
        resultJson: input.status === "SUCCEEDED" ? "{}" : null,
        errorMessage: input.status === "FAILED" ? "boom" : null,
        createdAt: BASE_TIME,
        finishedAt: "2026-10-10T00:00:01.000Z",
    });
}

describe("TenantBillingStore", () => {
    test("按租户汇总 provider 成本、沙箱秒、工具调用，并按平台单价计费", () => {
        const db = openHarnessDatabase(":memory:");
        const pricing: TenantBillingPricing = {
            currency: "USD",
            modelInputPerMillionTokens: 0,
            modelOutputPerMillionTokens: 0,
            sandboxSecond: 0.01,
            toolCall: 0.001,
        };
        const store = new TenantBillingStore(db, pricing);

        seedRun(db, { id: "run-a1", tenantId: "tenant-a" });
        seedSnapshot(db, { id: "snap-a1", runId: "run-a1", tenantId: "tenant-a" });
        seedSandbox(db, {
            id: "sandbox-a1",
            runId: "run-a1",
            snapshotId: "snap-a1",
            status: "TERMINATED",
            createdAt: "2026-10-10T00:00:00.000Z",
            updatedAt: "2026-10-10T00:00:10.000Z",
        });
        seedModelCompleted(db, {
            eventId: "event-a1",
            runId: "run-a1",
            sequence: 1,
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
            providerCost: 0.25,
        });
        seedTool(db, { id: "tool-a1", runId: "run-a1", status: "SUCCEEDED" });
        seedTool(db, { id: "tool-a2", runId: "run-a1", status: "SUCCEEDED" });
        seedTool(db, { id: "tool-a3", runId: "run-a1", status: "FAILED" });

        seedRun(db, { id: "run-b1", tenantId: "tenant-b" });
        seedSnapshot(db, { id: "snap-b1", runId: "run-b1", tenantId: "tenant-b" });
        seedModelCompleted(db, {
            eventId: "event-b1",
            runId: "run-b1",
            sequence: 1,
            inputTokens: 10,
            outputTokens: 10,
            totalTokens: 20,
            providerCost: 99.6,
        });
        seedTool(db, { id: "tool-b1", runId: "run-b1", status: "SUCCEEDED" });

        const summary = store.summarize("tenant-a");
        expect(summary.tenantId).toBe("tenant-a");
        expect(summary.currency).toBe("USD");
        expect(summary.totals.modelCalls).toBe(1);
        expect(summary.totals.inputTokens).toBe(1000);
        expect(summary.totals.outputTokens).toBe(500);
        expect(summary.totals.totalTokens).toBe(1500);
        expect(summary.totals.providerCost).toBe(0.25);
        expect(summary.totals.sandboxSeconds).toBe(10);
        expect(summary.totals.toolCalls).toBe(3);
        expect(summary.totals.amount).toBe(0.353);
        expect(summary.lineItems.map((item) => item.category)).toEqual([
            "MODEL_PROVIDER_COST",
            "SANDBOX_SECONDS",
            "TOOL_CALLS",
        ]);

        const other = store.summarize("tenant-b");
        expect(other.totals.providerCost).toBe(99.6);
        expect(other.totals.sandboxSeconds).toBe(0);
        expect(other.totals.toolCalls).toBe(1);
        expect(other.totals.amount).toBe(99.601);

        const missing = store.summarize("tenant-missing");
        expect(missing.totals.amount).toBe(0);
        expect(missing.totals.modelCalls).toBe(0);
        expect(missing.totals.toolCalls).toBe(0);
    });

    test("配置平台 token 单价后叠加 token 费用", () => {
        const db = openHarnessDatabase(":memory:");
        const pricing: TenantBillingPricing = {
            currency: "USD",
            modelInputPerMillionTokens: 2,
            modelOutputPerMillionTokens: 4,
            sandboxSecond: 0,
            toolCall: 0,
        };
        const store = new TenantBillingStore(db, pricing);

        seedRun(db, { id: "run-token", tenantId: "tenant-token" });
        seedModelCompleted(db, {
            eventId: "event-token",
            runId: "run-token",
            sequence: 1,
            inputTokens: 1_000_000,
            outputTokens: 500_000,
            totalTokens: 1_500_000,
            providerCost: 0,
        });

        const summary = store.summarize("tenant-token");
        expect(summary.totals.amount).toBe(4);
        expect(summary.totals.inputTokens).toBe(1_000_000);
        expect(summary.totals.outputTokens).toBe(500_000);
        expect(summary.lineItems.find((item) => item.category === "MODEL_INPUT_TOKENS")?.amount).toBe(2);
        expect(summary.lineItems.find((item) => item.category === "MODEL_OUTPUT_TOKENS")?.amount).toBe(2);
    });

    test("resolveTenantBillingPricing 读取环境变量，非法值回退默认", () => {
        expect(resolveTenantBillingPricing({})).toEqual(DEFAULT_TENANT_BILLING_PRICING);

        const configured = resolveTenantBillingPricing({
            HARNESS_BILLING_CURRENCY: "CNY",
            HARNESS_BILLING_MODEL_INPUT_PER_MTOK: "2.5",
            HARNESS_BILLING_MODEL_OUTPUT_PER_MTOK: "5",
            HARNESS_BILLING_SANDBOX_SECOND: "0.02",
            HARNESS_BILLING_TOOL_CALL: "0.003",
        });
        expect(configured).toEqual({
            currency: "CNY",
            modelInputPerMillionTokens: 2.5,
            modelOutputPerMillionTokens: 5,
            sandboxSecond: 0.02,
            toolCall: 0.003,
        });

        const invalid = resolveTenantBillingPricing({
            HARNESS_BILLING_MODEL_INPUT_PER_MTOK: "-1",
            HARNESS_BILLING_MODEL_OUTPUT_PER_MTOK: "abc",
            HARNESS_BILLING_SANDBOX_SECOND: "",
        });
        expect(invalid.modelInputPerMillionTokens).toBe(0);
        expect(invalid.modelOutputPerMillionTokens).toBe(0);
        expect(invalid.sandboxSecond).toBe(0);
    });
});
