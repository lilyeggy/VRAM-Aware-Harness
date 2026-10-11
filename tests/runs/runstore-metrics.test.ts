import { expect, test } from "bun:test";

import type { AgentRun, RunEvent, RunEventType } from "../../src/runs/agent-run.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

const createdAt = "2026-07-25T10:00:00.000Z";

function createQueuedRun(runId: string, tenantId = "tenant-1"): AgentRun {
    return {
        id: runId,
        tenantId,
        harnessSessionId: "session-1",
        status: "QUEUED",
        userInput: "完成测试任务",
        workspacePath: "/tmp/workspace",
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        finishedAt: null,
        checkpointId: null,
        failureReason: null,
        thinkingLevel: "off",
    };
}

function createEvent(
    runId: string,
    sequence: number,
    type: RunEventType,
    payload: unknown = {},
): RunEvent {
    return {
        eventId: `event-${runId}-${sequence}`,
        runId,
        sequence,
        type,
        timestamp: createdAt,
        payloadVersion: 1,
        payload,
    };
}

test("countByStatus 按状态汇总 Run；sandboxAcquisitionStats 区分冷热并累加耗时", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);

    try {
        const queued = createQueuedRun("run-queued");
        store.create(queued, createEvent("run-queued", 1, "RUN_CREATED"));

        const completed = createQueuedRun("run-completed");
        store.create(completed, createEvent("run-completed", 1, "RUN_CREATED"));
        store.update(
            { ...completed, status: "RUNNING", startedAt: createdAt },
            createEvent("run-completed", 2, "RUN_STARTED"),
        );
        store.update(
            { ...completed, status: "COMPLETED", startedAt: createdAt, finishedAt: createdAt },
            createEvent("run-completed", 3, "RUN_COMPLETED"),
        );

        const counts = store.countByStatus();
        expect(counts.QUEUED).toBe(1);
        expect(counts.COMPLETED).toBe(1);
        expect(counts.FAILED).toBe(0);

        store.appendEvent(createEvent("run-completed", 4, "SANDBOX_ACQUIRED", {
            durationMs: 1000,
            warmHit: true,
        }));
        store.appendEvent(createEvent("run-queued", 2, "SANDBOX_ACQUIRED", {
            durationMs: 2000,
            warmHit: false,
        }));

        const stats = store.sandboxAcquisitionStats();
        expect(stats.total).toBe(2);
        expect(stats.warm).toBe(1);
        expect(stats.cold).toBe(1);
        expect(stats.durationMsSum).toBe(3000);
    } finally {
        db.close();
    }
});
