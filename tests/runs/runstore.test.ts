import { expect, test } from "bun:test";

import type {
    AgentRun,
    RunEvent,
    RunEventType,
} from "../../src/runs/agent-run.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

const createdAt = "2026-07-25T10:00:00.000Z";

function createQueuedRun(runId = "run-1"): AgentRun {
    return {
        id: runId,
        tenantId: "tenant-1",
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

test("create 会原子地保存 Run 和第一条事件", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);

    try {
        const run = createQueuedRun();
        const initialEvent = createEvent(
            run.id,
            1,
            "RUN_CREATED",
            { source: "test" },
        );

        store.create(run, initialEvent);

        expect(store.get(run.id)).toEqual(run);
        expect(store.listEvents(run.id)).toEqual([initialEvent]);
    } finally {
        db.close();
    }
});

test("appendEvent 保存 JSON payload，listEvents 按 sequence 排序", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);

    try {
        const run = createQueuedRun();
        const firstEvent = createEvent(run.id, 1, "RUN_CREATED");
        const secondEvent = createEvent(
            run.id,
            2,
            "MODEL_STARTED",
            { model: "fake-model" },
        );
        const thirdEvent = createEvent(
            run.id,
            3,
            "MODEL_COMPLETED",
            { outputTokens: 12 },
        );

        store.create(run, firstEvent);

        // 故意先插入 sequence 3，再插入 sequence 2。
        // listEvents 必须依靠 sequence，而不是插入先后顺序返回事件。
        store.appendEvent(thirdEvent);
        store.appendEvent(secondEvent);

        expect(store.listEvents(run.id)).toEqual([
            firstEvent,
            secondEvent,
            thirdEvent,
        ]);
        expect(store.getLastEventSequence(run.id)).toBe(3);
    } finally {
        db.close();
    }
});

test("update 会同时更新 Run 状态并追加对应事件", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);

    try {
        const queuedRun = createQueuedRun();
        const createdEvent = createEvent(
            queuedRun.id,
            1,
            "RUN_CREATED",
        );
        store.create(queuedRun, createdEvent);

        const runningRun: AgentRun = {
            ...queuedRun,
            status: "RUNNING",
            updatedAt: "2026-07-25T10:01:00.000Z",
            startedAt: "2026-07-25T10:01:00.000Z",
        };
        const startedEvent = createEvent(
            runningRun.id,
            2,
            "RUN_STARTED",
        );

        store.update(runningRun, startedEvent);

        expect(store.get(runningRun.id)).toEqual(runningRun);
        expect(store.listEvents(runningRun.id)).toEqual([
            createdEvent,
            startedEvent,
        ]);
    } finally {
        db.close();
    }
});

test("追加事件失败时 update 会回滚 Run 状态", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);

    try {
        const queuedRun = createQueuedRun();
        store.create(
            queuedRun,
            createEvent(queuedRun.id, 1, "RUN_CREATED"),
        );

        const runningRun: AgentRun = {
            ...queuedRun,
            status: "RUNNING",
            updatedAt: "2026-07-25T10:01:00.000Z",
            startedAt: "2026-07-25T10:01:00.000Z",
        };

        // sequence 1 已经存在。UPDATE 会先执行，但事件 INSERT 会违反
        // UNIQUE(run_id, sequence)，整个事务随后必须回滚。
        const duplicateSequenceEvent: RunEvent = {
            ...createEvent(runningRun.id, 1, "RUN_STARTED"),
            eventId: "another-event-id",
        };

        expect(() => {
            store.update(runningRun, duplicateSequenceEvent);
        }).toThrow();

        expect(store.get(queuedRun.id)?.status).toBe("QUEUED");
        expect(store.listEvents(queuedRun.id)).toHaveLength(1);
    } finally {
        db.close();
    }
});

test("appendEventIfNew 只忽略相同 dedupe key 的重复事实", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);

    try {
        const run = createQueuedRun();
        store.create(
            run,
            createEvent(run.id, 1, "RUN_CREATED"),
        );

        const toolStarted = {
            ...createEvent(run.id, 2, "TOOL_STARTED"),
            dedupeKey: "tool:call-1:started",
        };

        expect(store.appendEventIfNew(toolStarted)).toBe(true);

        const duplicateDelivery = {
            ...toolStarted,
            eventId: "duplicate-delivery-event",
            sequence: 3,
        };

        expect(
            store.appendEventIfNew(duplicateDelivery),
        ).toBe(false);

        expect(
            store.listEvents(run.id).map((event) => event.sequence),
        ).toEqual([
            1,
            2,
        ]);

        const conflictingSequence = {
            ...createEvent(run.id, 2, "MODEL_STARTED"),
            dedupeKey: "model:model-call-1:started",
        };

        expect(() => {
            store.appendEventIfNew(conflictingSequence);
        }).toThrow();
    } finally {
        db.close();
    }
});
