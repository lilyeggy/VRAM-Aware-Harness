import { expect, test } from "bun:test";

import { TenantRunScheduler } from "../../src/scheduling/tenant-run-scheduler.ts";

function enqueue(
    scheduler: TenantRunScheduler,
    tenantId: string,
    count: number,
    prefix: string,
): void {
    for (let index = 0; index < count; index += 1) {
        scheduler.enqueue({ runId: `${prefix}${index}`, tenantId });
    }
}

function claimAll(scheduler: TenantRunScheduler): Record<string, number> {
    const claimed: Record<string, number> = {};

    while (true) {
        const run = scheduler.claimNext();

        if (run === null) {
            break;
        }

        claimed[run.tenantId] = (claimed[run.tenantId] ?? 0) + 1;
    }

    return claimed;
}

test("等权公平份额：单租户可以用满全局 30 个槽位", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 30,
        maxActiveRunsPerTenant: 0,
    });
    enqueue(scheduler, "tenant-a", 40, "a");

    expect(claimAll(scheduler)).toEqual({ "tenant-a": 30 });
    expect(scheduler.listQueue()).toHaveLength(10);
});

test("等权公平份额：两个租户各 15，不再被静态上限卡在 20", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 30,
        maxActiveRunsPerTenant: 0,
    });
    enqueue(scheduler, "tenant-a", 20, "a");
    enqueue(scheduler, "tenant-b", 20, "b");

    expect(claimAll(scheduler)).toEqual({ "tenant-a": 15, "tenant-b": 15 });
});

test("work-conserving 借用：一方没活时另一方可以占满全局", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 30,
        maxActiveRunsPerTenant: 0,
    });
    enqueue(scheduler, "tenant-a", 3, "a");
    enqueue(scheduler, "tenant-b", 40, "b");

    expect(claimAll(scheduler)).toEqual({ "tenant-a": 3, "tenant-b": 27 });
});

test("显式上限仍然生效：配置为正数时作为硬上限", () => {
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 30,
        maxActiveRunsPerTenant: 5,
    });
    enqueue(scheduler, "tenant-a", 20, "a");
    enqueue(scheduler, "tenant-b", 20, "b");

    expect(claimAll(scheduler)).toEqual({ "tenant-a": 5, "tenant-b": 5 });
});
