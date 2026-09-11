import type {
    ExecutionPolicy,
    ExecutionPolicyInput,
    PolicyDecision,
} from "./execution-policy.ts";
import type { ResourceLedger } from "./resource-ledger.ts";
import type { TenantRunScheduler } from "../scheduling/tenant-run-scheduler.ts";
import {
    computeFairShareUnits,
    type TenantBudget,
} from "./tenant-budget.ts";

export interface TenantUsageResolver {
    activeUnits(tenantId: string): number;
    fairShareUnits(tenantId: string): number;
    maxUnits(tenantId: string): number;
    /** Units this tenant may still start right now (>= 0). */
    availableUnits(tenantId: string): number;
}

/**
 * Default resolver wired to the ledger + budgets. Fair share is derived from
 * weights + total capacity; the budget ceiling caps it; current active usage
 * subtracts from it.
 */
export class LedgerBudgetUsage implements TenantUsageResolver {
    constructor(
        private readonly ledger: ResourceLedger,
        private readonly budgets: Readonly<Record<string, TenantBudget>>,
        private readonly capacityUnits: number,
        private readonly weights: Readonly<Record<string, number>> = {},
    ) {}

    activeUnits(tenantId: string): number {
        return this.ledger.activeUnits(tenantId);
    }

    fairShareUnits(tenantId: string): number {
        return computeFairShareUnits({
            tenantId,
            capacityUnits: this.capacityUnits,
            weights: this.weights,
        });
    }

    maxUnits(tenantId: string): number {
        const budget = this.budgets[tenantId];
        return budget ? budget.maxUnits : Infinity;
    }

    availableUnits(tenantId: string): number {
        const used = this.activeUnits(tenantId);
        const ceiling = Math.min(this.fairShareUnits(tenantId), this.maxUnits(tenantId));
        return Math.max(0, ceiling - used);
    }
}

/**
 * B7 组合根默认用量源：直接以调度器的活跃 Run 计数为准（units/run = 1）。
 * 相比 ResourceLedger，它不需要在 Run 生命周期里另插 acquire/release 记账，
 * 用量事实与调度器强一致；将来要引入 token/GPU 分钟等更细粒度单位时，
 * 再换成 LedgerBudgetUsage + 独立账本。
 */
export class SchedulerCapacityBudgetUsage implements TenantUsageResolver {
    constructor(
        private readonly scheduler: Pick<TenantRunScheduler, "getCapacity">,
        private readonly budgets: Readonly<Record<string, TenantBudget>>,
        private readonly capacityUnits: number,
        private readonly weights: Readonly<Record<string, number>> = {},
    ) {}

    activeUnits(tenantId: string): number {
        return this.scheduler.getCapacity(tenantId).activeTenantRunCount;
    }

    fairShareUnits(tenantId: string): number {
        return computeFairShareUnits({
            tenantId,
            capacityUnits: this.capacityUnits,
            weights: this.weights,
        });
    }

    maxUnits(tenantId: string): number {
        const budget = this.budgets[tenantId];
        return budget ? budget.maxUnits : Infinity;
    }

    availableUnits(tenantId: string): number {
        const ceiling = Math.min(this.fairShareUnits(tenantId), this.maxUnits(tenantId));
        return Math.max(0, ceiling - this.activeUnits(tenantId));
    }
}

/**
 * A decorator over any existing ExecutionPolicy: keep all its logic, then iff it
 * says START, also require the budget to have room for this run. When budget is
 * exhausted the action downgrades to QUEUE with TENANT_BUDGET_EXCEEDED.
 *
 * This is opt-in composition — the base policy (DeterministicExecutionPolicy)
 * is untouched, so nothing about existing admission changes unless you swap it in.
 */
export class BudgetAwareExecutionPolicy implements ExecutionPolicy {
    constructor(
        private readonly base: ExecutionPolicy,
        private readonly usage: TenantUsageResolver,
        private readonly unitsPerRun = 1,
    ) {}

    decide(input: ExecutionPolicyInput): PolicyDecision {
        const baseline = this.base.decide(input);
        if (baseline.action !== "START") {
            return baseline;
        }
        if (this.usage.availableUnits(input.tenantId) >= this.unitsPerRun) {
            return baseline;
        }
        return {
            ...baseline,
            action: "QUEUE",
            reasonCode: "TENANT_BUDGET_EXCEEDED",
            decidedAt: new Date().toISOString(),
        };
    }
}
