import type { Database } from "bun:sqlite";
import { openHarnessDatabase } from "../src/storage/database.ts";
import { FakeResourceObserver } from "../tests/fakes/fake-resource-observer.ts";
import type { ResourceObservation } from "../src/resources/resource-observer.ts";
import { ResourceAdmissionService } from "../src/resources/resource-admission-service.ts";
import type { ResourceThresholds } from "../src/resources/resource-classifier.ts";
import { DeterministicExecutionPolicy } from "../src/resources/execution-policy.ts";
import { PolicyDecisionStore } from "../src/resources/policy-decision-store.ts";
import {
    MemoryResourceLedger,
} from "../src/resources/resource-ledger.ts";
import type { TenantBudget } from "../src/resources/tenant-budget.ts";
import {
    BudgetAwareExecutionPolicy,
    LedgerBudgetUsage,
} from "../src/resources/budget-aware-policy.ts";

/**
 * Server integration: tenant budget ledger wired into the REAL
 * ResourceAdmissionService + REAL SQLite PolicyDecisionStore.
 *
 * This is not a fresh-logic mock — the admission path, threshold classifier and
 * the SQLite policy_decisions table are the production ones. Only the resource
 * observer is a labeled Fake NORMAL (external models don't expose vLLM metrics),
 * exactly like server-model-api-demo.ts. The budget layer (weight + ledger +
 * fair share) is what drives START/QUEUE here.
 */
const thresholds: ResourceThresholds = {
    busyGpuMemoryPercent: 80,
    criticalGpuMemoryPercent: 90,
    busyKvCachePercent: 80,
    criticalKvCachePercent: 90,
    busyRunningRequests: 10,
    criticalRunningRequests: 50,
    busyWaitingRequests: 10,
    criticalWaitingRequests: 50,
};

function normalObservation(): ResourceObservation {
    return {
        ok: true,
        snapshot: {
            snapshotId: `normal-${crypto.randomUUID()}`,
            observedAt: new Date().toISOString(),
            sources: ["FAKE"],
            gpuTotalMemoryMiB: 100,
            gpuUsedMemoryMiB: 20,
            gpuFreeMemoryMiB: 80,
            gpuUtilizationPercent: 20,
            runningRequests: 0,
            waitingRequests: 0,
            kvCacheUsagePercent: 20,
            inputTokensPerSecond: 0,
            outputTokensPerSecond: 0,
        },
    };
}

// Rewrite the script runner expectation: this file is meant to be run directly
// with bun, not imported by tests.
if (import.meta.main) {
    const db = openHarnessDatabase(
        process.env.HARNESS_BUDGET_DB_PATH ?? "/tmp/harness-budget-demo.db",
    );
    const recorder = new PolicyDecisionStore(db);

    const ledger = new MemoryResourceLedger();
    const budgets: Readonly<Record<string, TenantBudget>> = {
        "tenant-a": { tenantId: "tenant-a", weight: 2, maxUnits: 8 },
        "tenant-b": { tenantId: "tenant-b", weight: 1, maxUnits: 8 },
    };
    const weights = { "tenant-a": 2, "tenant-b": 1 };
    const CAPACITY = 9;

    const usage = new LedgerBudgetUsage(ledger, budgets, CAPACITY, weights);
    const policy = new BudgetAwareExecutionPolicy(
        new DeterministicExecutionPolicy({ maxActiveRuns: 50 }),
        usage,
    );

    const admission = new ResourceAdmissionService(
        new FakeResourceObserver(normalObservation()),
        thresholds,
        policy,
        recorder,
    );

    const activeTenantCount = (tenantId: string) =>
        ledger.activeEntries().filter((e) => e.tenantId === tenantId).length;

    // policy_decisions.run_id has a FK to agent_runs(id): create a real run row
    // before admitting it, exactly as the control plane would.
    function ensureRun(runId: string, tenantId: string) {
        const now = new Date().toISOString();
        db.query<unknown, Record<string, string>>(
            `INSERT OR IGNORE INTO agent_runs
                (id, tenant_id, harness_session_id, status, user_input,
                 workspace_path, created_at, updated_at)
             VALUES ($id, $tenant, 'budget-demo-session', 'QUEUED', 'demo',
                     '/tmp/budget-ws', $now, $now)`,
        ).run({ id: runId, tenant: tenantId, now });
    }

    async function submit(runId: string, tenantId: string) {
        ensureRun(runId, tenantId);
        const preActive = usage.activeUnits(tenantId);
        const preAvailable = usage.availableUnits(tenantId);
        const result = await admission.evaluate({
            runId,
            tenantId,
            activeRunCount: ledger.activeEntries().length,
            activeTenantRunCount: activeTenantCount(tenantId),
        });
        if (result.decision.action === "START") {
            ledger.commit({ runId, tenantId, units: 1 });
        }
        return { decision: result.decision, preActive, preAvailable };
    }

    const trace: Array<Record<string, unknown>> = [];
    const record = (
        event: string,
        tenantId: string,
        step: { decision: { action: string; reasonCode: string }; preActive: number; preAvailable: number },
    ) => {
        trace.push({
            event,
            tenantId,
            action: step.decision.action,
            reasonCode: step.decision.reasonCode,
            tenantActiveUnits: step.preActive,
            tenantAvailable: step.preAvailable,
        });
    };

    // Multi-tenant lifecycle: drive tenant-a up to its fair-share ceiling (6)
    // so a further run hits the budget, then settle one and confirm it resumes.
    async function step(name: string, runId: string, tenantId: string) {
        const outcome = await submit(runId, tenantId);
        record(name, tenantId, outcome);
        return outcome.decision;
    }

    await step("submit r1", "r1", "tenant-a");
    await step("submit r2", "r2", "tenant-b");   // tenant-b unaffected by a's share
    await step("submit r3", "r3", "tenant-a");
    await step("submit r4", "r4", "tenant-a");
    await step("submit r5", "r5", "tenant-a");
    await step("submit r6", "r6", "tenant-a");  // a now holds 5/6
    await step("submit r7", "r7", "tenant-a");  // a now holds 6/6 (ceiling)
    await step("submit r8 (over budget)", "r8", "tenant-a");

    ledger.settle({ runId: "r3", reason: "COMPLETED" });
    await step("submit r9 (after settle)", "r9", "tenant-a");

    const decisions = db.query<{ run_id: string; action: string; reason_code: string }, []>(
        "SELECT run_id, action, reason_code FROM policy_decisions ORDER BY decided_at",
    ).all();

    const report = {
        title: "服务器集成：真实 ResourceAdmissionService + SQLite 决策库 + 租户预算账本",
        capacityUnits: CAPACITY,
        tenantBudgets: { "tenant-a": { weight: 2, fairShare: 6 }, "tenant-b": { weight: 1, fairShare: 3 } },
        trace,
        persistedDecisionCount: decisions.length,
        persistedDecisions: decisions,
        chargebackSettled: {
            "tenant-a": ledger.settledTotalUnits("tenant-a"),
            "tenant-b": ledger.settledTotalUnits("tenant-b"),
        },
    };

    console.log(JSON.stringify(report, null, 2));
    db.close();
}
