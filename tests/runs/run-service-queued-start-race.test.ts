import {expect,test} from "bun:test";

import { RunService } from "../../src/runs/run-service";
import { RunStore } from "../../src/runs/runstore";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime";
import { openHarnessDatabase } from "../../src/storage/database";
import type { AgentRun, RunEvent } from "../../src/runs/agent-run";
import type { Checkpoint } from "../../src/checkpoints/checkpoint";

/**
 * A4 回归（真机 A6000 抓到）：调度器启动 QUEUED Run 与用户中断并发时，
 * QUEUED -> RUNNING 写入会撞上已落库的 INTERRUPTED（非法转换毒丸），
 * pump 每轮推进报错。启动方必须放弃启动并交还当前状态，而不是抛错。
 *
 * 竞态注入：子类 Store 在目标事件写入前，先模拟"并发中断先赢"——
 * 用真实的 QUEUED -> INTERRUPTED 写入抢跑，随后的启动/恢复写入自然
 * 撞上状态机断言。
 */
class ConcurrentInterruptStore extends RunStore {
    private fired = false;

    constructor(
        db: ReturnType<typeof openHarnessDatabase>,
        private readonly interceptEventType: RunEvent["type"],
    ) {
        super(db);
    }

    override update(run: AgentRun, event: RunEvent): void {
        if (event.type === this.interceptEventType && !this.fired) {
            this.fired = true;
            super.update(
                { ...run, status: "INTERRUPTED" },
                {
                    eventId: crypto.randomUUID(),
                    runId: run.id,
                    sequence: this.getLastEventSequence(run.id) + 1,
                    type: "RUN_INTERRUPTED",
                    timestamp: new Date().toISOString(),
                    payloadVersion: 1,
                    payload: { reason: "USER_REQUEST" },
                },
            );
        }
        super.update(run, event);
    }
}

function fabricatedCheckpoint(runId: string): Checkpoint {
    return {
        id: "cp-race-1",
        runId,
        toolExecutionId: "tool-exec-1",
        runtimeSessionRef: "pi-session://race",
        lastEventSequence: 1,
        createdAt: new Date().toISOString(),
    };
}

test("排队中被中断的 Run 调度启动时放弃执行（重入队毒丸防护）", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "排队中被打断",
            workspacePath: "/tmp/workspace",
        });

        await service.interrupt(run.id);
        expect(store.get(run.id)?.status).toBe("INTERRUPTED");

        const result = await service.executeQueuedRun(run.id);
        expect(result.status).toBe("INTERRUPTED");
        expect(runtime.startRequests).toHaveLength(0);

        const types = store.listEvents(run.id).map((event) => event.type);
        expect(types).not.toContain("RUN_STARTED");
    } finally {
        db.close();
    }
});

test("QUEUED->RUNNING 写入与并发中断竞争时放弃启动并保留中断事实", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new ConcurrentInterruptStore(db, "RUN_STARTED");
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "启动瞬间被打断",
            workspacePath: "/tmp/workspace",
        });

        const result = await service.executeQueuedRun(run.id);

        expect(result.status).toBe("INTERRUPTED");
        expect(runtime.startRequests).toHaveLength(0);
        expect(store.get(run.id)?.status).toBe("INTERRUPTED");

        const types = store.listEvents(run.id).map((event) => event.type);
        expect(types).not.toContain("RUN_STARTED");
    } finally {
        db.close();
    }
});

test("排队超时熔断（FAILED）后的调度启动同样放弃执行", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "排队超时",
            workspacePath: "/tmp/workspace",
        });

        service.failQueuedRun(run.id, "QUEUE_TIMEOUT", "排队超时");

        const result = await service.executeQueuedRun(run.id);
        expect(result.status).toBe("FAILED");
        expect(runtime.startRequests).toHaveLength(0);
    } finally {
        db.close();
    }
});

test("等待恢复执行的 QUEUED Run 被中断后，恢复启动放弃执行", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "恢复排队中被打断",
            workspacePath: "/tmp/workspace",
        });

        // 手动推进 RUNNING -> INTERRUPTED 并挂上 Checkpoint（模拟真实中断恢复前置）。
        const startedAt = new Date().toISOString();
        store.update(
            { ...store.get(run.id)!, status: "RUNNING", updatedAt: startedAt, startedAt },
            {
                eventId: crypto.randomUUID(),
                runId: run.id,
                sequence: store.getLastEventSequence(run.id) + 1,
                type: "RUN_STARTED",
                timestamp: startedAt,
                payloadVersion: 1,
                payload: {},
            },
        );
        const interruptedAt = new Date().toISOString();
        store.update(
            {
                ...store.get(run.id)!,
                status: "INTERRUPTED",
                updatedAt: interruptedAt,
                checkpointId: "cp-race-1",
            },
            {
                eventId: crypto.randomUUID(),
                runId: run.id,
                sequence: store.getLastEventSequence(run.id) + 1,
                type: "RUN_INTERRUPTED",
                timestamp: interruptedAt,
                payloadVersion: 1,
                payload: { reason: "USER_REQUEST" },
            },
        );

        const input = {
            runId: run.id,
            checkpoint: fabricatedCheckpoint(run.id),
            continuationInput: "从中断处继续",
        };

        service.queueResume(input);
        expect(store.get(run.id)?.status).toBe("QUEUED");

        // 恢复排队期间被用户再次中断。
        await service.interrupt(run.id);
        expect(store.get(run.id)?.status).toBe("INTERRUPTED");

        const result = await service.executeQueuedResume(input);
        expect(result.status).toBe("INTERRUPTED");
        expect(runtime.resumeRequests).toHaveLength(0);

        const types = store.listEvents(run.id).map((event) => event.type);
        expect(types).not.toContain("RUN_RESUMED");
    } finally {
        db.close();
    }
});

test("恢复的 QUEUED->RUNNING 写入与并发中断竞争时放弃恢复", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new ConcurrentInterruptStore(db, "RUN_RESUMED");
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "恢复瞬间被打断",
            workspacePath: "/tmp/workspace",
        });

        const startedAt = new Date().toISOString();
        store.update(
            { ...store.get(run.id)!, status: "RUNNING", updatedAt: startedAt, startedAt },
            {
                eventId: crypto.randomUUID(),
                runId: run.id,
                sequence: store.getLastEventSequence(run.id) + 1,
                type: "RUN_STARTED",
                timestamp: startedAt,
                payloadVersion: 1,
                payload: {},
            },
        );
        const interruptedAt = new Date().toISOString();
        store.update(
            {
                ...store.get(run.id)!,
                status: "INTERRUPTED",
                updatedAt: interruptedAt,
                checkpointId: "cp-race-1",
            },
            {
                eventId: crypto.randomUUID(),
                runId: run.id,
                sequence: store.getLastEventSequence(run.id) + 1,
                type: "RUN_INTERRUPTED",
                timestamp: interruptedAt,
                payloadVersion: 1,
                payload: { reason: "USER_REQUEST" },
            },
        );

        const input = {
            runId: run.id,
            checkpoint: fabricatedCheckpoint(run.id),
            continuationInput: "从中断处继续",
        };

        service.queueResume(input);

        const result = await service.executeQueuedResume(input);
        expect(result.status).toBe("INTERRUPTED");
        expect(runtime.resumeRequests).toHaveLength(0);
    } finally {
        db.close();
    }
});
