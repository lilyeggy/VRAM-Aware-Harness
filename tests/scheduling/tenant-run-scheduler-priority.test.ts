import { expect, test } from "bun:test";

import { TenantRunScheduler } from "../../src/scheduling/tenant-run-scheduler.ts";

test("priority>0 的 Run 跨租户优先于轮转与低优先级", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 4,
        maxActiveRunsPerTenant: 1,
    });
    scheduler.enqueue({
        runId: "low-a",
        tenantId: "a",
        enqueuedAt: "2026-08-02T10:00:00.000Z",
        priority: 0,
    });
    scheduler.enqueue({
        runId: "high-b",
        tenantId: "b",
        enqueuedAt: "2026-08-02T10:00:02.000Z",
        priority: 5,
    });
    scheduler.enqueue({
        runId: "high-c",
        tenantId: "c",
        enqueuedAt: "2026-08-02T10:00:01.000Z",
        priority: 5,
    });

    expect(scheduler.claimNext()?.runId).toBe("high-c");
    expect(scheduler.claimNext()?.runId).toBe("high-b");
    expect(scheduler.claimNext()?.runId).toBe("low-a");
});

test("同一 Tenant 内部按 priority 降序、同优先级按入队时间升序", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 4,
        maxActiveRunsPerTenant: 1,
    });
    scheduler.enqueue({
        runId: "low",
        tenantId: "a",
        enqueuedAt: "2026-08-02T10:00:00.000Z",
        priority: 0,
    });
    scheduler.enqueue({
        runId: "high-late",
        tenantId: "a",
        enqueuedAt: "2026-08-02T10:00:03.000Z",
        priority: 9,
    });
    scheduler.enqueue({
        runId: "high-early",
        tenantId: "a",
        enqueuedAt: "2026-08-02T10:00:01.000Z",
        priority: 9,
    });

    expect(scheduler.claimNext()?.runId).toBe("high-early");
});
