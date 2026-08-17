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
import {
    DeterministicExecutionPolicy,
} from "../../src/resources/execution-policy.ts";
import {
    PolicyDecisionStore,
} from "../../src/resources/policy-decision-store.ts";
import {
    ResourceAdmissionService,
} from "../../src/resources/resource-admission-service.ts";
import type {
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";
import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import {
    QueuedRunRecoveryService,
} from "../../src/scheduling/queued-run-recovery-service.ts";
import {
    RunQueueCoordinator,
} from "../../src/scheduling/run-queue-coordinator.ts";
import { RunQueuePump } from "../../src/scheduling/run-queue-pump.ts";
import {
    TenantRunScheduler,
} from "../../src/scheduling/tenant-run-scheduler.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import type {
    ToolExecution,
} from "../../src/tools/tool-execution.ts";
import {
    ToolExecutionStore,
} from "../../src/tools/tool-execution-store.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import {
    FakeResourceObserver,
} from "../fakes/fake-resource-observer.ts";

const thresholds = {
    busyGpuMemoryPercent: 70,
    criticalGpuMemoryPercent: 90,
    busyKvCachePercent: 60,
    criticalKvCachePercent: 85,
    busyRunningRequests: 4,
    criticalRunningRequests: 8,
    busyWaitingRequests: 1,
    criticalWaitingRequests: 4,
};

function createSnapshot(
    snapshotId:string,
    gpuUsedMemoryMiB:number,
):ResourceSnapshot {
    return {
        snapshotId,
        observedAt:new Date().toISOString(),
        sources:["FAKE"],
        gpuTotalMemoryMiB:100,
        gpuUsedMemoryMiB,
        gpuFreeMemoryMiB:100 - gpuUsedMemoryMiB,
        gpuUtilizationPercent:20,
        runningRequests:0,
        waitingRequests:0,
        kvCacheUsagePercent:20,
        inputTokensPerSecond:1_000,
        outputTokensPerSecond:100,
    };
}

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
                tenantId:"tenant-a",
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
                tenantId:"tenant-b",
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
        const decisionStore = new PolicyDecisionStore(database);
        const runtime = new FakeAgentRuntime();
        const runService = new RunService(runStore, runtime);
        const scheduler = new TenantRunScheduler({
            maxActiveRuns:2,
            maxActiveRunsPerTenant:1,
        });
        const resourceObserver = new FakeResourceObserver({
            ok:true,
            snapshot:createSnapshot("snapshot-critical", 95),
        });
        const admission = new ResourceAdmissionService(
            resourceObserver,
            thresholds,
            new DeterministicExecutionPolicy({ maxActiveRuns:2 }),
            decisionStore,
        );
        const coordinator = new RunQueueCoordinator(
            runService,
            scheduler,
            admission,
        );
        const queuePump = new RunQueuePump(coordinator, {
            intervalMs:60_000,
        });
        const recoveryService = new RecoveryService(
            runStore,
            toolStore,
            checkpointStore,
        );
        const recoveryExecutor = new RecoveryExecutor(coordinator);
        const queuedRunRestorer = new QueuedRunRecoveryService(
            runStore,
            checkpointStore,
            coordinator,
        );
        const startupRecovery = new RecoveryStartupCoordinator(
            recoveryService,
            recoveryExecutor,
            queuedRunRestorer,
        );
        const application = new HarnessApplication(
            coordinator,
            queuePump,
            runStore,
            decisionStore,
            scheduler,
            resourceObserver,
            startupRecovery,
        );

        try {
            await application.start();
            await queuePump.tick();

            expect(application.getRun(activeRunId)?.status).toBe("QUEUED");
            expect(application.getRun(queuedRunId)?.status).toBe("QUEUED");
            expect(application.getQueue()).toHaveLength(2);
            expect(runtime.startRequests).toEqual([]);
            expect(runtime.resumeRequests).toEqual([]);
            expect(startupRecovery.getLastResults().map(
                (result) => result.status,
            )).toEqual(["QUEUED"]);

            resourceObserver.setObservation({
                ok:true,
                snapshot:createSnapshot("snapshot-normal", 20),
            });
            await queuePump.tick();

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
            expect(application.getRunEvents(activeRunId).map(
                (event) => event.type,
            )).toEqual([
                "RUN_CREATED",
                "RUN_STARTED",
                "RUN_INTERRUPTED",
                "RUN_QUEUED",
                "RUN_RESUMED",
                "RUN_COMPLETED",
            ]);
            const activeDecisionActions =
                application.getRunDecisions(activeRunId).map(
                    (decision) => decision.action,
                );
            const queuedDecisionActions =
                application.getRunDecisions(queuedRunId).map(
                    (decision) => decision.action,
                );

            expect(activeDecisionActions.at(-1)).toBe("START");
            expect(activeDecisionActions.slice(0, -1).every(
                (action) => action === "QUEUE",
            )).toBe(true);
            expect(queuedDecisionActions.at(-1)).toBe("START");
            expect(queuedDecisionActions.slice(0, -1).every(
                (action) => action === "QUEUE",
            )).toBe(true);
            expect(application.getQueue()).toEqual([]);
            expect(application.getTenantCapacity("tenant-a")).toEqual({
                activeRunCount:0,
                activeTenantRunCount:0,
            });
        } finally {
            await application.stop();
            database.close();
        }
    } finally {
        rmSync(tempDirectory, { recursive:true, force:true });
    }
});
