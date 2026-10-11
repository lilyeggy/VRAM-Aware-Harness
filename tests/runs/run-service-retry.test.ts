import { expect, test } from "bun:test";

import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import type {
    AgentRuntime,
    RuntimeEventHandler,
} from "../../src/runtime/agent-runtime.ts";
import { ToolExecutionStore } from "../../src/tools/tool-execution-store.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

class ThrowingRuntime implements AgentRuntime {
    startRequests = 0;

    subscribe(_runId: string, _handler: RuntimeEventHandler): () => void {
        return () => {};
    }

    async start(): Promise<void> {
        this.startRequests += 1;
        throw new Error("transient start failure");
    }

    async resume(): Promise<void> {
        throw new Error("transient resume failure");
    }

    async interrupt(): Promise<void> {}
}

function createService(
    db: ReturnType<typeof openHarnessDatabase>,
    options?: { maxAttempts?: number },
) {
    const store = new RunStore(db);
    const toolExecutions = new ToolExecutionStore(db);
    const runtime = new ThrowingRuntime();
    const service = new RunService(
        store,
        runtime,
        undefined,
        undefined,
        undefined,
        toolExecutions,
        {
            maxAttempts: options?.maxAttempts ?? 3,
            baseDelayMs: 1_000,
            maxDelayMs: 30_000,
        },
    );
    return { store, toolExecutions, runtime, service };
}

test("Phase 3：同租户幂等键返回既有 Run，跨租户互不影响", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const { service } = createService(db);
        const first = service.createQueuedRun({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "first",
            workspacePath: "/tmp/a",
            idempotencyKey: "key-1",
        });
        const second = service.createQueuedRun({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "first",
            workspacePath: "/tmp/a",
            idempotencyKey: "key-1",
        });
        expect(second.id).toBe(first.id);

        const otherTenant = service.createQueuedRun({
            tenantId: "tenant-b",
            harnessSessionId: "session-b",
            userInput: "first",
            workspacePath: "/tmp/b",
            idempotencyKey: "key-1",
        });
        expect(otherTenant.id).not.toBe(first.id);
    } finally {
        db.close();
    }
});

test("Phase 3：无副作用失败排入退避重试（RUN_QUEUED reason=RETRY）", async () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const { store, runtime, service } = createService(db);
        const run = service.createQueuedRun({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "retry me",
            workspacePath: "/tmp/a",
        });

        const result = await service.executeQueuedRun(run.id);

        expect(runtime.startRequests).toBe(1);
        expect(result.status).toBe("QUEUED");
        const stored = store.get(run.id);
        expect(stored?.retryCount).toBe(1);
        expect(stored?.retryAt).not.toBeNull();
        const events = store.listEvents(run.id);
        expect(events.map((event) => event.type)).toEqual([
            "RUN_CREATED",
            "RUN_STARTED",
            "RUN_INTERRUPTED",
            "RUN_QUEUED",
        ]);
        expect(events[3]?.payload).toMatchObject({
            reason: "RETRY",
            retryCount: 1,
            previousFailureReason: "START_FAILED",
        });
    } finally {
        db.close();
    }
});

test("Phase 3：已有 PREPARED 工具副作用时不自动重试", async () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const { store, toolExecutions, service } = createService(db);
        const run = service.createQueuedRun({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "side effect",
            workspacePath: "/tmp/a",
        });
        toolExecutions.prepare({
            id: "te-1",
            runId: run.id,
            toolCallId: "call-1",
            toolName: "bash",
            arguments: { command: "echo x" },
            effect: "IDEMPOTENT_WRITE",
            status: "PREPARED",
            result: null,
            errorMessage: null,
            createdAt: new Date().toISOString(),
            finishedAt: null,
        });

        await expect(service.executeQueuedRun(run.id)).rejects.toThrow(
            "transient start failure",
        );
        const stored = store.get(run.id);
        expect(stored?.status).toBe("INTERRUPTED");
        expect(stored?.retryCount).toBe(0);
        expect(stored?.retryAt).toBeNull();
    } finally {
        db.close();
    }
});

test("Phase 3：达到 maxAttempts 后不再重试，保持 INTERRUPTED", async () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const { store, service } = createService(db, { maxAttempts: 1 });
        const run = service.createQueuedRun({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "no retry",
            workspacePath: "/tmp/a",
        });

        await expect(service.executeQueuedRun(run.id)).rejects.toThrow(
            "transient start failure",
        );
        expect(store.get(run.id)?.status).toBe("INTERRUPTED");
        expect(store.get(run.id)?.retryCount).toBe(0);
    } finally {
        db.close();
    }
});
