import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createHarnessApplication,
} from "../app/create-harness-application.ts";
import { loadHarnessConfig } from "../app/harness-config.ts";
import { formatRunEventTimeline } from "../events/run-event-timeline.ts";
import type {
    PolicyDecision,
} from "../resources/execution-policy.ts";
import type {
    ResourceObservation,
    ResourceObserver,
    ResourceSnapshot,
} from "../resources/resource-observer.ts";
import type { AgentRun } from "../runs/agent-run.ts";
import { RunService } from "../runs/run-service.ts";
import { RunStore } from "../runs/runstore.ts";
import { openHarnessDatabase } from "../storage/database.ts";
import type {
    ToolExecution,
} from "../tools/tool-execution.ts";
import {
    ToolExecutionStore,
} from "../tools/tool-execution-store.ts";
import { DemoAgentRuntime } from "./demo-agent-runtime.ts";

class DemoResourceObserver implements ResourceObserver {
    constructor(private observation:ResourceObservation) {}

    async observe():Promise<ResourceObservation> {
        return this.observation;
    }

    setObservation(observation:ResourceObservation):void {
        this.observation = observation;
    }
}

export interface Day7DemoRunReport {
    label:string;
    run:AgentRun;
    timeline:string;
    decisions:PolicyDecision[];
}

export interface Day7FakeDemoReport {
    queueAtCritical:Array<{
        runId:string;
        tenantId:string;
        reasonCode:string;
        position:number;
    }>;
    startRunIds:string[];
    resumeRunIds:string[];
    runs:Day7DemoRunReport[];
}

export async function runDay7FakeDemo():Promise<Day7FakeDemoReport> {
    const tempDirectory = mkdtempSync(
        join(tmpdir(), "vram-aware-harness-demo-"),
    );
    const databasePath = join(tempDirectory, "harness.sqlite");

    try {
        const seeded = seedFirstProcess(databasePath);
        const runtime = new DemoAgentRuntime();
        const resourceObserver = new DemoResourceObserver({
            ok:true,
            // N5：显存压力按「同机推理服务稳态基线（默认 90%）之上的增量」度量。
            // 基线内（如 vLLM 预占的 90%）是预期稳态，不再判 CRITICAL；因此这里
            // 用一个真正把余量吃干净的 99% 快照来表达"资源紧张 → 排队"。
            snapshot:createSnapshot("demo-critical", 99),
        });
        const config = loadHarnessConfig({
            VLLM_MODEL_ID:"demo-model",
            HARNESS_DATABASE_PATH:databasePath,
            HARNESS_PUMP_INTERVAL_MS:"60000",
        });
        const composition = await createHarnessApplication(config, {
            runtime,
            resourceObserver,
        });

        try {
            await composition.application.start();
            await composition.queuePump.tick();

            const queueAtCritical = composition.application.getQueue().map(
                (entry) => ({
                    runId:entry.runId,
                    tenantId:entry.tenantId,
                    reasonCode:entry.reasonCode,
                    position:entry.position,
                }),
            );

            assertStatus(
                composition.runStore.get(seeded.recoveryRunId),
                "QUEUED",
            );
            assertStatus(
                composition.runStore.get(seeded.freshRunId),
                "QUEUED",
            );

            resourceObserver.setObservation({
                ok:true,
                snapshot:createSnapshot("demo-normal", 20),
            });
            await composition.queuePump.tick();

            const recoveryRun = requiredRun(
                composition.runStore.get(seeded.recoveryRunId),
            );
            const freshRun = requiredRun(
                composition.runStore.get(seeded.freshRunId),
            );

            assertStatus(recoveryRun, "COMPLETED");
            assertStatus(freshRun, "COMPLETED");

            return {
                queueAtCritical,
                startRunIds:runtime.startRequests.map(
                    (request) => request.run.runId,
                ),
                resumeRunIds:runtime.resumeRequests.map(
                    (request) => request.run.runId,
                ),
                runs:[
                    createRunReport(
                        "Tenant A / Checkpoint Recovery",
                        recoveryRun,
                        composition,
                    ),
                    createRunReport(
                        "Tenant B / Restored Queue",
                        freshRun,
                        composition,
                    ),
                ],
            };
        } finally {
            await composition.close();
        }
    } finally {
        rmSync(tempDirectory, { recursive:true, force:true });
    }
}

export function formatDay7FakeDemoReport(
    report:Day7FakeDemoReport,
):string {
    const lines:string[] = [
        "=== VRAM-Aware Harness / Day7 Fake Demo ===",
        "",
        "[CRITICAL] queue snapshot",
        ...report.queueAtCritical.map((entry) =>
            `${entry.position}. ${entry.tenantId} ${entry.runId} reason=${entry.reasonCode}`,
        ),
        "",
        `[NORMAL] runtime.start  -> ${report.startRunIds.join(", ")}`,
        `[NORMAL] runtime.resume -> ${report.resumeRunIds.join(", ")}`,
    ];

    for (const runReport of report.runs) {
        lines.push(
            "",
            `--- ${runReport.label} ---`,
            `run=${runReport.run.id} status=${runReport.run.status}`,
            "timeline:",
            runReport.timeline,
            "policy decisions:",
            ...runReport.decisions.map((decision) => [
                decision.action,
                decision.reasonCode,
                `pressure=${decision.pressure}`,
                `snapshot=${decision.resourceSnapshotId ?? "none"}`,
            ].join(" ")),
        );
    }

    lines.push("", "RESULT: PASS");
    return lines.join("\n");
}

function seedFirstProcess(databasePath:string):{
    recoveryRunId:string;
    freshRunId:string;
} {
    const database = openHarnessDatabase(databasePath);

    try {
        const runStore = new RunStore(database);
        const runService = new RunService(
            runStore,
            new DemoAgentRuntime(),
        );
        const recoveryRun = runService.createQueuedRun({
            tenantId:"tenant-a",
            harnessSessionId:"session-a",
            userInput:"分析当前项目测试结构",
            workspacePath:"/tmp/day7-workspace-a",
        });
        const startedAt = new Date().toISOString();

        runStore.update({
            ...recoveryRun,
            status:"RUNNING",
            updatedAt:startedAt,
            startedAt,
        }, {
            eventId:crypto.randomUUID(),
            runId:recoveryRun.id,
            sequence:2,
            type:"RUN_STARTED",
            timestamp:startedAt,
            payloadVersion:1,
            payload:{},
        });

        const toolStore = new ToolExecutionStore(database);
        const prepared:ToolExecution = {
            id:"demo-tool-execution",
            runId:recoveryRun.id,
            toolCallId:"demo-tool-call",
            toolName:"read",
            arguments:{ path:"src" },
            effect:"READ_ONLY",
            status:"PREPARED",
            result:null,
            errorMessage:null,
            createdAt:new Date().toISOString(),
            finishedAt:null,
        };
        toolStore.prepare(prepared);
        const checkpoint = {
            id:"demo-checkpoint",
            runId:recoveryRun.id,
            toolExecutionId:prepared.id,
            runtimeSessionRef:"/tmp/demo-pi-session.jsonl",
            lastEventSequence:2,
            createdAt:new Date().toISOString(),
        };
        toolStore.completeWithCheckpoint({
            ...prepared,
            status:"SUCCEEDED",
            result:"demo read completed",
            finishedAt:checkpoint.createdAt,
        }, checkpoint);

        const freshRun = runService.createQueuedRun({
            tenantId:"tenant-b",
            harnessSessionId:"session-b",
            userInput:"总结 Harness 的架构边界",
            workspacePath:"/tmp/day7-workspace-b",
        });

        return {
            recoveryRunId:recoveryRun.id,
            freshRunId:freshRun.id,
        };
    } finally {
        database.close();
    }
}

function createRunReport(
    label:string,
    run:AgentRun,
    composition:Awaited<ReturnType<typeof createHarnessApplication>>,
):Day7DemoRunReport {
    return {
        label,
        run,
        timeline:formatRunEventTimeline(
            composition.runStore.listEvents(run.id),
        ),
        decisions:composition.decisionStore.listForRun(run.id),
    };
}

function createSnapshot(
    snapshotId:string,
    usedMemory:number,
):ResourceSnapshot {
    return {
        snapshotId,
        observedAt:new Date().toISOString(),
        sources:["FAKE"],
        gpuTotalMemoryMiB:100,
        gpuUsedMemoryMiB:usedMemory,
        gpuFreeMemoryMiB:100 - usedMemory,
        gpuUtilizationPercent:usedMemory,
        runningRequests:0,
        waitingRequests:0,
        kvCacheUsagePercent:20,
        inputTokensPerSecond:1_000,
        outputTokensPerSecond:100,
    };
}

function requiredRun(run:AgentRun | null):AgentRun {
    if (run === null) {
        throw new Error("Day7 Demo 找不到预期 Run");
    }

    return run;
}

function assertStatus(
    run:AgentRun | null,
    expectedStatus:AgentRun["status"],
):void {
    const existingRun = requiredRun(run);

    if (existingRun.status !== expectedStatus) {
        throw new Error(
            `Day7 Demo 状态不符合预期：${existingRun.id} ${existingRun.status} != ${expectedStatus}`,
        );
    }
}

if (import.meta.main) {
    const report = await runDay7FakeDemo();
    console.log(formatDay7FakeDemoReport(report));
}
