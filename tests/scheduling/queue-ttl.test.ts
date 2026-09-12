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
 * 支柱 3 一级防线：排队 TTL。
 * 任务在队列中等待超过门限仍未获得调度准入时，被安全熔断为
 * FAILED(QUEUE_TIMEOUT)，队列与并发计数同步释放。
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("排队超过 TTL 的 Run 被熔断为 FAILED(QUEUE_TIMEOUT) 并释放队列计数", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runService = new RunService(store, new FakeAgentRuntime());
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 2,
    });
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        alwaysQueueAdmission(),
        undefined,
        undefined,
        null,
        false,
        { queueTtlMs: 20 },
    );

    const run = coordinator.submit({
        tenantId: "tenant-a",
        harnessSessionId: "session-a",
        userInput: "长时间等待的任务",
        workspacePath: "/tmp/ws-a",
    });

    // 第一次 drain：TTL 未到期 → 仍排队（准入拒绝重新入队）。
    await coordinator.drain();
    expect(store.get(run.id)?.status).toBe("QUEUED");
    expect(scheduler.listQueue()).toHaveLength(1);

    // 等待超过 TTL 后再 drain：排队超时熔断。
    await sleep(60);
    await coordinator.drain();

    const failed = store.get(run.id);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.failureReason).toBe("QUEUE_TIMEOUT");
    expect(failed?.finishedAt).not.toBeNull();

    // RUN_FAILED 事件带 QUEUE_TIMEOUT 原因与等待时长证据。
    const events = store.listEvents(run.id);
    const failedEvent = events.find((e) => e.type === "RUN_FAILED");
    expect(failedEvent).toBeDefined();
    expect((failedEvent!.payload as { reason: string }).reason)
        .toBe("QUEUE_TIMEOUT");
    expect(
        (failedEvent!.payload as { waitedMs: number }).waitedMs,
    ).toBeGreaterThan(20);

    // 队列与并发计数同步释放，不留幽灵排队。
    expect(scheduler.listQueue()).toHaveLength(0);
    expect(scheduler.getCapacity("tenant-a").activeRunCount).toBe(0);
    db.close();
});

test("未超 TTL 的排队 Run 不受影响，已摘除的 Run 不再被重复熔断", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runService = new RunService(store, new FakeAgentRuntime());
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 5,
        maxActiveRunsPerTenant: 5,
    });
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        alwaysQueueAdmission(),
        undefined,
        undefined,
        null,
        false,
        { queueTtlMs: 60_000 },
    );

    coordinator.submit({
        tenantId: "tenant-b",
        harnessSessionId: "session-b",
        userInput: "还在 TTL 内的任务",
        workspacePath: "/tmp/ws-b",
    });
    await coordinator.drain();

    // TTL 未到期：保持 QUEUED，准入原因记录为 GLOBAL_CONCURRENCY_LIMIT。
    expect(scheduler.listQueue()).toHaveLength(1);
    expect(scheduler.listQueue()[0]!.reasonCode).toBe(
        "GLOBAL_CONCURRENCY_LIMIT",
    );
    expect(store.get(scheduler.listQueue()[0]!.runId)?.status).toBe("QUEUED");
    db.close();
});

test("RunService.failQueuedRun 只熔断 QUEUED Run，终态幂等返回 null", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runService = new RunService(store, new FakeAgentRuntime());

    const run = runService.createQueuedRun({
        tenantId: "tenant-c",
        harnessSessionId: "session-c",
        userInput: "直接熔断",
        workspacePath: "/tmp/ws-c",
    });

    const failed = runService.failQueuedRun(run.id, "QUEUE_TIMEOUT");
    expect(failed?.status).toBe("FAILED");
    expect(failed?.failureReason).toBe("QUEUE_TIMEOUT");

    // 已是 FAILED：再次调用不产生重复事件。
    expect(runService.failQueuedRun(run.id, "QUEUE_TIMEOUT")).toBeNull();
    const failedEvents = store
        .listEvents(run.id)
        .filter((e) => e.type === "RUN_FAILED");
    expect(failedEvents).toHaveLength(1);
    db.close();
});
