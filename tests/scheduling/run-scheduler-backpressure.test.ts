import { expect, test } from "bun:test";

import { CheckpointStore } from "../../src/checkpoints/checkpoint-store.ts";
import type { RunLeaseManager } from "../../src/runs/run-lease-manager.ts";
import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import {
    QueueBackpressureError,
    RunScheduler,
} from "../../src/scheduling/run-scheduler.ts";
import { TenantRunScheduler } from "../../src/scheduling/tenant-run-scheduler.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";

function createCoordinator(options: {
    maxQueuedRuns?: number;
    maxQueuedRunsPerTenant?: number;
    leaseManager?: RunLeaseManager;
}) {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const checkpointStore = new CheckpointStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 8,
        maxActiveRunsPerTenant: 8,
    });
    const admission = {
        async evaluate() {
            throw new Error("submit 不应触发资源准入");
        },
    };
    const coordinator = new RunScheduler(
        runService,
        scheduler,
        admission,
        undefined,
        undefined,
        undefined,
        undefined,
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
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "first",
            workspacePath: "/tmp/a",
        });
        expect(() => coordinator.submit({
            tenantId: "tenant-b",
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

test("单租户排队深度超限时 submit 抛错，其他租户不受影响", () => {
    const { db, coordinator } = createCoordinator({
        maxQueuedRunsPerTenant: 1,
    });
    try {
        coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a1",
            userInput: "first",
            workspacePath: "/tmp/a",
        });
        expect(() => coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a2",
            userInput: "second",
            workspacePath: "/tmp/a",
        })).toThrow(QueueBackpressureError);
        expect(() => coordinator.submit({
            tenantId: "tenant-b",
            harnessSessionId: "session-b1",
            userInput: "third",
            workspacePath: "/tmp/b",
        })).not.toThrow();
    } finally {
        db.close();
    }
});
