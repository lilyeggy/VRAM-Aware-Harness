import { expect, test } from "bun:test";

import type { AgentRun } from "../../src/runs/agent-run.ts";
import type { RunService } from "../../src/runs/run-service.ts";
import {
    RunScheduler,
} from "../../src/scheduling/run-scheduler.ts";
import { UserRunScheduler } from "../../src/scheduling/user-run-scheduler.ts";

test("Phase 3：retryAt 未到点的 QUEUED Run 不被 reconcile 重新入队", () => {
    const scheduler = new UserRunScheduler({
        maxActiveRuns: 4,
        maxActiveRunsPerUser: 4,
    });
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const run: AgentRun = {
        id: "run-retry",
        userId: "user-a",
        harnessSessionId: "session-a",
        status: "QUEUED",
        userInput: "retry later",
        workspacePath: "/tmp/a",
        createdAt: "2026-10-11T00:00:00.000Z",
        updatedAt: "2026-10-11T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        checkpointId: null,
        failureReason: null,
        retryCount: 1,
        retryAt,
    };
    const coordinator = new RunScheduler(
        {} as unknown as RunService,
        scheduler,
        {
            queuedRunReader: { listQueuedRuns: () => [run] },
        },
    );

    const result = coordinator.reconcileQueuedRuns();

    expect(result.requeued).toEqual([]);
    expect(result.timedOut).toEqual([]);
    expect(scheduler.listQueue()).toEqual([]);
});

test("Phase 3：retryAt 已过期的 QUEUED Run 会被 reconcile 重新入队", () => {
    const scheduler = new UserRunScheduler({
        maxActiveRuns: 4,
        maxActiveRunsPerUser: 4,
    });
    const run: AgentRun = {
        id: "run-retry-due",
        userId: "user-a",
        harnessSessionId: "session-a",
        status: "QUEUED",
        userInput: "retry now",
        workspacePath: "/tmp/a",
        createdAt: "2026-10-11T00:00:00.000Z",
        updatedAt: "2026-10-11T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        checkpointId: null,
        failureReason: null,
        retryCount: 1,
        retryAt: "2026-10-11T00:00:01.000Z",
    };
    const coordinator = new RunScheduler(
        {} as unknown as RunService,
        scheduler,
        {
            queuedRunReader: { listQueuedRuns: () => [run] },
        },
    );

    const result = coordinator.reconcileQueuedRuns();

    expect(result.requeued).toEqual([run.id]);
    expect(scheduler.listQueue().map((entry) => entry.runId)).toEqual([
        run.id,
    ]);
});
