import { expect, test } from "bun:test";

import {
    DeterministicExecutionPolicy,
} from "../../src/resources/execution-policy.ts";
import type {
    ExecutionPolicyInput,
} from "../../src/resources/execution-policy.ts";
import type {
    ResourcePressure,
} from "../../src/resources/resource-classifier.ts";

function createInput(
    pressure: ResourcePressure,
    overrides: Partial<ExecutionPolicyInput> = {},
): ExecutionPolicyInput {
    return {
        runId: "run-1",
        tenantId: "tenant-1",
        classification: {
            snapshotId: "snapshot-1",
            pressure,
            reasons: pressure === "NORMAL"
                ? ["WITHIN_THRESHOLDS"]
                : ["INSUFFICIENT_DATA"],
            gpuMemoryUsagePercent: null,
        },
        activeRunCount: 0,
        activeTenantRunCount: 0,
        ...overrides,
    };
}

const policy = new DeterministicExecutionPolicy({
    maxActiveRuns: 2,
});

test("NORMAL 且全局并发有空位时启动 Run", () => {
    const decision = policy.decide(createInput("NORMAL"));

    expect(decision.action).toBe("START");
    expect(decision.reasonCode).toBe("RESOURCE_NORMAL");
});

test("NORMAL 但达到全局并发上限时排队", () => {
    const decision = policy.decide(createInput("NORMAL", {
        activeRunCount: 2,
    }));

    expect(decision.action).toBe("QUEUE");
    expect(decision.reasonCode).toBe(
        "GLOBAL_CONCURRENCY_LIMIT",
    );
});

test("BUSY 时允许当前没有活跃 Run 的 Tenant 启动", () => {
    const decision = policy.decide(createInput("BUSY", {
        activeRunCount: 1,
        activeTenantRunCount: 0,
    }));

    expect(decision.action).toBe("START");
    expect(decision.reasonCode).toBe(
        "RESOURCE_BUSY_TENANT_AVAILABLE",
    );
});

test("BUSY 时同一 Tenant 已有活跃 Run 则排队", () => {
    const decision = policy.decide(createInput("BUSY", {
        activeRunCount: 1,
        activeTenantRunCount: 1,
    }));

    expect(decision.action).toBe("QUEUE");
    expect(decision.reasonCode).toBe(
        "RESOURCE_BUSY_TENANT_LIMIT",
    );
});

test("BUSY 时全局并发上限仍是不可突破的硬约束", () => {
    const decision = policy.decide(createInput("BUSY", {
        activeRunCount: 2,
        activeTenantRunCount: 0,
    }));

    expect(decision.action).toBe("QUEUE");
    expect(decision.reasonCode).toBe(
        "GLOBAL_CONCURRENCY_LIMIT",
    );
});

test("CRITICAL 无条件让新 Run 排队", () => {
    const decision = policy.decide(createInput("CRITICAL"));

    expect(decision.action).toBe("QUEUE");
    expect(decision.reasonCode).toBe("RESOURCE_CRITICAL");
});

test("UNKNOWN 采用保守策略让新 Run 排队", () => {
    const decision = policy.decide(createInput("UNKNOWN"));

    expect(decision.action).toBe("QUEUE");
    expect(decision.reasonCode).toBe("RESOURCE_UNKNOWN");
});

test("决策保留 Run、资源快照、压力和审计字段", () => {
    const decision = policy.decide(createInput("NORMAL"));

    expect(decision.runId).toBe("run-1");
    expect(decision.resourceSnapshotId).toBe("snapshot-1");
    expect(decision.pressure).toBe("NORMAL");
    expect(decision.decisionId.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(decision.decidedAt))).toBe(false);
});

test("非法全局并发配置会在启动时被拒绝", () => {
    expect(() => new DeterministicExecutionPolicy({
        maxActiveRuns: 0,
    })).toThrow("maxActiveRuns必须为正整数");
});
