import { expect, test } from "bun:test";

import {
    loadHarnessConfig,
} from "../../src/app/harness-config.ts";
import {
    BudgetAwareExecutionPolicy,
    SchedulerCapacityBudgetUsage,
} from "../../src/resources/budget-aware-policy.ts";
import {
    DeterministicExecutionPolicy,
} from "../../src/resources/execution-policy.ts";
import {
    TenantRunScheduler,
} from "../../src/scheduling/tenant-run-scheduler.ts";

/**
 * B7：租户预算/fair-share 接线。
 * BudgetAwareExecutionPolicy 叠加在并发策略上：基础策略放行（START）后，
 * 还要求租户当前用量 < min(fairShare, maxUnits)，否则降级为
 * QUEUE(TENANT_BUDGET_EXCEEDED)。组合根仅在显式配置租户预算时启用。
 */
const classification = {
    snapshotId: "snapshot-1",
    pressure: "NORMAL" as const,
    reasons: [] as const,
    gpuMemoryUsagePercent: 20, gpuMemoryPressurePercent: 20,
};

test("预算策略：租户占用达到 maxUnits 时 START 降级为 QUEUE(TENANT_BUDGET_EXCEEDED)", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 4,
        maxActiveRunsPerTenant: 4,
    });
    const budgets = {
        "tenant-a": { tenantId: "tenant-a", weight: 1, maxUnits: 1 },
    };
    const usage = new SchedulerCapacityBudgetUsage(
        scheduler,
        budgets,
        4,
        { "tenant-a": 1 },
    );
    const policy = new BudgetAwareExecutionPolicy(
        new DeterministicExecutionPolicy({ maxActiveRuns: 4 }),
        usage,
    );

    const baseInput = {
        runId: "run-1",
        tenantId: "tenant-a",
        classification,
        activeRunCount: 0,
        activeTenantRunCount: 0,
    };

    // 无占用：正常放行。
    expect(policy.decide(baseInput).action).toBe("START");

    // tenant-a 已真占 1 个 slot（达到 maxUnits=1）：START 降级为排队。
    //
    // N23 后契约：占用只由准入事实 `activeTenantRunCount` 表达，不再由预算层
    // 回读调度器。所以这里必须把"该租户已有 1 个在跑"写进输入——这与
    // coordinator 的计算一致：它 claim 完当前 Run 后传的是修正过的计数。
    scheduler.enqueue({ runId: "active-1", tenantId: "tenant-a", sessionId: "s1" });
    scheduler.claimNext();

    const decision = policy.decide({
        ...baseInput,
        activeRunCount: 1,
        activeTenantRunCount: 1,
    });
    expect(decision.action).toBe("QUEUE");
    expect(decision.reasonCode).toBe("TENANT_BUDGET_EXCEEDED");
});

test("预算策略：未配置预算的租户不受影响，fair-share 按权重分摊容量", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 4,
        maxActiveRunsPerTenant: 4,
    });
    const budgets = {
        "tenant-a": { tenantId: "tenant-a", weight: 3, maxUnits: 99 },
    };
    const usage = new SchedulerCapacityBudgetUsage(
        scheduler,
        budgets,
        4,
        { "tenant-a": 3 },
    );
    const policy = new BudgetAwareExecutionPolicy(
        new DeterministicExecutionPolicy({ maxActiveRuns: 4 }),
        usage,
    );

    // 未配置的 tenant-b：maxUnits=Infinity，fairShare=floor(4*1/3)=1，
    // 无占用时可放行；占满 fairShare 后被排队。
    expect(
        policy.decide({
            runId: "run-b1",
            tenantId: "tenant-b",
            classification,
            activeRunCount: 0,
            activeTenantRunCount: 0,
        }).action,
    ).toBe("START");

    scheduler.enqueue({ runId: "active-b", tenantId: "tenant-b", sessionId: "sb" });
    scheduler.claimNext();

    const decision = policy.decide({
        runId: "run-b2",
        tenantId: "tenant-b",
        classification,
        activeRunCount: 1,
        activeTenantRunCount: 1,
    });
    expect(decision.action).toBe("QUEUE");
    expect(decision.reasonCode).toBe("TENANT_BUDGET_EXCEEDED");

    // tenant-a weight=3：fairShare=4，无占用放行。
    expect(
        policy.decide({
            runId: "run-a1",
            tenantId: "tenant-a",
            classification,
            activeRunCount: 1,
            activeTenantRunCount: 0,
        }).action,
    ).toBe("START");
});

test("B7：HARNESS_TENANT_BUDGETS 配置解析——合法 JSON 进 config，非法值报错", () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "qwen3.5-4b",
        HARNESS_TENANT_BUDGETS: '{"team-a":{"weight":2,"maxUnits":8},"team-b":{"weight":1,"maxUnits":4}}',
    }, "/tmp/harness-project");

    expect(config.tenantBudgets).toEqual({
        "team-a": { tenantId: "team-a", weight: 2, maxUnits: 8 },
        "team-b": { tenantId: "team-b", weight: 1, maxUnits: 4 },
    });

    expect(() => loadHarnessConfig({
        VLLM_MODEL_ID: "qwen3.5-4b",
        HARNESS_TENANT_BUDGETS: "not-json",
    }, "/tmp/harness-project")).toThrow("HARNESS_TENANT_BUDGETS 不是合法 JSON");

    expect(() => loadHarnessConfig({
        VLLM_MODEL_ID: "qwen3.5-4b",
        HARNESS_TENANT_BUDGETS: '{"team-a":{"weight":0,"maxUnits":8}}',
    }, "/tmp/harness-project")).toThrow("weight > 0");

    // 未设置时默认空 Record = 不启用预算策略。
    const defaultConfig = loadHarnessConfig({
        VLLM_MODEL_ID: "qwen3.5-4b",
    }, "/tmp/harness-project");
    expect(defaultConfig.tenantBudgets).toEqual({});
});

/**
 * N23 回归：ceiling == 1 的租户必须能启动。
 *
 * 修复前：预算层回读调度器的 `activeTenantRunCount`，而 coordinator 在
 * `claimNext()` 之后已经把这个 Run 计入 → 同一个 Run 被算两次 →
 * `ceiling(1) - 1 = 0` → 任何 Run 都反复 QUEUE/TENANT_BUDGET_EXCEEDED 直到
 * 超时。真机表现：等权 3 租户（fairShare 各 1）全部 `admitted=false`
 * （`_contractAdmit=true` 却被改判），没有任何 Run 能 COMPLETED。
 *
 * 契约：准入用量只取一个来源——`ExecutionPolicyInput.activeTenantRunCount`
 * （coordinator 已扣掉当前正在准入的 Run）。
 */
test("N23：fairShare/maxUnits 都为 1 的租户在无占用时仍可 START", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 3,
        maxActiveRunsPerTenant: 3,
    });
    // 3 个等权租户、总容量 3 → fairShare 各 1；maxUnits=1 → ceiling 1。
    const budgets = {
        "tenant-a": { tenantId: "tenant-a", weight: 1, maxUnits: 1 },
    };
    const usage = new SchedulerCapacityBudgetUsage(
        scheduler,
        budgets,
        3,
        { "tenant-a": 1 },
    );
    const policy = new BudgetAwareExecutionPolicy(
        new DeterministicExecutionPolicy({ maxActiveRuns: 3 }),
        usage,
    );

    // 关键：调度器里确实有 1 个活跃 Run（claimNext 已计入），
    // 但准入事实说"扣掉当前 Run 后该租户占 0" → 必须放行。
    scheduler.enqueue({ runId: "in-flight", tenantId: "tenant-a", sessionId: "s" });
    scheduler.claimNext();
    expect(scheduler.getCapacity("tenant-a").activeTenantRunCount).toBe(1);

    const decision = policy.decide({
        runId: "run-new",
        tenantId: "tenant-a",
        classification,
        activeRunCount: 1,
        activeTenantRunCount: 0,
    });

    expect(decision.action).toBe("START");
    expect(decision.reasonCode).toBe("RESOURCE_NORMAL");
});

test("N23：ceiling=1 且该租户已真占 1 个时，新 Run 才降级为排队", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 3,
        maxActiveRunsPerTenant: 3,
    });
    const budgets = {
        "tenant-a": { tenantId: "tenant-a", weight: 1, maxUnits: 1 },
    };
    const usage = new SchedulerCapacityBudgetUsage(
        scheduler,
        budgets,
        3,
        { "tenant-a": 1 },
    );
    const policy = new BudgetAwareExecutionPolicy(
        new DeterministicExecutionPolicy({ maxActiveRuns: 3 }),
        usage,
    );

    // 该租户已有 1 个在跑（不是"待准入的那个"）→ 准入事实为 1 → 触顶排队。
    const decision = policy.decide({
        runId: "run-second",
        tenantId: "tenant-a",
        classification,
        activeRunCount: 1,
        activeTenantRunCount: 1,
    });
    expect(decision.action).toBe("QUEUE");
    expect(decision.reasonCode).toBe("TENANT_BUDGET_EXCEEDED");
});
