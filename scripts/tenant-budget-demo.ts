import type { ExecutionPolicyInput } from "../src/resources/execution-policy.ts";
import { DeterministicExecutionPolicy } from "../src/resources/execution-policy.ts";
import {
    MemoryResourceLedger,
} from "../src/resources/resource-ledger.ts";
import { computeFairShareUnits, type TenantBudget } from "../src/resources/tenant-budget.ts";
import {
    BudgetAwareExecutionPolicy,
    LedgerBudgetUsage,
} from "../src/resources/budget-aware-policy.ts";

/**
 * Multi-tenant resource budget demo.
 *
 * Shows the three-layer story: per-tenant budget + fair-share (weights) +
 * an audit ledger (commit/settle/chargeback). Deterministic and side-effect
 * free — run with `bun run scripts/tenant-budget-demo.ts`.
 */
const budgets: Readonly<Record<string, TenantBudget>> = {
    "tenant-a": { tenantId: "tenant-a", weight: 2, maxUnits: 8 },
    "tenant-b": { tenantId: "tenant-b", weight: 1, maxUnits: 8 },
};
const weights: Readonly<Record<string, number>> = { "tenant-a": 2, "tenant-b": 1 };
const CAPACITY = 9;

const ledger = new MemoryResourceLedger();
const usage = new LedgerBudgetUsage(ledger, budgets, CAPACITY, weights);
const policy = new BudgetAwareExecutionPolicy(
    new DeterministicExecutionPolicy({ maxActiveRuns: 5 }),
    usage,
);

const timeline: Array<Record<string, unknown>> = [];

function decide(label: string, tenantId: string, pressure: ExecutionPolicyInput["classification"]["pressure"]) {
    const decision = policy.decide({
        runId: label,
        tenantId,
        classification: { pressure, snapshotId: "snap", reasons: [], gpuMemoryUsagePercent: null },
        activeRunCount: 0,
        activeTenantRunCount: 0,
    });
    timeline.push({
        event: `submit ${label}`,
        tenantId,
        decision: decision.action,
        reasonCode: decision.reasonCode,
        tenantActiveUnits: usage.activeUnits(tenantId),
        tenantAvailable: usage.availableUnits(tenantId),
    });
    return decision;
}

// Simulated multi-tenant lifecycle.
const d1 = decide("r1", "tenant-a", "NORMAL");
if (d1.action === "START") ledger.commit({ runId: "r1", tenantId: "tenant-a", units: 4 });

const d2 = decide("r2", "tenant-b", "NORMAL");
if (d2.action === "START") ledger.commit({ runId: "r2", tenantId: "tenant-b", units: 2 });

// a already holds 4/6 fair share; a third would fit (4+... ) but let's push to the edge:
const d3 = decide("r3", "tenant-a", "NORMAL");
if (d3.action === "START") ledger.commit({ runId: "r3", tenantId: "tenant-a", units: 2 });

const d4 = decide("r4", "tenant-a", "NORMAL"); // a now at 6/6 -> budget exhausted
if (d4.action === "START") ledger.commit({ runId: "r4", tenantId: "tenant-a", units: 1 });

ledger.settle({ runId: "r3", reason: "COMPLETED" });
const d5 = decide("r5", "tenant-a", "NORMAL"); // after settle, room again
if (d5.action === "START") ledger.commit({ runId: "r5", tenantId: "tenant-a", units: 1 });

ledger.settle({ runId: "r1", reason: "FAILED" });
ledger.settle({ runId: "r2", reason: "COMPLETED" });
ledger.settle({ runId: "r5", reason: "LOST" });

const report = {
    title: "多租户资源核算（预算 + Fair-Share + 账本）",
    capacityUnits: CAPACITY,
    tenantFairShares: Object.keys(weights).map((tenantId) => ({
        tenantId,
        weight: weights[tenantId],
        fairShareUnits: computeFairShareUnits({ tenantId, capacityUnits: CAPACITY, weights }),
    })),
    timeline,
    ledgerEndState: {
        activeUnitsByTenant: {
            "tenant-a": ledger.activeUnits("tenant-a"),
            "tenant-b": ledger.activeUnits("tenant-b"),
        },
        chargebackSettledUnits: {
            "tenant-a": ledger.settledTotalUnits("tenant-a"),
            "tenant-b": ledger.settledTotalUnits("tenant-b"),
        },
    },
};

console.log(JSON.stringify(report, null, 2));
