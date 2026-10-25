import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HarnessApplication } from "../../src/app/harness-application.ts";
import { CheckpointStore } from "../../src/checkpoints/checkpoint-store.ts";
import { RecoveryExecutor } from "../../src/checkpoints/recovery-executor.ts";
import { RecoveryService } from "../../src/checkpoints/recovery-service.ts";
import {
    RecoveryStartupCoordinator,
} from "../../src/checkpoints/recovery-startup-coordinator.ts";
import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import {
    RunScheduler,
} from "../../src/scheduling/run-scheduler.ts";
import {
    UserRunScheduler,
} from "../../src/scheduling/user-run-scheduler.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import type {
    ToolExecution,
} from "../../src/tools/tool-execution.ts";
import {
    ToolExecutionStore,
} from "../../src/tools/tool-execution-store.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";

test("Day7：重启后恢复安全 Run，并在资源恢复时自动推进全部队列", async () => {
    const tempDirectory = mkdtempSync(
        join(tmpdir(), "vram-aware-harness-day7-"),
    );
    const databasePath = join(tempDirectory, "harness.sqlite");
    let activeRunId = "";
    let queuedRunId = "";

    try {
        // 第一个进程：一个 Run 已运行到安全工具边界，另一个 Run 仍在排队。
        const firstDatabase = openHarnessDatabase(databasePath);

        try {
            const firstRunStore = new RunStore(firstDatabase);
            const firstRunService = new RunService(
                firstRunStore,
                new FakeAgentRuntime(),
            );
            const activeRun = firstRunService.createQueuedRun({
                userId:"user-a",
                harnessSessionId:"session-a",
                userInput:"分析当前项目测试结构",
                workspacePath:"/tmp/workspace-a",
            });
            activeRunId = activeRun.id;
            const startedAt = new Date().toISOString();

            firstRunStore.update({
                ...activeRun,
                status:"RUNNING",
                updatedAt:startedAt,
                startedAt,
            }, {
                eventId:crypto.randomUUID(),
                runId:activeRun.id,
                sequence:2,
                type:"RUN_STARTED",
                timestamp:startedAt,
                payloadVersion:1,
                payload:{},
            });

            const toolStore = new ToolExecutionStore(firstDatabase);
            const preparedExecution:ToolExecution = {
                id:"tool-execution-safe",
                runId:activeRun.id,
                toolCallId:"tool-call-safe",
                toolName:"read",
                arguments:{ path:"src" },
                effect:"READ_ONLY",
                status:"PREPARED",
                result:null,
                errorMessage:null,
                createdAt:new Date().toISOString(),
                finishedAt:null,
            };
            toolStore.prepare(preparedExecution);
            const checkpoint = {
                id:"checkpoint-safe",
                runId:activeRun.id,
                toolExecutionId:preparedExecution.id,
                runtimeSessionRef:"/tmp/pi-session-safe.jsonl",
                lastEventSequence:2,
                createdAt:new Date().toISOString(),
            };
            toolStore.completeWithCheckpoint({
                ...preparedExecution,
                status:"SUCCEEDED",
                result:"读取完成",
                finishedAt:checkpoint.createdAt,
            }, checkpoint);

            const queuedRun = firstRunService.createQueuedRun({
                userId:"user-b",
                harnessSessionId:"session-b",
                userInput:"总结 Harness 的架构边界",
                workspacePath:"/tmp/workspace-b",
            });
            queuedRunId = queuedRun.id;
        } finally {
            firstDatabase.close();
        }

        // 第二个进程：使用全新的 Runtime、Scheduler 和 Pump 打开同一数据库。
        const database = openHarnessDatabase(databasePath);
        const runStore = new RunStore(database);
        const checkpointStore = new CheckpointStore(database);
        const toolStore = new ToolExecutionStore(database);

        const runtime = new FakeAgentRuntime();
        const runService = new RunService(runStore, runtime);
        const scheduler = new UserRunScheduler({
            maxActiveRuns:2,
            maxActiveRunsPerUser:1,
        });
        const coordinator = new RunScheduler(
            runService,
            scheduler,
            {
                runStoreForRecovery: runStore,
                checkpointStoreForRecovery: checkpointStore,
                intervalMs: 60_000,
            },
        );
        const queuePump = coordinator;
        const recoveryService = new RecoveryService(
            runStore,
            toolStore,
            checkpointStore,
        );
        const recoveryExecutor = new RecoveryExecutor(coordinator);
        const startupRecovery = new RecoveryStartupCoordinator(
            recoveryService,
            recoveryExecutor,
            coordinator,
        );
        const application = new HarnessApplication(
            coordinator,
            queuePump,
            runStore,
            scheduler,
            startupRecovery,
        );

        try {
            await application.start();
            await queuePump.tick();

            // 重启恢复：两个 QUEUED Run 都被 RecoveryStartupCoordinator 识别
            // 并重新入队（第二道资源门禁删除后，启动即会推进，不再依赖资源恢复）。
            expect(startupRecovery.getLastResults().map(
                (result) => result.status,
            )).toEqual(["QUEUED"]);

            expect(application.getRun(activeRunId)?.status).toBe(
                "COMPLETED",
            );
            expect(application.getRun(queuedRunId)?.status).toBe(
                "COMPLETED",
            );
            expect(runtime.resumeRequests.map(
                (request) => request.run.runId,
            )).toEqual([activeRunId]);
            expect(runtime.startRequests.map(
                (request) => request.run.runId,
            )).toEqual([queuedRunId]);
            const activeEvents = application.getRunEvents(activeRunId)
                .map((event) => event.type);
            expect(activeEvents).toContain("RUN_INTERRUPTED");
            expect(activeEvents).toContain("RUN_QUEUED");
            expect(activeEvents).toContain("RUN_RESUMED");
            expect(activeEvents).toContain("RUN_COMPLETED");
            expect(application.getQueue()).toEqual([]);
            expect(application.getUserCapacity("user-a")).toEqual({
                activeRunCount:0,
                activeUserRunCount:0,
            });
        } finally {
            await application.stop();
            database.close();
        }
    } finally {
        rmSync(tempDirectory, { recursive:true, force:true });
    }
});
