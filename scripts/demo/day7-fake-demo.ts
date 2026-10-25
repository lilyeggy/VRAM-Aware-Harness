import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createHarnessApplication,
} from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import { formatRunEventTimeline } from "../../src/events/run-event-timeline.ts";
import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import type {
    ToolExecution,
} from "../../src/tools/tool-execution.ts";
import {
    ToolExecutionStore,
} from "../../src/tools/tool-execution-store.ts";
import type { AgentRun } from "../../src/runs/agent-run.ts";
import type {
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "../../src/runtime/agent-runtime.ts";
import { DemoAgentRuntime } from "./demo-agent-runtime.ts";

/**
 * 演示用 Runtime：第一批 start/resume 停在 gate 上，用来观察并发上限
 * 造成的真实排队；release() 之后复用 DemoAgentRuntime 的正常完成路径。
 */
class GatedDemoAgentRuntime extends DemoAgentRuntime {
    private readonly gate: Promise<void>;
    private openGate: () => void = () => undefined;
    private firstInvocationResolve: () => void = () => undefined;
    private firstInvocation: Promise<void>;
    private invocationCount = 0;

    constructor() {
        super();
        this.gate = new Promise((resolve) => {
            this.openGate = resolve;
        });
        this.firstInvocation = new Promise((resolve) => {
            this.firstInvocationResolve = resolve;
        });
    }

    override async start(request: RuntimeStartRequest): Promise<void> {
        this.noteInvocation();
        await this.gate;
        await super.start(request);
    }

    override async resume(request: RuntimeResumeRequest): Promise<void> {
        this.noteInvocation();
        await this.gate;
        await super.resume(request);
    }

    waitForFirstInvocation(): Promise<void> {
        return this.firstInvocation;
    }

    release(): void {
        this.openGate();
    }

    private noteInvocation(): void {
        this.invocationCount += 1;
        if (this.invocationCount === 1) {
            this.firstInvocationResolve();
        }
    }
}

export interface Day7DemoRunReport {
    label:string;
    run:AgentRun;
    timeline:string;
    limitations:string;
}

export interface Day7FakeDemoReport {
    queueAtConcurrencyLimit:Array<{
        runId:string;
        userId:string;
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
        const runtime = new GatedDemoAgentRuntime();
        const config = loadHarnessConfig({
            VLLM_MODEL_ID:"demo-model",
            HARNESS_DATABASE_PATH:databasePath,
            // 必须与上面的临时库配对：库在临时目录、工作区却在仓库里，
            // 会让 demo 往仓库写一批无人引用的工作空间目录。
            HARNESS_WORKSPACE_ROOT:join(tempDirectory, "workspaces"),
            HARNESS_PUMP_INTERVAL_MS:"60000",
            // 用真实并发上限制造排队，替代已删除的资源压力观测。
            HARNESS_MAX_ACTIVE_RUNS:"1",
            HARNESS_MAX_ACTIVE_RUNS_PER_USER:"1",
        });
        const composition = await createHarnessApplication(config, {
            runtime,
        });

        try {
            await composition.application.start();
            await runtime.waitForFirstInvocation();

            const queueAtConcurrencyLimit = composition.application.getQueue().map(
                (entry) => ({
                    runId:entry.runId,
                    userId:entry.userId,
                    reasonCode:entry.reasonCode,
                    position:entry.position,
                }),
            );

            runtime.release();
            await waitForTerminal(composition, seeded.recoveryRunId);
            await waitForTerminal(composition, seeded.freshRunId);

            const recoveryRun = requiredRun(
                composition.runStore.get(seeded.recoveryRunId),
            );
            const freshRun = requiredRun(
                composition.runStore.get(seeded.freshRunId),
            );

            assertStatus(recoveryRun, "COMPLETED");
            assertStatus(freshRun, "COMPLETED");

            return {
                queueAtConcurrencyLimit,
                startRunIds:runtime.startRequests.map(
                    (request) => request.run.runId,
                ),
                resumeRunIds:runtime.resumeRequests.map(
                    (request) => request.run.runId,
                ),
                runs:[
                    createRunReport(
                        "User A / Checkpoint Recovery",
                        recoveryRun,
                        composition,
                    ),
                    createRunReport(
                        "User B / Restored Queue",
                        freshRun,
                        composition,
                    ),
                ],
            };
        } finally {
            runtime.release();
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
        "[CONCURRENCY LIMIT] queue snapshot",
        ...report.queueAtConcurrencyLimit.map((entry) =>
            `${entry.position}. ${entry.userId} ${entry.runId} reason=${entry.reasonCode}`,
        ),
        "",
        `[EXECUTED] runtime.start  -> ${report.startRunIds.join(", ")}`,
        `[EXECUTED] runtime.resume -> ${report.resumeRunIds.join(", ")}`,
    ];

    for (const runReport of report.runs) {
        lines.push(
            "",
            `--- ${runReport.label} ---`,
            `run=${runReport.run.id} status=${runReport.run.status}`,
            "timeline:",
            runReport.timeline,
            "limitations:",
            runReport.limitations,
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
            userId:"user-a",
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
            userId:"user-b",
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
        limitations:JSON.stringify(
            composition.application.getRunLimitations(run.id),
        ),
    };
}

async function waitForTerminal(
    composition:Awaited<ReturnType<typeof createHarnessApplication>>,
    runId:string,
):Promise<AgentRun> {
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
        const run = composition.runStore.get(runId);
        if (
            run !== null
            && (run.status === "COMPLETED"
                || run.status === "FAILED"
                || run.status === "INTERRUPTED")
        ) {
            return run;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Day7 Demo 等待 Run 终态超时：${runId}`);
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
