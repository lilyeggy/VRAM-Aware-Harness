import { expect, test } from "bun:test";

import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import type {
    PolicyAction,
    PolicyDecision,
    PolicyReasonCode,
} from "../../src/resources/execution-policy.ts";
import type {
    ResourceAdmissionEvaluator,
    ResourceAdmissionRequest,
} from "../../src/resources/resource-admission-service.ts";
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

/**
 * B4/B5：队列 DB 对账。
 * B5——claimNext 与 release+re-enqueue 之间的 TOCTOU 归档窗口会把 Run
 * 留在"DB 仍 QUEUED 但内存队列里没有"的孤儿态；reconcile 必须补回。
 * B4——TTL 熔断以 DB updatedAt 为排队时钟，重启/孤儿补回不重置等待时间。
 */
function alwaysQueueAdmission(): ResourceAdmissionEvaluator {
    return {
        async evaluate(request: ResourceAdmissionRequest) {
            const decision: PolicyDecision = {
                decisionId: `decision-${request.runId}`,
                runId: request.runId,
                action: "QUEUE" as PolicyAction,
                reasonCode: "GLOBAL_CONCURRENCY_LIMIT" as PolicyReasonCode,
                resourceSnapshotId: "snapshot-1",
                pressure: "NORMAL",
                observationFailureReason: null,
                decidedAt: new Date().toISOString(),
            };
            return {
                observation: {
                    ok: true as const,
                    snapshot: {
                        snapshotId: "snapshot-1",
                        observedAt: new Date().toISOString(),
                        sources: ["FAKE" as const],
                        gpuTotalMemoryMiB: 100,
                        gpuUsedMemoryMiB: 20,
                        gpuFreeMemoryMiB: 80,
                        gpuUtilizationPercent: 20,
                        runningRequests: 0,
                        waitingRequests: 0,
                        kvCacheUsagePercent: 20,
                        inputTokensPerSecond: 1_000,
                        outputTokensPerSecond: 100,
                    },
                },
                classification: null,
                decision,
            };
        },
    };
}

function buildCoordinator(
    runService: RunService,
    scheduler: TenantRunScheduler,
    options: ConstructorParameters<typeof RunQueueCoordinator>[7],
): RunQueueCoordinator {
    return new RunQueueCoordinator(
        runService,
        scheduler,
        alwaysQueueAdmission(),
        undefined,
        undefined,
        null,
        false,
        options,
    );
}

test("B5：DB QUEUED 但脱离内存队列的孤儿 Run 被 reconcile 补回，排队时钟取自 DB", () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const store = new RunStore(db);
        const runService = new RunService(store, new FakeAgentRuntime());
        const scheduler = new TenantRunScheduler({
            maxActiveRuns: 4,
            maxActiveRunsPerTenant: 4,
        });
        const coordinator = buildCoordinator(runService, scheduler, {
            queuedRunReader: store,
        });

        const inQueue = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "正常排队的任务",
            workspacePath: "/tmp/ws-a",
        });
        // 模拟 TOCTOU 孤儿：创建后从未入队（或崩溃于 claimNext 后 re-enqueue 前）。
        const orphan = runService.createQueuedRun({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "被归档窗口遗落的任务",
            workspacePath: "/tmp/ws-a",
        });
        expect(scheduler.listQueue().map((e) => e.runId)).toEqual([inQueue.id]);

        const result = coordinator.reconcileQueuedRuns();
        expect(result.requeued).toEqual([orphan.id]);
        expect(result.timedOut).toEqual([]);

        // 入队后排队时钟 = DB updatedAt，不是 reconcile 时刻。
        const entry = scheduler.listQueue().find((e) => e.runId === orphan.id);
        expect(entry?.enqueuedAt).toBe(orphan.updatedAt);
        expect(scheduler.listQueue()).toHaveLength(2);
    } finally {
        db.close();
    }
});

test("B4：重启后 DB 侧等待超 TTL 的 QUEUED Run 被 reconcile 熔断，不重置 TTL 时钟", () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const store = new RunStore(db);
        const runService = new RunService(store, new FakeAgentRuntime());
        const scheduler = new TenantRunScheduler({
            maxActiveRuns: 4,
            maxActiveRunsPerTenant: 4,
        });
        const queueTtlMs = 60_000;
        const coordinator = buildCoordinator(runService, scheduler, {
            queueTtlMs,
            queuedRunReader: store,
        });

        const run = runService.createQueuedRun({
            tenantId: "tenant-b",
            harnessSessionId: "session-b",
            userInput: "重启前就在排队的任务",
            workspacePath: "/tmp/ws-b",
        });

        // 模拟进程重启：时钟推进到排队时刻 + TTL + 1ms 后才第一次 reconcile。
        const restartedNow = Date.parse(run.updatedAt) + queueTtlMs + 1;
        const coordinatorAfterRestart = buildCoordinator(runService, scheduler, {
            queueTtlMs,
            now: () => restartedNow,
            queuedRunReader: store,
        });

        const result = coordinatorAfterRestart.reconcileQueuedRuns();
        expect(result.timedOut).toEqual([run.id]);
        expect(result.requeued).toEqual([]);

        const failed = store.get(run.id);
        expect(failed?.status).toBe("FAILED");
        expect(failed?.failureReason).toBe("QUEUE_TIMEOUT");
        // 孤儿熔断后内存队列同样干净。
        expect(scheduler.listQueue()).toHaveLength(0);
    } finally {
        db.close();
    }
});

test("B5：内存队列与 DB 一致时 reconcile 不产生任何动作", () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const store = new RunStore(db);
        const runService = new RunService(store, new FakeAgentRuntime());
        const scheduler = new TenantRunScheduler({
            maxActiveRuns: 4,
            maxActiveRunsPerTenant: 4,
        });
        const coordinator = buildCoordinator(runService, scheduler, {
            queueTtlMs: 60_000,
            queuedRunReader: store,
        });

        coordinator.submit({
            tenantId: "tenant-c",
            harnessSessionId: "session-c",
            userInput: "一致状态的任务",
            workspacePath: "/tmp/ws-c",
        });

        const result = coordinator.reconcileQueuedRuns();
        expect(result.requeued).toEqual([]);
        expect(result.timedOut).toEqual([]);
        expect(scheduler.listQueue()).toHaveLength(1);
    } finally {
        db.close();
    }
});
