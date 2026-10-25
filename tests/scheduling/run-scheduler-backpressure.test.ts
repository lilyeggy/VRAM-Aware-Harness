import { expect, test } from "bun:test";

import { CheckpointStore } from "../../src/checkpoints/checkpoint-store.ts";
import type { RunLeaseManager } from "../../src/runs/run-lease-manager.ts";
import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import {
    QueueBackpressureError,
    RunScheduler,
} from "../../src/scheduling/run-scheduler.ts";
import { UserRunScheduler } from "../../src/scheduling/user-run-scheduler.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";

function createCoordinator(options: {
    maxQueuedRuns?: number;
    maxQueuedRunsPerUser?: number;
    leaseManager?: RunLeaseManager;
}) {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const checkpointStore = new CheckpointStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new UserRunScheduler({
        maxActiveRuns: 8,
        maxActiveRunsPerUser: 8,
    });
    const coordinator = new RunScheduler(
        runService,
        scheduler,
        {
            ...options,
            runStoreForRecovery: store,
            checkpointStoreForRecovery: checkpointStore,
        },
    );
    return { db, coordinator };
}

test("全局排队深度超限时 submit 抛 QueueBackpressureError", () => {
    const { db, coordinator } = createCoordinator({ maxQueuedRuns: 1 });
    try {
        coordinator.submit({
            userId: "user-a",
            harnessSessionId: "session-a",
            userInput: "first",
            workspacePath: "/tmp/a",
        });
        expect(() => coordinator.submit({
            userId: "user-b",
            harnessSessionId: "session-b",
            userInput: "second",
            workspacePath: "/tmp/b",
        })).toThrow(QueueBackpressureError);
    } finally {
        db.close();
    }
});

test("restore/tick 调用租约回收器", async () => {
    let reaped = 0;
    const leaseManager = {
        reapExpired() {
            reaped += 1;
            return [];
        },
    } as unknown as RunLeaseManager;
    const { db, coordinator } = createCoordinator({ leaseManager });
    try {
        coordinator.restore();
        expect(reaped).toBe(1);
        await coordinator.tick();
        expect(reaped).toBe(2);
    } finally {
        db.close();
    }
});

test("单用户排队深度超限时 submit 抛错，其他用户不受影响", () => {
    const { db, coordinator } = createCoordinator({
        maxQueuedRunsPerUser: 1,
    });
    try {
        coordinator.submit({
            userId: "user-a",
            harnessSessionId: "session-a1",
            userInput: "first",
            workspacePath: "/tmp/a",
        });
        expect(() => coordinator.submit({
            userId: "user-a",
            harnessSessionId: "session-a2",
            userInput: "second",
            workspacePath: "/tmp/a",
        })).toThrow(QueueBackpressureError);
        expect(() => coordinator.submit({
            userId: "user-b",
            harnessSessionId: "session-b1",
            userInput: "third",
            workspacePath: "/tmp/b",
        })).not.toThrow();
    } finally {
        db.close();
    }
});

test("Phase 3：同一幂等键重复 submit 返回既有 Run，不重复入队", () => {
    const { db, coordinator } = createCoordinator({});
    try {
        const first = coordinator.submit({
            userId: "user-a",
            harnessSessionId: "session-a",
            userInput: "幂等任务",
            workspacePath: "/tmp/a",
            idempotencyKey: "same-key",
        });
        const second = coordinator.submit({
            userId: "user-a",
            harnessSessionId: "session-a",
            userInput: "幂等任务",
            workspacePath: "/tmp/a",
            idempotencyKey: "same-key",
        });

        expect(second.id).toBe(first.id);
    } finally {
        db.close();
    }
});

test("Phase 3：幂等重放不触发队列深度 backpressure", () => {
    const { db, coordinator } = createCoordinator({ maxQueuedRuns: 1 });
    try {
        const first = coordinator.submit({
            userId: "user-a",
            harnessSessionId: "session-a",
            userInput: "幂等任务",
            workspacePath: "/tmp/a",
            idempotencyKey: "same-key",
        });
        const second = coordinator.submit({
            userId: "user-a",
            harnessSessionId: "session-a",
            userInput: "幂等任务",
            workspacePath: "/tmp/a",
            idempotencyKey: "same-key",
        });
        expect(second.id).toBe(first.id);
    } finally {
        db.close();
    }
});
