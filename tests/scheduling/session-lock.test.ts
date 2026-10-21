import { expect, test } from "bun:test";

import { TenantRunScheduler } from "../../src/scheduling/tenant-run-scheduler.ts";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");

function isoAgo(ms: number): string {
    return new Date(NOW - ms).toISOString();
}

test("会话锁：队首被同会话在跑的 Run 挡住时，同租户后面的可调度 Run 不被堵死", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 4,
        maxActiveRunsPerTenant: 2,
        now: () => NOW,
    });

    // session S1 已有一个 active Run
    scheduler.enqueue({ runId: "a-running", tenantId: "a", sessionId: "s1" });
    expect(scheduler.claimNext()?.runId).toBe("a-running");

    // 同租户排队：a1 与 active 同会话（被锁），a2 是另一个会话（可跑）
    scheduler.enqueue({ runId: "a1", tenantId: "a", sessionId: "s1" });
    scheduler.enqueue({ runId: "a2", tenantId: "a", sessionId: "s2" });
    scheduler.enqueue({ runId: "b1", tenantId: "b" });

    // 必须越过 a1 拿到 a2，而不是让位给 b1 或返回 null
    expect(scheduler.claimNext()?.runId).toBe("a2");
});

test("会话锁：同一会话同时最多一个 Run 在跑，释放后下一个才可 claim", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 4,
        maxActiveRunsPerTenant: 4,
        now: () => NOW,
    });

    scheduler.enqueue({ runId: "s1-first", tenantId: "a", sessionId: "s1" });
    scheduler.enqueue({ runId: "s1-second", tenantId: "a", sessionId: "s1" });

    expect(scheduler.claimNext()?.runId).toBe("s1-first");
    // 会话锁被占：同会话的第二条不能被 claim
    expect(scheduler.claimNext()).toBeNull();

    scheduler.release("s1-first");
    expect(scheduler.claimNext()?.runId).toBe("s1-second");
});

test("会话锁：老化不会绕过会话锁去抢同会话的 Run", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 4,
        maxActiveRunsPerTenant: 4,
        agingMs: 60_000,
        now: () => NOW,
    });

    scheduler.enqueue({ runId: "s1-running", tenantId: "a", sessionId: "s1" });
    expect(scheduler.claimNext()?.runId).toBe("s1-running");

    scheduler.enqueue({
        runId: "s1-old",
        tenantId: "a",
        sessionId: "s1",
        enqueuedAt: isoAgo(600_000),
    });

    expect(scheduler.claimNext()).toBeNull();
});
