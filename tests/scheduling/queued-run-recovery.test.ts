import { expect, test } from "bun:test";

import type { Checkpoint } from "../../src/checkpoints/checkpoint.ts";
import { CheckpointStore } from "../../src/checkpoints/checkpoint-store.ts";
import type {
    AgentRun,
    RunEvent,
} from "../../src/runs/agent-run.ts";
import {
    buildRecoveryContinuationInput,
    type ResumeRunInput,
} from "../../src/runs/run-service.ts";
import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import { ToolExecutionStore } from "../../src/tools/tool-execution-store.ts";
import {
    QueuedRunRecoveryService,
} from "../../src/scheduling/queued-run-recovery-service.ts";
import {
    openHarnessDatabase,
} from "../../src/storage/database.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";

/**
 * B3：启动恢复重建 ResumeRunInput 时，续跑输入必须携带原始任务语境
 * 与恢复点标识，而不是一句"请从恢复点继续完成任务"的空泛指令。
 */
test("QueuedRunRecoveryService 重建恢复输入时携带原始任务与 Checkpoint", () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const store = new RunStore(db);
        const checkpointStore = new CheckpointStore(db);
        const runService = new RunService(store, new FakeAgentRuntime());

        // 经真实事务边界写一个 Checkpoint（工具执行成功即产生恢复点）。
        const toolExecutionStore = new ToolExecutionStore(db);
        const createdAt = new Date().toISOString();

        const run = runService.createQueuedRun({
            tenantId:"tenant-a",
            harnessSessionId:"session-a",
            userInput:"先读取 README，然后总结其中的部署步骤",
            workspacePath:"/tmp/ws-a",
        });

        const execution = {
            id:"pe-1",
            runId:run.id,
            toolCallId:"tc-1",
            toolName:"read",
            arguments:{ path:"README.md" },
            effect:"READ_ONLY" as const,
            status:"PREPARED" as const,
            result:null,
            errorMessage:null,
            createdAt,
            finishedAt:null,
        };
        toolExecutionStore.prepare(execution);

        const finishedAt = new Date().toISOString();
        toolExecutionStore.completeWithCheckpoint(
            {
                ...execution,
                status:"SUCCEEDED",
                result:{ content:"README content" },
                finishedAt,
            },
            {
                id:"cp-1",
                runId:run.id,
                toolExecutionId:execution.id,
                runtimeSessionRef:"/tmp/session-a.jsonl",
                lastEventSequence:1,
                createdAt:finishedAt,
            } satisfies Checkpoint,
        );

        // 追加 AUTO_RECOVERY 的 RUN_QUEUED 事件（恢复器据此识别恢复任务）。
        store.appendEvent({
            eventId:crypto.randomUUID(),
            runId:run.id,
            sequence:store.getLastEventSequence(run.id) + 1,
            type:"RUN_QUEUED",
            timestamp:finishedAt,
            payloadVersion:1,
            payload:{
                reason:"AUTO_RECOVERY",
                checkpointId:"cp-1",
            },
        } satisfies RunEvent);

        // 对照组：普通排队 Run（无恢复语义）。
        const plainRun = runService.createQueuedRun({
            tenantId:"tenant-a",
            harnessSessionId:"session-a",
            userInput:"全新任务",
            workspacePath:"/tmp/ws-a",
        });

        const queuedRuns:AgentRun[] = [];
        const resumedInputs:ResumeRunInput[] = [];
        const restorer = new QueuedRunRecoveryService(
            store,
            checkpointStore,
            {
                restoreQueuedRun:(queued) => {
                    queuedRuns.push(queued);
                    return queued;
                },
                restoreQueuedResume:(queued, input) => {
                    resumedInputs.push(input);
                    queuedRuns.push(queued);
                    return queued;
                },
            },
        );

        restorer.restore();

        expect(queuedRuns.map((queued) => queued.id).sort()).toEqual(
            [run.id, plainRun.id].sort(),
        );
        expect(resumedInputs).toHaveLength(1);
        expect(resumedInputs[0]!.checkpoint.id).toBe("cp-1");
        expect(resumedInputs[0]!.continuationInput).toBe(
            buildRecoveryContinuationInput(run.userInput, "cp-1"),
        );
        expect(resumedInputs[0]!.continuationInput).toContain(run.userInput);
        expect(resumedInputs[0]!.continuationInput).not.toBe("请从恢复点继续完成任务");
    } finally {
        db.close();
    }
});
