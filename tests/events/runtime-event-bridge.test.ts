import { expect, test } from "bun:test";

import {
    RuntimeEventBridge,
} from "../../src/events/runtime-event-bridge.ts";
import type {
    RuntimeEvent,
} from "../../src/runtime/agent-runtime.ts";

test("生命周期事件和 text_delta 不会转换成持久化事件", () => {
    const bridge = new RuntimeEventBridge();

    const ignoredEvents: RuntimeEvent[] = [
        {
            type: "agent_started",
            runId: "run-1",
            timestamp: "2026-07-26T10:00:00.000Z",
            runtimeSessionRef: "runtime-session-1",
        },
        {
            type: "agent_completed",
            runId: "run-1",
            timestamp: "2026-07-26T10:01:00.000Z",
        },
        {
            type: "agent_failed",
            runId: "run-1",
            timestamp: "2026-07-26T10:01:00.000Z",
            message: "测试失败",
        },
        {
            type: "agent_interrupted",
            runId: "run-1",
            timestamp: "2026-07-26T10:01:00.000Z",
        },
        {
            type: "agent_resumed",
            runId: "run-1",
            timestamp: "2026-07-26T10:02:00.000Z",
            checkpointId: "checkpoint-1",
            runtimeSessionRef: "runtime-session-1",
        },
        {
            type: "text_delta",
            runId: "run-1",
            timestamp: "2026-07-26T10:00:30.000Z",
            delta: "不会写入数据库",
        },
    ];

    expect(
        ignoredEvents.map((event) => bridge.map(event)),
    ).toEqual([
        null,
        null,
        null,
        null,
        null,
        null,
    ]);
});

test("tool_started 转换为带稳定去重键的 TOOL_STARTED", () => {
    const bridge = new RuntimeEventBridge();

    const result = bridge.map({
        type: "tool_started",
        runId: "run-1",
        timestamp: "2026-07-26T10:00:00.000Z",
        toolCallId: "call-1",
        toolName: "read",
        arguments: {
            path: "src/index.ts",
        },
    });

    expect(result).toEqual({
        runId: "run-1",
        type: "TOOL_STARTED",
        timestamp: "2026-07-26T10:00:00.000Z",
        payloadVersion: 1,
        dedupeKey: "tool:call-1:started",
        payload: {
            toolCallId: "call-1",
            toolName: "read",
            arguments: {
                path: "src/index.ts",
            },
        },
    });
});

test("模型开始和完成事件会保留模型、耗时与 usage", () => {
    const bridge = new RuntimeEventBridge();

    const started = bridge.map({
        type: "model_started",
        runId: "run-1",
        timestamp: "2026-07-26T10:00:00.000Z",
        modelCallId: "model-call-1",
        provider: "openai-compatible",
        model: "qwen3",
    });

    const completed = bridge.map({
        type: "model_completed",
        runId: "run-1",
        timestamp: "2026-07-26T10:00:01.250Z",
        modelCallId: "model-call-1",
        provider: "openai-compatible",
        model: "qwen3",
        durationMs: 1250,
        stopReason: "toolUse",
        usage: {
            inputTokens: 1200,
            outputTokens: 85,
            cacheReadTokens: 100,
            cacheWriteTokens: 0,
            reasoningTokens: null,
            totalTokens: 1285,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
    });

    expect(started).toEqual({
        runId: "run-1",
        type: "MODEL_STARTED",
        timestamp: "2026-07-26T10:00:00.000Z",
        payloadVersion: 1,
        dedupeKey: "model:model-call-1:started",
        payload: {
            modelCallId: "model-call-1",
            provider: "openai-compatible",
            model: "qwen3",
        },
    });

    expect(completed).toEqual({
        runId: "run-1",
        type: "MODEL_COMPLETED",
        timestamp: "2026-07-26T10:00:01.250Z",
        payloadVersion: 1,
        dedupeKey: "model:model-call-1:finished",
        payload: {
            modelCallId: "model-call-1",
            provider: "openai-compatible",
            model: "qwen3",
            durationMs: 1250,
            stopReason: "toolUse",
            usage: {
                inputTokens: 1200,
                outputTokens: 85,
                cacheReadTokens: 100,
                cacheWriteTokens: 0,
                reasoningTokens: null,
                totalTokens: 1285,
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                },
            },
        },
    });
});

test("tool_completed 根据 isError 映射成功或失败，并共享终态去重键", () => {
    const bridge = new RuntimeEventBridge();

    const completed = bridge.map({
        type: "tool_completed",
        runId: "run-1",
        timestamp: "2026-07-26T10:01:00.000Z",
        toolCallId: "call-1",
        toolName: "read",
        result: "文件内容",
        isError: false,
    });

    const failed = bridge.map({
        type: "tool_completed",
        runId: "run-1",
        timestamp: "2026-07-26T10:01:00.000Z",
        toolCallId: "call-1",
        toolName: "read",
        result: "文件不存在",
        isError: true,
    });

    expect(completed?.type).toBe("TOOL_COMPLETED");
    expect(failed?.type).toBe("TOOL_FAILED");
    expect(completed?.dedupeKey).toBe("tool:call-1:finished");
    expect(failed?.dedupeKey).toBe("tool:call-1:finished");
});

test("未知 RuntimeEvent 会告警并返回 null", () => {
    const warnings: Array<{
        message: string;
        event: unknown;
    }> = [];

    const bridge = new RuntimeEventBridge((message, event) => {
        warnings.push({
            message,
            event,
        });
    });

    const unknownEvent = {
        type: "future_runtime_event",
        runId: "run-1",
    };

    const result = bridge.map(
        unknownEvent as unknown as RuntimeEvent,
    );

    expect(result).toBeNull();
    expect(warnings).toEqual([
        {
            message: "收到未知 RuntimeEvent : future_runtime_event",
            event: unknownEvent,
        },
    ]);
});
