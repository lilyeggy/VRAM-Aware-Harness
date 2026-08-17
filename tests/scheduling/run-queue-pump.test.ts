import { expect, test } from "bun:test";

import {
    ResourceAdmissionService,
} from "../../src/resources/resource-admission-service.ts";
import {
    DeterministicExecutionPolicy,
} from "../../src/resources/execution-policy.ts";
import type {
    ResourceThresholds,
} from "../../src/resources/resource-classifier.ts";
import type {
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";
import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import {
    RunQueuePump,
    type QueueDrainTarget,
} from "../../src/scheduling/run-queue-pump.ts";
import {
    RunQueueCoordinator,
} from "../../src/scheduling/run-queue-coordinator.ts";
import {
    TenantRunScheduler,
} from "../../src/scheduling/tenant-run-scheduler.ts";
import {
    openHarnessDatabase,
} from "../../src/storage/database.ts";
import {
    FakeAgentRuntime,
} from "../fakes/fake-agent-runtime.ts";
import {
    FakePolicyDecisionRecorder,
} from "../fakes/fake-policy-decision-recorder.ts";
import {
    FakeResourceObserver,
} from "../fakes/fake-resource-observer.ts";

const thresholds: ResourceThresholds = {
    busyGpuMemoryPercent: 70,
    criticalGpuMemoryPercent: 90,
    busyKvCachePercent: 60,
    criticalKvCachePercent: 85,
    busyRunningRequests: 4,
    criticalRunningRequests: 8,
    busyWaitingRequests: 1,
    criticalWaitingRequests: 4,
};

function createResourceSnapshot(
    snapshotId: string,
    gpuUsedMemoryMiB: number,
): ResourceSnapshot {
    return {
        snapshotId,
        observedAt: new Date().toISOString(),
        sources: ["FAKE"],
        gpuTotalMemoryMiB: 100,
        gpuUsedMemoryMiB,
        gpuFreeMemoryMiB: 100 - gpuUsedMemoryMiB,
        gpuUtilizationPercent: 20,
        runningRequests: 0,
        waitingRequests: 0,
        kvCacheUsagePercent: 20,
        inputTokensPerSecond: 1_000,
        outputTokensPerSecond: 100,
    };
}

test("RunQueuePump 拒绝非法轮询间隔", () => {
    const target: QueueDrainTarget = {
        async drain() {
            return [];
        },
    };

    for (const intervalMs of [0, -1, 1.5, Number.NaN]) {
        expect(() => new RunQueuePump(target, { intervalMs }))
            .toThrow("intervalMs 必须是正整数");
    }
});

test("tick 会请求一次 drain", async () => {
    let drainCallCount = 0;
    const target: QueueDrainTarget = {
        async drain() {
            drainCallCount += 1;
            return [];
        },
    };
    const pump = new RunQueuePump(target, {
        intervalMs: 1_000,
    });

    await pump.tick();

    expect(drainCallCount).toBe(1);
});

test("tick 报告 drain 错误后仍可继续下一次推进", async () => {
    const drainError = new Error("本轮 drain 失败");
    const reportedErrors: unknown[] = [];
    let drainCallCount = 0;
    const target: QueueDrainTarget = {
        async drain() {
            drainCallCount += 1;

            if (drainCallCount === 1) {
                throw drainError;
            }

            return [];
        },
    };
    const pump = new RunQueuePump(target, {
        intervalMs: 1_000,
        onError(error) {
            reportedErrors.push(error);
        },
    });

    await pump.tick();
    await pump.tick();

    expect(drainCallCount).toBe(2);
    expect(reportedErrors).toEqual([drainError]);
});

test("start 会立即请求一次 drain", () => {
    let drainCallCount = 0;
    const target: QueueDrainTarget = {
        async drain() {
            drainCallCount += 1;
            return [];
        },
    };
    const pump = new RunQueuePump(target, {
        intervalMs: 60_000,
    });

    try {
        pump.start();

        expect(drainCallCount).toBe(1);
    } finally {
        pump.stop();
    }
});

test("start 会按照配置的间隔持续请求 drain", async () => {
    let drainCallCount = 0;
    let resolveSecondDrain: (() => void) | null = null;
    const secondDrain = new Promise<void>((resolve) => {
        resolveSecondDrain = resolve;
    });
    const target: QueueDrainTarget = {
        async drain() {
            drainCallCount += 1;

            if (drainCallCount === 2) {
                resolveSecondDrain?.();
            }

            return [];
        },
    };
    const pump = new RunQueuePump(target, {
        intervalMs: 5,
    });

    try {
        pump.start();
        await secondDrain;

        expect(drainCallCount).toBeGreaterThanOrEqual(2);
    } finally {
        pump.stop();
    }
});

test("start 和 stop 幂等，停止后可以重新启动", () => {
    let drainCallCount = 0;
    const target: QueueDrainTarget = {
        async drain() {
            drainCallCount += 1;
            return [];
        },
    };
    const pump = new RunQueuePump(target, {
        intervalMs: 60_000,
    });

    pump.start();
    pump.start();

    expect(drainCallCount).toBe(1);

    pump.stop();
    pump.stop();
    pump.start();

    expect(drainCallCount).toBe(2);

    pump.stop();
});

test("资源从 CRITICAL 恢复为 NORMAL 后 Pump 自动启动排队 Run", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const observer = new FakeResourceObserver({
        ok: true,
        snapshot: createResourceSnapshot("snapshot-critical", 95),
    });
    const recorder = new FakePolicyDecisionRecorder();
    const admission = new ResourceAdmissionService(
        observer,
        thresholds,
        new DeterministicExecutionPolicy({ maxActiveRuns: 1 }),
        recorder,
    );
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );
    const run = coordinator.submit({
        tenantId: "tenant-a",
        harnessSessionId: "session-a",
        userInput: "资源恢复后自动执行",
        workspacePath: "/tmp/workspace-a",
    });
    let resolveAutomaticExecution: (() => void) | null = null;
    const automaticExecution = new Promise<void>((resolve) => {
        resolveAutomaticExecution = resolve;
    });
    const target: QueueDrainTarget = {
        async drain() {
            const results = await coordinator.drain();

            if (store.get(run.id)?.status === "COMPLETED") {
                resolveAutomaticExecution?.();
            }

            return results;
        },
    };
    const pump = new RunQueuePump(target, {
        intervalMs: 10,
    });

    try {
        pump.start();
        await pump.tick();

        expect(store.get(run.id)?.status).toBe("QUEUED");
        expect(runtime.startRequests).toEqual([]);
        expect(scheduler.listQueue()[0]?.reasonCode)
            .toBe("RESOURCE_CRITICAL");

        observer.setObservation({
            ok: true,
            snapshot: createResourceSnapshot("snapshot-normal", 20),
        });

        await automaticExecution;

        expect(store.get(run.id)?.status).toBe("COMPLETED");
        expect(runtime.startRequests).toHaveLength(1);
        expect(scheduler.listQueue()).toEqual([]);
        expect(recorder.records.map(
            (record) => record.decision.pressure,
        )).toContain("CRITICAL");
        expect(recorder.records.map(
            (record) => record.decision.pressure,
        )).toContain("NORMAL");
    } finally {
        pump.stop();
        db.close();
    }
});
