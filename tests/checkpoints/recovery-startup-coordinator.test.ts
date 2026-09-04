import { expect, test } from "bun:test";

import { RecoveryStartupCoordinator } from "../../src/checkpoints/recovery-startup-coordinator.ts";

test("启动恢复严格先回收 Sandbox，再恢复队列和中断 Run", async () => {
    const order: string[] = [];
    const coordinator = new RecoveryStartupCoordinator(
        {
            scanInterruptedRuns() {
                order.push("scan-runs");
                return [];
            },
        },
        {
            async execute() {
                order.push("execute-recovery");
                return [];
            },
        },
        { restore() { order.push("restore-queue"); } },
        { async reconcile() { order.push("reconcile-sandbox"); } },
    );

    await coordinator.recover();
    expect(order).toEqual([
        "reconcile-sandbox",
        "restore-queue",
        "scan-runs",
        "execute-recovery",
    ]);
});

test("Sandbox 对账失败时不会恢复或调度任何 Run", async () => {
    const order: string[] = [];
    const coordinator = new RecoveryStartupCoordinator(
        { scanInterruptedRuns() { order.push("scan-runs"); return []; } },
        { async execute() { order.push("execute-recovery"); return []; } },
        { restore() { order.push("restore-queue"); } },
        { async reconcile() { throw new Error("orphan still running"); } },
    );
    await expect(coordinator.recover()).rejects.toThrow("orphan still running");
    expect(order).toEqual([]);
});
