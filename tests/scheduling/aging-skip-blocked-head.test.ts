import { expect, test } from "bun:test";

import { TenantRunScheduler } from "../../src/scheduling/tenant-run-scheduler.ts";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");

function isoAgo(ms: number): string {
    return new Date(NOW - ms).toISOString();
}

test("N10：老化补偿不会被队首的会话锁吃掉", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 10,
        maxActiveRunsPerTenant: 10,
        agingMs: 60_000,
        now: () => NOW,
    });

    // a 的队首 a1 与 active Run 同会话，长期不可 claim
    scheduler.enqueue({ runId: "a-active", tenantId: "a", sessionId: "s1" });
    expect(scheduler.claimNext()?.runId).toBe("a-active");

    scheduler.enqueue({
        runId: "a1-blocked",
        tenantId: "a",
        sessionId: "s1",
        enqueuedAt: isoAgo(900_000),
    });
    scheduler.enqueue({
        runId: "a2-aged",
        tenantId: "a",
        sessionId: "s2",
        enqueuedAt: isoAgo(780_000),
    });
    scheduler.enqueue({ runId: "b1", tenantId: "b", enqueuedAt: isoAgo(1_000) });

    // 必须越过被锁的队首，把老化补偿给到 a2
    expect(scheduler.claimNext()?.runId).toBe("a2-aged");
});

test("等权：入队顺序决定 FIFO，不存在优先级插队", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 10,
        maxActiveRunsPerTenant: 10,
        now: () => NOW,
    });

    scheduler.enqueue({ runId: "first", tenantId: "a", enqueuedAt: isoAgo(2_000) });
    // 即使调用方塞进 priority 字段，调度器也不认识它（等权定位）
    scheduler.enqueue({
        runId: "second",
        tenantId: "a",
        enqueuedAt: isoAgo(1_000),
        ...({ priority: 99 } as Record<string, unknown>),
    });

    expect(scheduler.claimNext()?.runId).toBe("first");
    expect(scheduler.claimNext()?.runId).toBe("second");
});
