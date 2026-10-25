import { expect, test } from "bun:test";

import { UserRunScheduler } from "../../src/scheduling/user-run-scheduler.ts";

function enqueue(
    scheduler: UserRunScheduler,
    userId: string,
    count: number,
    prefix: string,
): void {
    for (let index = 0; index < count; index += 1) {
        scheduler.enqueue({ runId: `${prefix}${index}`, userId });
    }
}

function claimAll(scheduler: UserRunScheduler): Record<string, number> {
    const claimed: Record<string, number> = {};

    while (true) {
        const run = scheduler.claimNext();

        if (run === null) {
            break;
        }

        claimed[run.userId] = (claimed[run.userId] ?? 0) + 1;
    }

    return claimed;
}

test("等权公平份额：单用户可以用满全局 30 个槽位", () => {
    const scheduler = new UserRunScheduler({
        maxActiveRuns: 30,
        maxActiveRunsPerUser: 0,
    });
    enqueue(scheduler, "user-a", 40, "a");

    expect(claimAll(scheduler)).toEqual({ "user-a": 30 });
    expect(scheduler.listQueue()).toHaveLength(10);
});

test("等权公平份额：两个用户各 15，不再被静态上限卡在 20", () => {
    const scheduler = new UserRunScheduler({
        maxActiveRuns: 30,
        maxActiveRunsPerUser: 0,
    });
    enqueue(scheduler, "user-a", 20, "a");
    enqueue(scheduler, "user-b", 20, "b");

    expect(claimAll(scheduler)).toEqual({ "user-a": 15, "user-b": 15 });
});

test("work-conserving 借用：一方没活时另一方可以占满全局", () => {
    const scheduler = new UserRunScheduler({
        maxActiveRuns: 30,
        maxActiveRunsPerUser: 0,
    });
    enqueue(scheduler, "user-a", 3, "a");
    enqueue(scheduler, "user-b", 40, "b");

    expect(claimAll(scheduler)).toEqual({ "user-a": 3, "user-b": 27 });
});

test("显式上限仍然生效：配置为正数时作为硬上限", () => {
    const scheduler = new UserRunScheduler({
        maxActiveRuns: 30,
        maxActiveRunsPerUser: 5,
    });
    enqueue(scheduler, "user-a", 20, "a");
    enqueue(scheduler, "user-b", 20, "b");

    expect(claimAll(scheduler)).toEqual({ "user-a": 5, "user-b": 5 });
});
