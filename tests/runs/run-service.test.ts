import {expect,test} from "bun:test";

import type { Checkpoint } from "../../src/checkpoints/checkpoint.ts";
import { RunService } from "../../src/runs/run-service";
import type {
    AgentRun,
    RunEvent,
} from "../../src/runs/agent-run.ts";
import { RunStore } from "../../src/runs/runstore";
import type {
    AgentRuntime,
    RuntimeEventHandler,
} from "../../src/runtime/agent-runtime.ts";
import { openHarnessDatabase } from "../../src/storage/database";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime";

test("createQueuedRun 只持久化 QUEUED Run，不启动 Runtime", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "等待资源后执行",
            workspacePath: "/tmp/workspace",
        });

        expect(run.status).toBe("QUEUED");
        expect(run.startedAt).toBeNull();
        expect(run.finishedAt).toBeNull();
        expect(store.get(run.id)).toEqual(run);
        expect(runtime.startRequests).toEqual([]);

        const events = store.listEvents(run.id);

        expect(events.map((event) => event.type)).toEqual([
            "RUN_CREATED",
        ]);
        expect(events.map((event) => event.sequence)).toEqual([1]);
    } finally {
        db.close();
    }
});

test("executeQueuedRun 执行持久化 Run，并接续等待期间的事件序号", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-queued",
            harnessSessionId: "session-queued",
            userInput: "执行已经通过调度的任务",
            workspacePath: "/tmp/queued-workspace",
        });
        const queuedAt = new Date().toISOString();

        // 模拟 Run 在真正获得 slot 前已经记录过一次排队事实。
        store.appendEvent({
            eventId: crypto.randomUUID(),
            runId: run.id,
            sequence: 2,
            type: "RUN_QUEUED",
            timestamp: queuedAt,
            payloadVersion: 1,
            payload: {
                reason: "RESOURCE_CRITICAL",
            },
        });

        const finalRun = await service.executeQueuedRun(run.id);

        expect(finalRun.status).toBe("COMPLETED");
        expect(runtime.startRequests).toEqual([{
            run: {
                runId: run.id,
                tenantId: "tenant-queued",
                harnessSessionId: "session-queued",
                workspacePath: "/tmp/queued-workspace",
                thinkingLevel: "off",
            },
            input: "执行已经通过调度的任务",
        }]);

        const events = store.listEvents(run.id);

        expect(events.map((event) => event.type)).toEqual([
            "RUN_CREATED",
            "RUN_QUEUED",
            "RUN_STARTED",
            "RUN_COMPLETED",
        ]);
        expect(events.map((event) => event.sequence)).toEqual([
            1,
            2,
            3,
            4,
        ]);
    } finally {
        db.close();
    }
});

test("executeQueuedRun 拒绝重复执行非 QUEUED Run", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "只允许执行一次",
            workspacePath: "/tmp/workspace",
        });

        await service.executeQueuedRun(run.id);

        await expect(
            service.executeQueuedRun(run.id),
        ).rejects.toThrow(
            `只有 QUEUED Run 可以开始执行:${run.id}`,
        );
        expect(runtime.startRequests).toHaveLength(1);
    } finally {
        db.close();
    }
});

test("Runtime 启动直接抛错时 Run 会退回 INTERRUPTED", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime: AgentRuntime = {
        subscribe() {
            return () => {};
        },
        async start() {
            throw new Error("无法启动 Runtime Session");
        },
        async resume() {},
        async interrupt() {},
    };
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "启动失败测试",
            workspacePath: "/tmp/workspace",
        });

        await expect(
            service.executeQueuedRun(run.id),
        ).rejects.toThrow("无法启动 Runtime Session");

        expect(store.get(run.id)?.status).toBe("INTERRUPTED");

        const events = store.listEvents(run.id);

        expect(events.map((event) => event.type)).toEqual([
            "RUN_CREATED",
            "RUN_STARTED",
            "RUN_INTERRUPTED",
        ]);
        expect(events[2]?.payload).toEqual({
            reason: "START_FAILED",
            message: "无法启动 Runtime Session",
        });
    } finally {
        db.close();
    }
});

test("RunService使用 Fake Runtime 完成一次完整 Run" , async () =>{
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store,runtime);

    try {
        const finalRun = await service.start({
            tenantId : "tenant-1",
            harnessSessionId:"session-1",
            userInput:"完成一个测试任务",
            workspacePath:"/tmp/workspace",
        });

        expect(finalRun.status).toBe("COMPLETED");
        expect(finalRun.startedAt).not.toBeNull();
        expect(finalRun.finishedAt).not.toBeNull();

        // 确认最终 Run 已经保存进数据库。
        expect(store.get(finalRun.id)).toEqual(finalRun);

        // 确认 RunService 调用了 Runtime，并正确传递运行上下文。
        expect(runtime.startRequests).toEqual([
            {
                run: {
                    runId: finalRun.id,
                    tenantId: "tenant-1",
                    harnessSessionId: "session-1",
                    workspacePath: "/tmp/workspace",
                    thinkingLevel: "off",
                },
                input: "完成一个测试任务",
            },
        ]);
        const events = store.listEvents(finalRun.id);

        expect(events.map((event) => event.type)).toEqual([
            "RUN_CREATED",
            "RUN_STARTED",
            "RUN_COMPLETED",
        ]);

        expect(events.map((event) => event.sequence)).toEqual([
            1,
            2,
            3,
        ]);
    } finally {
        db.close();
    }
});

test("RunService 会把 Runtime 失败持久化为 FAILED", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime("failed");
    const service = new RunService(store, runtime);

    try {
        const finalRun = await service.start({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "执行一个会失败的任务",
            workspacePath: "/tmp/workspace",
        });

        expect(finalRun.status).toBe("FAILED");
        expect(finalRun.failureReason).toBe("Fake Agent执行失败");
        expect(finalRun.finishedAt).not.toBeNull();

        expect(store.get(finalRun.id)).toEqual(finalRun);

        const events = store.listEvents(finalRun.id);

        expect(events.map((event) => event.type)).toEqual([
            "RUN_CREATED",
            "RUN_STARTED",
            "RUN_FAILED",
        ]);

        expect(events.map((event) => event.sequence)).toEqual([
            1,
            2,
            3,
        ]);

        expect(events[2]?.payload).toEqual({
            message: "Fake Agent执行失败",
        });
    } finally {
        db.close();
    }
});

test("RunService 会持久化工具边界并忽略重复投递", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);

    // 同一个 tool_started/tool_completed 分别投递两次。
    const runtime = new FakeAgentRuntime("completed", 2);
    const service = new RunService(store, runtime);

    try {
        const finalRun = await service.start({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "读取一个文件",
            workspacePath: "/tmp/workspace",
        });

        expect(finalRun.status).toBe("COMPLETED");

        const events = store.listEvents(finalRun.id);

        expect(events.map((event) => event.type)).toEqual([
            "RUN_CREATED",
            "RUN_STARTED",
            "TOOL_STARTED",
            "TOOL_COMPLETED",
            "RUN_COMPLETED",
        ]);

        expect(events.map((event) => event.sequence)).toEqual([
            1,
            2,
            3,
            4,
            5,
        ]);

        expect(events[2]?.dedupeKey).toBe(
            "tool:fake-tool-call-1:started",
        );
        expect(events[3]?.dedupeKey).toBe(
            "tool:fake-tool-call-1:finished",
        );
    } finally {
        db.close();
    }
});

test("RunService 会持久化模型 usage 并忽略重复模型事件", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);

    // 第三个参数表示相同模型开始/完成事件各投递两次。
    const runtime = new FakeAgentRuntime("completed", 0, 2);
    const service = new RunService(store, runtime);

    try {
        const finalRun = await service.start({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "执行模型调用",
            workspacePath: "/tmp/workspace",
        });

        const events = store.listEvents(finalRun.id);

        expect(events.map((event) => event.type)).toEqual([
            "RUN_CREATED",
            "RUN_STARTED",
            "MODEL_STARTED",
            "MODEL_COMPLETED",
            "RUN_COMPLETED",
        ]);

        expect(events.map((event) => event.sequence)).toEqual([
            1,
            2,
            3,
            4,
            5,
        ]);

        expect(events[3]?.payload).toMatchObject({
            modelCallId: "fake-model-call-1",
            durationMs: 25,
            stopReason: "stop",
            usage: {
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
            },
        });
    } finally {
        db.close();
    }
});

test("RunService 会从 Checkpoint 恢复 INTERRUPTED Run", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);
    const runId = "run-resume-1";
    const checkpointId = "checkpoint-resume-1";
    const createdAt = new Date().toISOString();
    const run: AgentRun = {
        id: runId,
        tenantId: "tenant-1",
        harnessSessionId: "session-1",
        status: "QUEUED",
        userInput: "恢复任务",
        workspacePath: "/tmp/workspace",
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        finishedAt: null,
        checkpointId,
        failureReason: null,
    };
    const createdEvent: RunEvent = {
        eventId: "event-created",
        runId,
        sequence: 1,
        type: "RUN_CREATED",
        timestamp: createdAt,
        payloadVersion: 1,
        payload: {},
    };

    try {
        store.create(run, createdEvent);

        const startedAt = new Date().toISOString();
        const runningRun: AgentRun = {
            ...run,
            status: "RUNNING",
            updatedAt: startedAt,
            startedAt,
        };
        store.update(runningRun, {
            eventId: "event-started",
            runId,
            sequence: 2,
            type: "RUN_STARTED",
            timestamp: startedAt,
            payloadVersion: 1,
            payload: {},
        });

        const interruptedAt = new Date().toISOString();
        store.update(
            {
                ...runningRun,
                status: "INTERRUPTED",
                updatedAt: interruptedAt,
            },
            {
                eventId: "event-interrupted",
                runId,
                sequence: 3,
                type: "RUN_INTERRUPTED",
                timestamp: interruptedAt,
                payloadVersion: 1,
                payload: {},
            },
        );

        const checkpoint: Checkpoint = {
            id: checkpointId,
            runId,
            toolExecutionId: "tool-execution-1",
            runtimeSessionRef: "/tmp/pi-session.jsonl",
            lastEventSequence: 2,
            createdAt,
        };
        const finalRun = await service.resume({
            runId,
            checkpoint,
            continuationInput: "继续完成原任务",
        });

        expect(finalRun.status).toBe("COMPLETED");
        expect(runtime.resumeRequests).toEqual([
            {
                run: {
                    runId,
                    tenantId: "tenant-1",
                    harnessSessionId: "session-1",
                    workspacePath: "/tmp/workspace",
                    thinkingLevel: "off",
                },
                checkpoint: {
                    checkpointId,
                    runtimeSessionRef: "/tmp/pi-session.jsonl",
                    lastEventSequence: 2,
                },
                continuationInput: "继续完成原任务",
            },
        ]);

        const events = store.listEvents(runId);
        expect(events.map((event) => event.type)).toEqual([
            "RUN_CREATED",
            "RUN_STARTED",
            "RUN_INTERRUPTED",
            "RUN_QUEUED",
            "RUN_RESUMED",
            "RUN_COMPLETED",
        ]);
        expect(events.map((event) => event.sequence)).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
    } finally {
        db.close();
    }
});

test("RunService 完成 Run 时保留数据库中的最新 Checkpoint", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    let handler: RuntimeEventHandler | null = null;

    const runtime: AgentRuntime = {
        subscribe(_runId, nextHandler) {
            handler = nextHandler;
            return () => {
                handler = null;
            };
        },
        async start(request) {
            db.query(`
                UPDATE agent_runs
                SET checkpoint_id = 'checkpoint-written-by-gateway'
                WHERE id = $runId;
            `).run({
                runId: request.run.runId,
            });

            handler?.({
                type: "agent_completed",
                runId: request.run.runId,
                timestamp: new Date().toISOString(),
            });
        },
        async resume() {},
        async interrupt() {},
    };
    const service = new RunService(store, runtime);

    try {
        const finalRun = await service.start({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "完成并保留恢复点",
            workspacePath: "/tmp/workspace",
        });

        expect(finalRun.status).toBe("COMPLETED");
        expect(finalRun.checkpointId).toBe(
            "checkpoint-written-by-gateway",
        );
    } finally {
        db.close();
    }
});

test("Runtime 恢复启动失败时 Run 会退回 INTERRUPTED", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runId = "run-resume-failure";
    const checkpointId = "checkpoint-resume-failure";
    const timestamp = new Date().toISOString();
    const interruptedRun: AgentRun = {
        id: runId,
        tenantId: "tenant-1",
        harnessSessionId: "session-1",
        status: "INTERRUPTED",
        userInput: "测试恢复启动失败",
        workspacePath: "/tmp/workspace",
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        finishedAt: null,
        checkpointId,
        failureReason: null,
    };
    const runtime: AgentRuntime = {
        subscribe() {
            return () => {};
        },
        async start() {},
        async resume() {
            throw new Error("无法打开 Runtime Session");
        },
        async interrupt() {},
    };
    const service = new RunService(store, runtime);

    try {
        store.create(interruptedRun, {
            eventId: "event-existing-interruption",
            runId,
            sequence: 1,
            type: "RUN_INTERRUPTED",
            timestamp,
            payloadVersion: 1,
            payload: {
                reason: "PROCESS_RESTART",
            },
        });

        const checkpoint: Checkpoint = {
            id: checkpointId,
            runId,
            toolExecutionId: "tool-execution-1",
            runtimeSessionRef: "/tmp/missing-session.jsonl",
            lastEventSequence: 1,
            createdAt: timestamp,
        };

        await expect(
            service.resume({
                runId,
                checkpoint,
                continuationInput: "继续执行",
            }),
        ).rejects.toThrow("无法打开 Runtime Session");

        expect(store.get(runId)?.status).toBe("INTERRUPTED");

        const events = store.listEvents(runId);
        expect(events.map((event) => event.type)).toEqual([
            "RUN_INTERRUPTED",
            "RUN_QUEUED",
            "RUN_RESUMED",
            "RUN_INTERRUPTED",
        ]);
        expect(events.at(-1)?.payload).toEqual({
            reason: "RESUME_FAILED",
            message: "无法打开 Runtime Session",
        });
    } finally {
        db.close();
    }
});

test("interrupt 幂等中断 QUEUED Run，且不调用 Runtime", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId:"tenant-interrupt",
            harnessSessionId:"session-interrupt",
            userInput:"中断排队任务",
            workspacePath:"/tmp/workspace-interrupt",
        });

        const firstResult = await service.interrupt(run.id);
        const secondResult = await service.interrupt(run.id);

        expect(firstResult.status).toBe("INTERRUPTED");
        expect(secondResult).toEqual(firstResult);
        expect(runtime.interruptedRunIds).toEqual([]);
        expect(store.listEvents(run.id).map((event) => event.type))
            .toEqual(["RUN_CREATED", "RUN_INTERRUPTED"]);
        expect(store.listEvents(run.id).at(-1)?.payload).toEqual({
            reason:"USER_REQUEST",
        });
    } finally {
        db.close();
    }
});

test("终态 Run 拒绝 interrupt", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const service = new RunService(store, new FakeAgentRuntime());

    try {
        const completedRun = await service.start({
            tenantId:"tenant-completed",
            harnessSessionId:"session-completed",
            userInput:"完成后不可中断",
            workspacePath:"/tmp/workspace-completed",
        });

        await expect(service.interrupt(completedRun.id)).rejects.toThrow(
            `终态 Run 不能中断:${completedRun.id}`,
        );
    } finally {
        db.close();
    }
});
