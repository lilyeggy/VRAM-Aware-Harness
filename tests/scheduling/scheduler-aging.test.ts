import { expect, test } from "bun:test";

import { TenantRunScheduler } from "../../src/scheduling/tenant-run-scheduler.ts";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");

function isoAgo(ms: number): string {
    return new Date(NOW - ms).toISOString();
}

function makeScheduler(agingMs: number | undefined) {
    return new TenantRunScheduler({
        maxActiveRuns: 10,
        maxActiveRunsPerTenant: 10,
        ...(agingMs === undefined ? {} : { agingMs }),
        now: () => NOW,
    });
}

test("N10：队首等待超过老化阈值即插队，不再死等轮转顺序", () => {
    const scheduler = makeScheduler(60_000);

    // 洪泛租户先把轮转位置占住；正常租户的 Run 已经在队列里等了 10 分钟。
    scheduler.enqueue({ runId: "flood-1", tenantId: "flood", enqueuedAt: isoAgo(1_000) });
    scheduler.enqueue({ runId: "flood-2", tenantId: "flood", enqueuedAt: isoAgo(1_000) });
    scheduler.enqueue({ runId: "normal-1", tenantId: "normal", enqueuedAt: isoAgo(600_000) });

    expect(scheduler.claimNext()?.runId).toBe("normal-1");
});

test("N10：都没超过阈值时保持纯轮转（旧行为不变）", () => {
    const scheduler = makeScheduler(60_000);

    scheduler.enqueue({ runId: "a-1", tenantId: "a", enqueuedAt: isoAgo(1_000) });
    scheduler.enqueue({ runId: "b-1", tenantId: "b", enqueuedAt: isoAgo(2_000) });

    expect(scheduler.claimNext()?.runId).toBe("a-1");
    expect(scheduler.claimNext()?.runId).toBe("b-1");
});

test("N10：老化不越过租户并发上限——己方排满时老化的 Run 也得让路", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 10,
        maxActiveRunsPerTenant: 1,
        agingMs: 60_000,
        now: () => NOW,
    });

    scheduler.enqueue({ runId: "normal-1", tenantId: "normal", enqueuedAt: isoAgo(600_000) });
    scheduler.enqueue({ runId: "normal-2", tenantId: "normal", enqueuedAt: isoAgo(600_000) });
    scheduler.enqueue({ runId: "flood-1", tenantId: "flood", enqueuedAt: isoAgo(1_000) });

    expect(scheduler.claimNext()?.runId).toBe("normal-1");
    // normal 已占满自己的 1 个 slot：normal-2 虽然严重老化也只能等，
    // 这一轮交给轮转选中的 flood。
    expect(scheduler.claimNext()?.runId).toBe("flood-1");
});

test("N10：agingMs 未配置时不启用老化（默认纯轮转）", () => {
    const scheduler = makeScheduler(undefined);

    scheduler.enqueue({ runId: "flood-1", tenantId: "flood", enqueuedAt: isoAgo(1_000) });
    scheduler.enqueue({ runId: "normal-1", tenantId: "normal", enqueuedAt: isoAgo(600_000) });

    expect(scheduler.claimNext()?.runId).toBe("flood-1");
});
