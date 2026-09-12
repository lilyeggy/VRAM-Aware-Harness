import {expect,test} from "bun:test";

import { RunService } from "../../src/runs/run-service";
import { RunStore } from "../../src/runs/runstore";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime";
import { openHarnessDatabase } from "../../src/storage/database";


test("markToolPhase STARTED/ENDED 在 RUNNING 与 WAITING_TOOL 间往返并记录事件", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "读取文件",
            workspacePath: "/tmp/workspace",
        });

        // 手动推进到 RUNNING（模拟调度器已启动该 Run）。
        const startedAt = new Date().toISOString();
        store.update(
            {
                ...store.get(run.id)!,
                status: "RUNNING",
                updatedAt: startedAt,
                startedAt,
            },
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

        const info = { toolName: "bash", toolCallId: "tool-call-1" };

        service.markToolPhase(run.id, "STARTED", info);
        expect(store.get(run.id)?.status).toBe("WAITING_TOOL");

        service.markToolPhase(run.id, "ENDED", info);
        expect(store.get(run.id)?.status).toBe("RUNNING");

        const events = store.listEvents(run.id);
        const toolEvents = events.filter(
            (event) => event.type === "TOOL_STARTED" || event.type === "TOOL_COMPLETED",
        );

        expect(toolEvents.map((event) => event.type)).toEqual([
            "TOOL_STARTED",
            "TOOL_COMPLETED",
        ]);
        expect(toolEvents.map((event) => event.payload)).toEqual([info, info]);
        expect(toolEvents.map((event) => event.sequence)).toEqual([3, 4]);
    } finally {
        db.close();
    }
});

test("markToolPhase 在非预期状态下静默忽略迟到的阶段回执", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const service = new RunService(store, runtime);

    try {
        const run = service.createQueuedRun({
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            userInput: "读取文件",
            workspacePath: "/tmp/workspace",
        });

        const info = { toolName: "bash", toolCallId: "tool-call-1" };

        // QUEUED 状态收到 STARTED：忽略。
        service.markToolPhase(run.id, "STARTED", info);
        expect(store.get(run.id)?.status).toBe("QUEUED");

        // 推进到终态 COMPLETED 后收到迟到 ENDED：忽略，不覆盖终态。
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
        const finishedAt = new Date().toISOString();
        store.update(
            { ...store.get(run.id)!, status: "COMPLETED", updatedAt: finishedAt, finishedAt },
            {
                eventId: crypto.randomUUID(),
                runId: run.id,
                sequence: store.getLastEventSequence(run.id) + 1,
                type: "RUN_COMPLETED",
                timestamp: finishedAt,
                payloadVersion: 1,
                payload: {},
            },
        );

        // 从 COMPLETED 无法直接走状态机，模拟终态下收到 STARTED 也不应破坏状态。
        service.markToolPhase(run.id, "STARTED", info);
        expect(store.get(run.id)?.status).toBe("COMPLETED");

        const types = store.listEvents(run.id)
            .map((event) => event.type);
        expect(types).not.toContain("TOOL_STARTED");
        expect(types).not.toContain("TOOL_COMPLETED");
    } finally {
        db.close();
    }
});
