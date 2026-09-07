import { expect, test } from "bun:test";

import {
    TenantRunScheduler,
} from "../../src/scheduling/tenant-run-scheduler.ts";

test("queue blockers distinguish global, tenant, and same-session limits", () => {
    const global = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    global.enqueue({ runId: "global-active", tenantId: "a" });
    expect(global.claimNext()?.runId).toBe("global-active");
    global.enqueue({ runId: "global-waiting", tenantId: "b" });
    expect(global.listQueueBlockers()[0]?.reasonCode)
        .toBe("GLOBAL_CONCURRENCY_LIMIT");

    const tenant = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });
    tenant.enqueue({ runId: "tenant-active", tenantId: "a" });
    expect(tenant.claimNext()?.runId).toBe("tenant-active");
    tenant.enqueue({ runId: "tenant-waiting", tenantId: "a" });
    expect(tenant.listQueueBlockers()[0]?.reasonCode)
        .toBe("TENANT_CONCURRENCY_LIMIT");

    const session = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 2,
    });
    session.enqueue({ runId: "session-active", tenantId: "a", sessionId: "s" });
    expect(session.claimNext()?.runId).toBe("session-active");
    session.enqueue({ runId: "session-waiting", tenantId: "a", sessionId: "s" });
    expect(session.listQueueBlockers()[0]?.reasonCode)
        .toBe("SESSION_SERIALIZATION");
});

test("enqueue 为新 Run 补齐默认排队事实", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });

    const queuedRun = scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
        enqueuedAt: "2026-08-02T10:00:00.000Z",
    });

    expect(queuedRun).toEqual({
        runId: "run-a1",
        tenantId: "tenant-a",
        reasonCode: "AWAITING_SCHEDULING",
        enqueuedAt: "2026-08-02T10:00:00.000Z",
    });
});

test("同一 Tenant 的 Run 按提交顺序进入自己的 FIFO", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });

    const first = scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });
    const second = scheduler.enqueue({
        runId: "run-a2",
        tenantId: "tenant-a",
        reasonCode: "GLOBAL_CONCURRENCY_LIMIT",
    });

    expect(first.runId).toBe("run-a1");
    expect(second.runId).toBe("run-a2");
    expect(second.reasonCode).toBe("GLOBAL_CONCURRENCY_LIMIT");
});

test("拒绝重复进入队列的 runId", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });

    expect(() => scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-b",
    })).toThrow("Run 已经在队列中：run-a1");
});

test("拒绝非法并发配置", () => {
    expect(() => new TenantRunScheduler({
        maxActiveRuns: 0,
        maxActiveRunsPerTenant: 1,
    })).toThrow("maxActiveRuns 必须为正整数");

    expect(() => new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 2,
    })).toThrow(
        "maxActiveRunsPerTenant 不能大于 maxActiveRuns",
    );
});

test("claimNext 在 Tenant 间轮转并遵守单 Tenant 并发上限", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 3,
        maxActiveRunsPerTenant: 1,
    });
    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });
    scheduler.enqueue({
        runId: "run-a2",
        tenantId: "tenant-a",
    });
    scheduler.enqueue({
        runId: "run-b1",
        tenantId: "tenant-b",
    });

    expect(scheduler.claimNext()?.runId).toBe("run-a1");
    expect(scheduler.claimNext()?.runId).toBe("run-b1");
    expect(scheduler.claimNext()).toBeNull();
});

test("claimNext 在全局 slot 用尽后保留其余等待 Run", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });
    scheduler.enqueue({
        runId: "run-b1",
        tenantId: "tenant-b",
    });

    expect(scheduler.claimNext()?.runId).toBe("run-a1");
    expect(scheduler.claimNext()).toBeNull();
    expect(() => scheduler.enqueue({
        runId: "run-b1",
        tenantId: "tenant-b",
    })).toThrow("Run 已经在队列中：run-b1");
});

test("同一 Conversation 的 Run 串行，不同 Conversation 仍可并行", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 3,
        maxActiveRunsPerTenant: 3,
    });
    scheduler.enqueue({ runId: "run-a1", tenantId: "tenant-a", sessionId: "conversation-a" });
    scheduler.enqueue({ runId: "run-a2", tenantId: "tenant-a", sessionId: "conversation-a" });
    scheduler.enqueue({ runId: "run-b1", tenantId: "tenant-b", sessionId: "conversation-b" });

    expect(scheduler.claimNext()?.runId).toBe("run-a1");
    expect(scheduler.claimNext()?.runId).toBe("run-b1");
    expect(scheduler.claimNext()).toBeNull();

    scheduler.release("run-a1");
    expect(scheduler.claimNext()?.runId).toBe("run-a2");
});

test("已经 claim 的 Run 不能重新入队", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });

    expect(scheduler.claimNext()?.runId).toBe("run-a1");
    expect(() => scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    })).toThrow("Run 正在执行中：run-a1");
});

test("release 幂等释放 slot，并保持 Tenant 轮转顺序", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });
    scheduler.enqueue({
        runId: "run-a2",
        tenantId: "tenant-a",
    });
    scheduler.enqueue({
        runId: "run-b1",
        tenantId: "tenant-b",
    });

    expect(scheduler.claimNext()?.runId).toBe("run-a1");
    expect(scheduler.claimNext()).toBeNull();

    expect(scheduler.release("run-a1")).toBe(true);
    expect(scheduler.release("run-a1")).toBe(false);
    expect(scheduler.claimNext()?.runId).toBe("run-b1");

    expect(scheduler.release("run-b1")).toBe(true);
    expect(scheduler.claimNext()?.runId).toBe("run-a2");
});

test("释放不存在的 Run 不会错误释放其他 Run 的 slot", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });
    scheduler.enqueue({
        runId: "run-b1",
        tenantId: "tenant-b",
    });

    expect(scheduler.claimNext()?.runId).toBe("run-a1");
    expect(scheduler.release("missing-run")).toBe(false);
    expect(scheduler.claimNext()).toBeNull();
});

test("getCapacity 反映 claim 和 release 前后的逻辑 slot 占用", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });

    expect(scheduler.getCapacity("tenant-a")).toEqual({
        activeRunCount: 0,
        activeTenantRunCount: 0,
    });

    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });
    scheduler.enqueue({
        runId: "run-b1",
        tenantId: "tenant-b",
    });

    // 仅进入等待队列不会占用 slot。
    expect(scheduler.getCapacity("tenant-a")).toEqual({
        activeRunCount: 0,
        activeTenantRunCount: 0,
    });

    expect(scheduler.claimNext()?.runId).toBe("run-a1");
    expect(scheduler.getCapacity("tenant-a")).toEqual({
        activeRunCount: 1,
        activeTenantRunCount: 1,
    });
    expect(scheduler.getCapacity("tenant-b")).toEqual({
        activeRunCount: 1,
        activeTenantRunCount: 0,
    });

    expect(scheduler.claimNext()?.runId).toBe("run-b1");
    expect(scheduler.getCapacity("tenant-b")).toEqual({
        activeRunCount: 2,
        activeTenantRunCount: 1,
    });

    expect(scheduler.release("run-a1")).toBe(true);
    expect(scheduler.getCapacity("tenant-a")).toEqual({
        activeRunCount: 1,
        activeTenantRunCount: 0,
    });
});

test("removeQueued 可以删除 Tenant FIFO 中间的等待 Run", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 3,
        maxActiveRunsPerTenant: 3,
    });
    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });
    const queuedA2 = scheduler.enqueue({
        runId: "run-a2",
        tenantId: "tenant-a",
        reasonCode: "RESOURCE_BUSY",
        enqueuedAt: "2026-08-03T10:00:00.000Z",
    });
    scheduler.enqueue({
        runId: "run-a3",
        tenantId: "tenant-a",
    });

    expect(scheduler.removeQueued("run-a2")).toEqual(queuedA2);
    expect(scheduler.claimNext()?.runId).toBe("run-a1");
    expect(scheduler.claimNext()?.runId).toBe("run-a3");
});

test("removeQueued 删除 Tenant 最后一个等待 Run 时清理轮转记录", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });
    const queuedA1 = scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });
    scheduler.enqueue({
        runId: "run-b1",
        tenantId: "tenant-b",
    });

    expect(scheduler.removeQueued("run-a1")).toEqual(queuedA1);
    expect(scheduler.claimNext()?.runId).toBe("run-b1");
    expect(scheduler.claimNext()).toBeNull();
});

test("removeQueued 不会移除 active 或不存在的 Run", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });

    expect(scheduler.claimNext()?.runId).toBe("run-a1");
    expect(scheduler.removeQueued("run-a1")).toBeNull();
    expect(scheduler.removeQueued("missing-run")).toBeNull();
    expect(scheduler.getCapacity("tenant-a")).toEqual({
        activeRunCount: 1,
        activeTenantRunCount: 1,
    });
});

test("listQueue 按 Tenant round-robin 展示全局和 Tenant 内位置", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 5,
        maxActiveRunsPerTenant: 3,
    });
    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
        enqueuedAt: "2026-08-04T10:00:01.000Z",
    });
    scheduler.enqueue({
        runId: "run-a2",
        tenantId: "tenant-a",
        enqueuedAt: "2026-08-04T10:00:02.000Z",
    });
    scheduler.enqueue({
        runId: "run-a3",
        tenantId: "tenant-a",
        enqueuedAt: "2026-08-04T10:00:03.000Z",
    });
    scheduler.enqueue({
        runId: "run-b1",
        tenantId: "tenant-b",
        reasonCode: "RESOURCE_BUSY",
        enqueuedAt: "2026-08-04T10:00:04.000Z",
    });
    scheduler.enqueue({
        runId: "run-b2",
        tenantId: "tenant-b",
        enqueuedAt: "2026-08-04T10:00:05.000Z",
    });

    expect(scheduler.listQueue().map((entry) => ({
        runId: entry.runId,
        reasonCode: entry.reasonCode,
        position: entry.position,
        tenantPosition: entry.tenantPosition,
    }))).toEqual([
        {
            runId: "run-a1",
            reasonCode: "AWAITING_SCHEDULING",
            position: 1,
            tenantPosition: 1,
        },
        {
            runId: "run-b1",
            reasonCode: "RESOURCE_BUSY",
            position: 2,
            tenantPosition: 1,
        },
        {
            runId: "run-a2",
            reasonCode: "AWAITING_SCHEDULING",
            position: 3,
            tenantPosition: 2,
        },
        {
            runId: "run-b2",
            reasonCode: "AWAITING_SCHEDULING",
            position: 4,
            tenantPosition: 2,
        },
        {
            runId: "run-a3",
            reasonCode: "AWAITING_SCHEDULING",
            position: 5,
            tenantPosition: 3,
        },
    ]);
});

test("listQueue 是只读查询，不会改变真实 claim 顺序", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });
    scheduler.enqueue({
        runId: "run-a1",
        tenantId: "tenant-a",
    });
    scheduler.enqueue({
        runId: "run-a2",
        tenantId: "tenant-a",
    });
    scheduler.enqueue({
        runId: "run-b1",
        tenantId: "tenant-b",
    });

    const firstSnapshot = scheduler.listQueue();
    const secondSnapshot = scheduler.listQueue();

    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(scheduler.claimNext()?.runId).toBe("run-a1");
    expect(scheduler.claimNext()?.runId).toBe("run-b1");
    expect(scheduler.listQueue().map((entry) => entry.runId)).toEqual([
        "run-a2",
    ]);
});

test("listQueue 在没有等待 Run 时返回空数组", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });

    expect(scheduler.listQueue()).toEqual([]);
});
