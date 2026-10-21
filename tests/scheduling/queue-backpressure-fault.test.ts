import { expect, test } from "bun:test";

import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import type {
    AgentRuntime,
    RuntimeEvent,
    RuntimeEventHandler,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "../../src/runtime/agent-runtime.ts";
import { QueueBackpressureError } from "../../src/scheduling/run-scheduler.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

/**
 * §9.9 v1.5 Phase 5 F5：队列深度 backpressure 时提交被拒绝且不落库。
 */

/** start/resume 会一直挂住，直到 release()，用于占住并发 slot。 */
class GatedRuntime implements AgentRuntime {
    private readonly handlers = new Map<string, Set<RuntimeEventHandler>>();
    private readonly gate: Promise<void>;
    private openGate: () => void = () => undefined;

    readonly startRequests: RuntimeStartRequest[] = [];

    constructor() {
        this.gate = new Promise<void>((resolve) => {
            this.openGate = resolve;
        });
    }

    subscribe(runId: string, handler: RuntimeEventHandler): () => void {
        const handlers = this.handlers.get(runId) ?? new Set<RuntimeEventHandler>();
        handlers.add(handler);
        this.handlers.set(runId, handlers);
        return () => {
            handlers.delete(handler);
        };
    }

    async start(request: RuntimeStartRequest): Promise<void> {
        this.startRequests.push(request);
        await this.gate;
        this.emit({
            type: "agent_completed",
            runId: request.run.runId,
            timestamp: new Date().toISOString(),
        });
    }

    async resume(request: RuntimeResumeRequest): Promise<void> {
        await this.gate;
        this.emit({
            type: "agent_completed",
            runId: request.run.runId,
            timestamp: new Date().toISOString(),
        });
    }

    async interrupt(): Promise<void> {
        return undefined;
    }

    release(): void {
        this.openGate();
    }

    private emit(event: RuntimeEvent): void {
        for (const handler of this.handlers.get(event.runId) ?? []) {
            handler(event);
        }
    }
}

test("队列深度超限的提交抛 QueueBackpressureError 且不创建 Run", async () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH: ":memory:",
        HARNESS_PUMP_INTERVAL_MS: "60000",
        HARNESS_SANDBOX_PROVIDER: "managed-local",
        HARNESS_WORKER_ISOLATION: "in-process",
        HARNESS_MAX_ACTIVE_RUNS: "1",
        HARNESS_MAX_ACTIVE_RUNS_PER_TENANT: "1",
        HARNESS_MAX_QUEUED_RUNS: "1",
    });
    const runtime = new GatedRuntime();
    const composition = await createHarnessApplication(config, {
        runtime,
    });

    try {
        await composition.application.start();
        const workspaceA = composition.workspaceService.create("tenant-fault-a", "fault-a");
        const workspaceB = composition.workspaceService.create("tenant-fault-b", "fault-b");
        const workspaceC = composition.workspaceService.create("tenant-fault-c", "fault-c");

        const runA = composition.application.submitRun({
            tenantId: "tenant-fault-a",
            harnessSessionId: "session-a",
            userInput: "占住并发 slot",
            workspacePath: workspaceA.rootPath,
        });
        for (let i = 0; i < 200; i += 1) {
            if (composition.runStore.get(runA.id)?.status === "RUNNING") {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(composition.runStore.get(runA.id)?.status).toBe("RUNNING");

        const runB = composition.application.submitRun({
            tenantId: "tenant-fault-b",
            harnessSessionId: "session-b",
            userInput: "排队等待",
            workspacePath: workspaceB.rootPath,
        });
        expect(composition.runStore.get(runB.id)?.status).toBe("QUEUED");
        expect(composition.scheduler.listQueue()).toHaveLength(1);

        expect(() => composition.application.submitRun({
            tenantId: "tenant-fault-c",
            harnessSessionId: "session-c",
            userInput: "应被 backpressure 拒绝",
            workspacePath: workspaceC.rootPath,
        })).toThrow(QueueBackpressureError);

        expect(composition.runStore.listForTenant("tenant-fault-c", 50)).toHaveLength(0);
    } finally {
        runtime.release();
        await composition.close();
    }
});
