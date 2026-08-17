import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import type { Checkpoint } from "../../src/checkpoints/checkpoint.ts";
import {
    CheckpointStore,
} from "../../src/checkpoints/checkpoint-store.ts";
import {
    RecoveryService,
} from "../../src/checkpoints/recovery-service.ts";
import type {
    AgentRun,
    RunEvent,
} from "../../src/runs/agent-run.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import type {
    ToolEffect,
    ToolExecution,
} from "../../src/tools/tool-execution.ts";
import {
    ToolExecutionStore,
} from "../../src/tools/tool-execution-store.ts";

const createdAt = "2026-07-28T10:00:00.000Z";
const startedAt = "2026-07-28T10:00:01.000Z";

function seedRunningRun(db: Database): AgentRun {
    const store = new RunStore(db);
    const queuedRun: AgentRun = {
        id: "run-1",
        tenantId: "tenant-1",
        harnessSessionId: "session-1",
        status: "QUEUED",
        userInput: "分析项目",
        workspacePath: "/tmp/workspace",
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        finishedAt: null,
        checkpointId: null,
        failureReason: null,
    };
    const createdEvent: RunEvent = {
        eventId: "event-1",
        runId: queuedRun.id,
        sequence: 1,
        type: "RUN_CREATED",
        timestamp: createdAt,
        payloadVersion: 1,
        payload: {},
    };
    store.create(queuedRun, createdEvent);

    const runningRun: AgentRun = {
        ...queuedRun,
        status: "RUNNING",
        updatedAt: startedAt,
        startedAt,
    };
    store.update(runningRun, {
        eventId: "event-2",
        runId: runningRun.id,
        sequence: 2,
        type: "RUN_STARTED",
        timestamp: startedAt,
        payloadVersion: 1,
        payload: {},
    });

    return runningRun;
}

function createPreparedExecution(
    runId: string,
    id: string,
    toolCallId: string,
    effect: ToolEffect,
): ToolExecution {
    return {
        id,
        runId,
        toolCallId,
        toolName: effect === "READ_ONLY" ? "read" : "bash",
        arguments: {},
        effect,
        status: "PREPARED",
        result: null,
        errorMessage: null,
        createdAt: startedAt,
        finishedAt: null,
    };
}

function seedCheckpoint(
    store: ToolExecutionStore,
    runId: string,
): Checkpoint {
    const prepared = createPreparedExecution(
        runId,
        "completed-execution",
        "completed-tool-call",
        "READ_ONLY",
    );
    store.prepare(prepared);

    const checkpoint: Checkpoint = {
        id: "checkpoint-1",
        runId,
        toolExecutionId: prepared.id,
        runtimeSessionRef: "/tmp/pi-session.jsonl",
        lastEventSequence: 2,
        createdAt: "2026-07-28T10:00:02.000Z",
    };

    store.completeWithCheckpoint(
        {
            ...prepared,
            status: "SUCCEEDED",
            result: "first result",
            finishedAt: checkpoint.createdAt,
        },
        checkpoint,
    );

    return checkpoint;
}

test("启动扫描会中断遗留 Run 并生成自动恢复计划", () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const run = seedRunningRun(db);
        const runStore = new RunStore(db);
        const executionStore = new ToolExecutionStore(db);
        const checkpointStore = new CheckpointStore(db);
        const checkpoint = seedCheckpoint(
            executionStore,
            run.id,
        );
        const pendingRead = createPreparedExecution(
            run.id,
            "pending-read",
            "pending-read-call",
            "READ_ONLY",
        );
        executionStore.prepare(pendingRead);

        const service = new RecoveryService(
            runStore,
            executionStore,
            checkpointStore,
        );
        const plans = service.scanInterruptedRuns();

        expect(plans).toHaveLength(1);
        expect(plans[0]?.decision).toEqual({
            action: "AUTO_RESUME",
            reason: "SAFE_CHECKPOINT",
            blockingToolExecutionId: null,
        });
        expect(plans[0]?.checkpoint).toEqual(checkpoint);
        expect(plans[0]?.preparedExecutions).toEqual([
            pendingRead,
        ]);
        expect(runStore.get(run.id)?.status).toBe(
            "INTERRUPTED",
        );
        expect(runStore.listActiveRuns()).toEqual([]);

        const lastEvent = runStore.listEvents(run.id).at(-1);
        expect(lastEvent?.type).toBe("RUN_INTERRUPTED");
        expect(lastEvent?.payload).toMatchObject({
            reason: "PROCESS_RESTART",
            recoveryAction: "AUTO_RESUME",
            recoveryReason: "SAFE_CHECKPOINT",
        });
    } finally {
        db.close();
    }
});

test("危险 PREPARED 工具会阻止自动恢复", () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const run = seedRunningRun(db);
        const runStore = new RunStore(db);
        const executionStore = new ToolExecutionStore(db);
        const checkpointStore = new CheckpointStore(db);
        seedCheckpoint(executionStore, run.id);

        const pendingBash = createPreparedExecution(
            run.id,
            "pending-bash",
            "pending-bash-call",
            "UNKNOWN_EFFECT",
        );
        executionStore.prepare(pendingBash);

        const [plan] = new RecoveryService(
            runStore,
            executionStore,
            checkpointStore,
        ).scanInterruptedRuns();

        expect(plan?.decision).toEqual({
            action: "MANUAL_REVIEW",
            reason: "UNSAFE_TOOL_EFFECT",
            blockingToolExecutionId: pendingBash.id,
        });
        expect(runStore.get(run.id)?.status).toBe(
            "INTERRUPTED",
        );
    } finally {
        db.close();
    }
});
