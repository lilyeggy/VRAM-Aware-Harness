import { expect, test } from "bun:test";
import type { ExecutionPolicyInput } from "../../src/resources/execution-policy.ts";
import { DeterministicExecutionPolicy } from "../../src/resources/execution-policy.ts";
import {
    MemoryResourceLedger,
} from "../../src/resources/resource-ledger.ts";
import {
    canAdmitUnits,
    computeFairShareUnits,
    type TenantBudget,
} from "../../src/resources/tenant-budget.ts";
import {
    BudgetAwareExecutionPolicy,
    LedgerBudgetUsage,
} from "../../src/resources/budget-aware-policy.ts";

const budgets: Readonly<Record<string, TenantBudget>> = {
    "tenant-a": { tenantId: "tenant-a", weight: 2, maxUnits: 8 },
    "tenant-b": { tenantId: "tenant-b", weight: 1, maxUnits: 8 },
};
const weights = { "tenant-a": 2, "tenant-b": 1 };
const CAPACITY = 9;

function makeInput(overrides: Partial<ExecutionPolicyInput> = {}): ExecutionPolicyInput {
    return {
        runId: "run",
        tenantId: "tenant-a",
        classification: { pressure: "NORMAL", snapshotId: "snap" },
        activeRunCount: 0,
        activeTenantRunCount: 0,
        ...overrides,
    };
}

test("fair-share：按权重比例分配容量", () => {
    expect(computeFairShareUnits({ tenantId: "tenant-a", capacityUnits: CAPACITY, weights }))
        .toBe(6); // 9 * 2/3
    expect(computeFairShareUnits({ tenantId: "tenant-b", capacityUnits: CAPACITY, weights }))
        .toBe(3); // 9 * 1/3
});

test("fair-share：未知租户回退默认权重 1", () => {
    expect(computeFairShareUnits({ tenantId: "ghost", capacityUnits: 9, weights }))
        .toBe(3); // 9 * 1/3
});

test("canAdmitUnits：用量+请求不得越过 min(fairShare, maxUnits)", () => {
    // fair-share 6 < maxUnits 8，取 6；用量 5 + 请求 1 = 6 -> 允许
    expect(canAdmitUnits({ tenantId: "tenant-a", activeUnits: 5, requestedUnits: 1, fairShareUnits: 6, maxUnits: 8 }))
        .toBe(true);
    // 用量 6 + 请求 1 = 7 > 6 -> 拒绝（fair-share 兜底）
    expect(canAdmitUnits({ tenantId: "tenant-a", activeUnits: 6, requestedUnits: 1, fairShareUnits: 6, maxUnits: 8 }))
        .toBe(false);
    // maxUnits 更紧时取 maxUnits（8+1=9 > 8 -> 拒绝）
    expect(canAdmitUnits({ tenantId: "tenant-a", activeUnits: 8, requestedUnits: 1, fairShareUnits: 100, maxUnits: 8 }))
        .toBe(false);
});

test("账本：commit 预留、settle 结算、active 与累计正确", () => {
    const ledger = new MemoryResourceLedger();
    ledger.commit({ runId: "r1", tenantId: "tenant-a", units: 2 });
    ledger.commit({ runId: "r2", tenantId: "tenant-a", units: 1 });
    ledger.commit({ runId: "r3", tenantId: "tenant-b", units: 3 });

    expect(ledger.activeUnits("tenant-a")).toBe(3);
    expect(ledger.activeUnits("tenant-b")).toBe(3);

    ledger.settle({ runId: "r2", reason: "COMPLETED" });
    expect(ledger.activeUnits("tenant-a")).toBe(2);
    expect(ledger.settledTotalUnits("tenant-a")).toBe(1);
    expect(ledger.settledTotalUnits("tenant-b")).toBe(null); // 尚未结算

    ledger.settle({ runId: "r3", reason: "LOST" });
    expect(ledger.activeUnits("tenant-b")).toBe(0);
    expect(ledger.settledTotalUnits("tenant-b")).toBe(3);
});

test("账本：同一 run 重复 commit 被拒绝", () => {
    const ledger = new MemoryResourceLedger();
    ledger.commit({ runId: "r1", tenantId: "tenant-a" });
    expect(() => ledger.commit({ runId: "r1", tenantId: "tenant-a" }))
        .toThrow(/已在账本/);
});

test("LedgerBudgetUsage：可用单位 = min(fairShare, max) - 当前用量", () => {
    const ledger = new MemoryResourceLedger();
    const usage = new LedgerBudgetUsage(ledger, budgets, CAPACITY, weights);
    // tenant-a fair share 6, max 8 -> ceiling 6, used 0 -> 6 可用
    expect(usage.availableUnits("tenant-a")).toBe(6);

    ledger.commit({ runId: "r1", tenantId: "tenant-a", units: 5 });
    expect(usage.availableUnits("tenant-a")).toBe(1);
});

test("BudgetAwareExecutionPolicy：预算未超时保持基础 START", () => {
    const ledger = new MemoryResourceLedger();
    const usage = new LedgerBudgetUsage(ledger, budgets, CAPACITY, weights);
    const policy = new BudgetAwareExecutionPolicy(
        new DeterministicExecutionPolicy({ maxActiveRuns: 5 }),
        usage,
    );
    ledger.commit({ runId: "r1", tenantId: "tenant-a", units: 4 }); // used 4, avail 2
    const decision = policy.decide(makeInput());
    expect(decision.action).toBe("START");
    expect(decision.reasonCode).toBe("RESOURCE_NORMAL");
});

test("BudgetAwareExecutionPolicy：预算耗尽时 START 降级为 QUEUE", () => {
    const ledger = new MemoryResourceLedger();
    const usage = new LedgerBudgetUsage(ledger, budgets, CAPACITY, weights);
    const policy = new BudgetAwareExecutionPolicy(
        new DeterministicExecutionPolicy({ maxActiveRuns: 5 }),
        usage,
    );
    ledger.commit({ runId: "r1", tenantId: "tenant-a", units: 6 }); // used 6 == ceiling 6
    const decision = policy.decide(makeInput());
    expect(decision.action).toBe("QUEUE");
    expect(decision.reasonCode).toBe("TENANT_BUDGET_EXCEEDED");
});

test("BudgetAwareExecutionPolicy：基础策略本就 QUEUE 时保持 QUEUE（不叠加预算）", () => {
    const ledger = new MemoryResourceLedger();
    const usage = new LedgerBudgetUsage(ledger, budgets, CAPACITY, weights);
    const policy = new BudgetAwareExecutionPolicy(
        new DeterministicExecutionPolicy({ maxActiveRuns: 5 }),
        usage,
    );
    const decision = policy.decide(makeInput({
        classification: { pressure: "CRITICAL", snapshotId: "snap" },
    }));
    expect(decision.action).toBe("QUEUE");
    expect(decision.reasonCode).toBe("RESOURCE_CRITICAL");
});

test("结算后预算释放：租户又能启动", () => {
    const ledger = new MemoryResourceLedger();
    const usage = new LedgerBudgetUsage(ledger, budgets, CAPACITY, weights);
    const policy = new BudgetAwareExecutionPolicy(
        new DeterministicExecutionPolicy({ maxActiveRuns: 5 }),
        usage,
    );
    ledger.commit({ runId: "r1", tenantId: "tenant-a", units: 6 });
    expect(policy.decide(makeInput()).action).toBe("QUEUE");

    ledger.settle({ runId: "r1", reason: "COMPLETED" });
    expect(policy.decide(makeInput()).action).toBe("START");
});
