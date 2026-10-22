import { expect, test } from "bun:test";

import type { AgentRun, RunEvent, RunEventType } from "../../src/runs/agent-run.ts";
import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import { buildRunTrace } from "../../src/runs/run-trace.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";

const T0 = Date.parse("2026-10-22T00:00:00.000Z");

function at(offsetMs: number): string {
    return new Date(T0 + offsetMs).toISOString();
}

function event(
    sequence: number,
    type: RunEventType,
    offsetMs: number,
    payload: unknown = {},
): RunEvent {
    return {
        eventId: `event-${sequence}`,
        runId: "run-trace-1",
        sequence,
        type,
        timestamp: at(offsetMs),
        payloadVersion: 1,
        payload,
    };
}

const run: Pick<AgentRun, "id" | "tenantId" | "status" | "createdAt" | "finishedAt"> = {
    id: "run-trace-1",
    tenantId: "tenant-a",
    status: "COMPLETED",
    createdAt: at(0),
    finishedAt: at(2700),
};

test("把事件流折叠成分步时间线并做 token/成本归因", () => {
    const events: RunEvent[] = [
        event(1, "RUN_CREATED", 0),
        event(2, "RUN_QUEUED", 10, { reason: "SUBMIT" }),
        event(3, "SANDBOX_ACQUIRED", 20, {
            durationMs: 120,
            warmHit: true,
            profile: "strict",
            sandboxId: "sandbox-1",
        }),
        event(4, "RUN_STARTED", 150),
        event(5, "MODEL_STARTED", 160, {
            modelCallId: "m1",
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            // 请求在会话就绪后 40ms 发出；provider 首字用了 900ms
            requestStartedAt: at(190),
            ttftMs: 900,
        }),
        event(6, "MODEL_COMPLETED", 1160, {
            modelCallId: "m1",
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            durationMs: 1000,
            stopReason: "tool_use",
            usage: {
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 10,
                cacheWriteTokens: 0,
                reasoningTokens: null,
                totalTokens: 150,
                cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
            },
        }),
        event(7, "TOOL_STARTED", 1200, {
            toolCallId: "tc1",
            toolName: "bash",
            arguments: { command: "echo hi" },
        }),
        event(8, "TOOL_COMPLETED", 1500, {
            toolCallId: "tc1",
            toolName: "bash",
            result: "hi",
            isError: false,
        }),
        event(9, "MODEL_STARTED", 1600, { modelCallId: "m2", model: "deepseek-v4.1-flash" }),
        event(10, "MODEL_COMPLETED", 2600, {
            modelCallId: "m2",
            durationMs: 1000,
            usage: {
                inputTokens: 200,
                outputTokens: 100,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: null,
                totalTokens: 300,
                cost: { input: 0.003, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.004 },
            },
        }),
        event(11, "RUN_COMPLETED", 2700),
    ];

    const trace = buildRunTrace(run, events);

    expect(trace.steps.map((step) => step.name)).toEqual([
        "RUN_QUEUED",
        "SANDBOX_ACQUIRED",
        "RUN_STARTED",
        "deepseek-v4.1-flash",
        "bash",
        "deepseek-v4.1-flash",
        "RUN_COMPLETED",
    ]);
    expect(trace.steps.find((step) => step.name === "bash")?.durationMs).toBe(300);
    expect(trace.totals).toMatchObject({
        modelCalls: 2,
        toolCalls: 1,
        sandboxMs: 120,
        modelMs: 2000,
        toolMs: 300,
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 10,
        totalTokens: 450,
        // 从提交（RUN_CREATED）到首次 RUN_STARTED 的用户等待时间。
        queueWaitMs: 150,
        // SESSION_INITIALIZED（本用例没有）时取不到组装时间，这里只校验 TTFT
        upstreamTtftMs: 900,
        wallMs: 2700,
        lifecycleMs: 0,
        // 2700 墙钟 - 120 沙箱 - 2000 模型 - 300 工具 = 280 未归因
        unaccountedMs: 280,
    });
    expect(trace.totals.costTotal).toBeCloseTo(0.006, 6);
});

test("没有配对的开始事件标记为 pending，便于定位卡点", () => {
    const trace = buildRunTrace(
        { ...run, status: "RUNNING", finishedAt: null },
        [
            event(1, "RUN_CREATED", 0),
            event(2, "RUN_STARTED", 10),
            event(3, "MODEL_STARTED", 20, { modelCallId: "m-pending", model: "qwen" }),
            event(4, "TOOL_STARTED", 30, { toolCallId: "t-pending", toolName: "bash" }),
        ],
    );

    const pending = trace.steps.filter((step) => step.status === "pending");
    expect(pending.map((step) => step.kind).sort()).toEqual(["model", "tool"]);
    expect(trace.totals.wallMs).toBeNull();
});

test("失败的工具调用记为 error，并保留错误原因", () => {
    const trace = buildRunTrace(run, [
        event(1, "RUN_CREATED", 0),
        event(2, "TOOL_STARTED", 10, { toolCallId: "t1", toolName: "bash" }),
        event(3, "TOOL_FAILED", 60, {
            toolCallId: "t1",
            toolName: "bash",
            error: "permission denied",
        }),
    ]);

    const tool = trace.steps.find((step) => step.kind === "tool");
    expect(tool?.status).toBe("error");
    expect(tool?.detail?.error).toBe("permission denied");
    expect(trace.totals.toolCalls).toBe(1);
});

test("真实 Run 走完后，trace 能给出模型/工具调用数与成本归因", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    // 1 次工具事件投递 + 1 次模型事件投递
    const runtime = new FakeAgentRuntime("completed", 1, 1);
    const service = new RunService(store, runtime);
    const run = service.createQueuedRun({
        tenantId: "tenant-a",
        harnessSessionId: "session-trace",
        userInput: "跑一次带工具和模型事件的 Run",
        workspacePath: "/tmp/ws-trace",
    });

    await service.executeQueuedRun(run.id);

    const stored = store.get(run.id);
    expect(stored).not.toBeNull();

    const trace = buildRunTrace(stored ?? run, store.listEvents(run.id));

    expect(trace.status).toBe("COMPLETED");
    expect(trace.totals.modelCalls).toBe(1);
    expect(trace.totals.toolCalls).toBe(1);
    expect(trace.totals.totalTokens).toBeGreaterThan(0);
    expect(trace.totals.wallMs).not.toBeNull();
    expect(trace.steps.some((step) => step.kind === "model")).toBe(true);
    expect(trace.steps.some((step) => step.kind === "tool")).toBe(true);

    db.close();
});

test("会话就绪到请求发出 = 我们自己的组装时间", () => {
    const trace = buildRunTrace(run, [
        event(1, "RUN_CREATED", 0),
        event(2, "RUN_STARTED", 10),
        event(3, "SESSION_INITIALIZED", 20, { durationMs: 6, mode: "NEW" }),
        event(4, "MODEL_STARTED", 30, {
            modelCallId: "m1",
            model: "deepseek-v4.1-flash",
            requestStartedAt: at(120),
            ttftMs: 800,
        }),
        event(5, "MODEL_COMPLETED", 900, {
            modelCallId: "m1",
            durationMs: 780,
            usage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
                cost: { total: 0.0001 },
            },
        }),
    ]);

    expect(trace.totals.requestAssemblyMs).toBe(100);
    expect(trace.totals.upstreamTtftMs).toBe(800);
});
