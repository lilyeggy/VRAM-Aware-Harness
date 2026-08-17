import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import type { Checkpoint } from "../../src/checkpoints/checkpoint.ts";
import {
    CheckpointStore,
} from "../../src/checkpoints/checkpoint-store.ts";
import type {
    AgentRun,
    RunEvent,
} from "../../src/runs/agent-run.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import type {
    ToolExecution,
} from "../../src/tools/tool-execution.ts";
import {
    ToolExecutionStore,
} from "../../src/tools/tool-execution-store.ts";

const createdAt = "2026-07-27T10:00:00.000Z";
const finishedAt = "2026-07-27T10:00:01.000Z";

function seedRun(db: Database, runId = "run-1"): AgentRun {
    const run: AgentRun = {
        id: runId,
        tenantId: "tenant-1",
        harnessSessionId: "session-1",
        status: "RUNNING",
        userInput: "读取项目文件",
        workspacePath: "/tmp/workspace",
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt,
        finishedAt: null,
        checkpointId: null,
        failureReason: null,
    };

    const initialEvent: RunEvent = {
        eventId: `event-${runId}-1`,
        runId,
        sequence: 1,
        type: "RUN_CREATED",
        timestamp: createdAt,
        payloadVersion: 1,
        payload: {},
    };

    new RunStore(db).create(run, initialEvent);
    return run;
}

function createPreparedExecution(
    runId = "run-1",
    id = "tool-execution-1",
    toolCallId = "tool-call-1",
): ToolExecution {
    return {
        id,
        runId,
        toolCallId,
        toolName: "read",
        arguments: {
            path: "README.md",
        },
        effect: "READ_ONLY",
        status: "PREPARED",
        result: null,
        errorMessage: null,
        createdAt,
        finishedAt: null,
    };
}

function createCheckpoint(
    execution: ToolExecution,
    id = "checkpoint-1",
): Checkpoint {
    return {
        id,
        runId: execution.runId,
        toolExecutionId: execution.id,
        runtimeSessionRef: "/tmp/pi-session.jsonl",
        lastEventSequence: 3,
        createdAt: finishedAt,
    };
}

test("prepare 在执行前保存意图，并按 toolCallId 保证唯一", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new ToolExecutionStore(db);

    try {
        seedRun(db);
        const execution = createPreparedExecution();

        store.prepare(execution);

        expect(store.getById(execution.id)).toEqual(execution);
        expect(
            store.getByToolCall(
                execution.runId,
                execution.toolCallId,
            ),
        ).toEqual(execution);
        expect(store.listPrepared()).toEqual([execution]);

        expect(() => {
            store.prepare({
                ...execution,
                id: "another-execution-id",
            });
        }).toThrow();
    } finally {
        db.close();
    }
});

test("成功结果、Checkpoint 和 Run 引用在同一事务中提交", () => {
    const db = openHarnessDatabase(":memory:");
    const executionStore = new ToolExecutionStore(db);
    const checkpointStore = new CheckpointStore(db);
    const runStore = new RunStore(db);

    try {
        const run = seedRun(db);
        const prepared = createPreparedExecution(run.id);
        executionStore.prepare(prepared);

        const succeeded: ToolExecution = {
            ...prepared,
            status: "SUCCEEDED",
            result: {
                content: "file contents",
            },
            finishedAt,
        };
        const checkpoint = createCheckpoint(succeeded);

        executionStore.completeWithCheckpoint(
            succeeded,
            checkpoint,
        );

        expect(executionStore.getById(succeeded.id)).toEqual(
            succeeded,
        );
        expect(checkpointStore.get(checkpoint.id)).toEqual(
            checkpoint,
        );
        expect(
            checkpointStore.getLatestForRun(run.id),
        ).toEqual(checkpoint);
        expect(runStore.get(run.id)?.checkpointId).toBe(
            checkpoint.id,
        );
        expect(executionStore.listPrepared()).toEqual([]);
    } finally {
        db.close();
    }
});

test("Checkpoint 写入失败时会回滚工具成功状态", () => {
    const db = openHarnessDatabase(":memory:");
    const executionStore = new ToolExecutionStore(db);
    const runStore = new RunStore(db);

    try {
        const run = seedRun(db);
        const first = createPreparedExecution(run.id);
        executionStore.prepare(first);
        executionStore.completeWithCheckpoint(
            {
                ...first,
                status: "SUCCEEDED",
                result: "first result",
                finishedAt,
            },
            createCheckpoint(first),
        );

        const second = createPreparedExecution(
            run.id,
            "tool-execution-2",
            "tool-call-2",
        );
        executionStore.prepare(second);

        expect(() => {
            executionStore.completeWithCheckpoint(
                {
                    ...second,
                    status: "SUCCEEDED",
                    result: "second result",
                    finishedAt,
                },
                // 复用已经存在的 checkpoint ID，强制 INSERT 失败。
                createCheckpoint(second, "checkpoint-1"),
            );
        }).toThrow();

        expect(executionStore.getById(second.id)).toEqual(
            second,
        );
        expect(runStore.get(run.id)?.checkpointId).toBe(
            "checkpoint-1",
        );
    } finally {
        db.close();
    }
});

test("fail 只允许把 PREPARED 更新为确定失败", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new ToolExecutionStore(db);

    try {
        seedRun(db);
        const prepared = createPreparedExecution();
        store.prepare(prepared);

        const failed: ToolExecution = {
            ...prepared,
            status: "FAILED",
            errorMessage: "读取失败",
            finishedAt,
        };

        store.fail(failed);

        expect(store.getById(failed.id)).toEqual(failed);
        expect(() => store.fail(failed)).toThrow();
    } finally {
        db.close();
    }
});
