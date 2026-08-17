import {expect,test} from "bun:test";

import type {
    RuntimeEvent,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "../../src/runtime/agent-runtime.ts";

import { FakeAgentRuntime } from "../fakes/fake-agent-runtime";

test("start 会记录请求并按顺序发送事件", async () => {
    // Arrange：准备 Runtime 和测试数据
    const runtime = new FakeAgentRuntime();

    const events: RuntimeEvent[] = [];

    const request: RuntimeStartRequest = {
        run: {
            runId: "run-1",
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            workspacePath: "/tmp/workspace",
        },
        input: "测试任务",
    };

    const unsubscribe = runtime.subscribe("run-1", event => {
        events.push(event);
    });

    // Act：执行 start
    await runtime.start(request);

    // Assert：检查请求是否被记录
    expect(runtime.startRequests).toEqual([request]);

    // Assert：检查事件顺序
    expect(events.map(event => event.type)).toEqual([
        "agent_started",
        "text_delta",
        "agent_completed",
    ]);

    // Assert：检查所有事件是否属于 run-1
    expect(
        events.every(event => event.runId === "run-1"),
    ).toBe(true);

    unsubscribe();
});


test("resume 会记录恢复请求并按顺序发送事件", async () => {
    // Arrange：每个测试使用一个全新的 Runtime
    const runtime = new FakeAgentRuntime();

    const events: RuntimeEvent[] = [];

    const request: RuntimeResumeRequest = {
        run: {
            runId: "run-2",
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            workspacePath: "/tmp/workspace",
        },
        checkpoint: {
            checkpointId: "checkpoint-1",
            runtimeSessionRef: "runtime-session-1",
            lastEventSequence: 1,
        },
        continuationInput:"从安全边界继续测试任务",
    };

    const unsubscribe = runtime.subscribe("run-2", event => {
        events.push(event);
    });

    // Act：执行 resume
    await runtime.resume(request);

    // Assert：检查恢复请求是否被完整记录
    expect(runtime.resumeRequests).toEqual([request]);

    // Assert：检查恢复过程中产生的事件
    expect(events.map(event => event.type)).toEqual([
        "agent_resumed",
        "text_delta",
        "agent_completed",
    ]);

    expect(events[0]).toEqual({
        type:"agent_resumed",
        runId:"run-2",
        timestamp:expect.any(String),
        checkpointId:"checkpoint-1",
        runtimeSessionRef:"runtime-session-1"
    })

    // Assert：检查事件没有被发送给错误的 Run
    expect(
        events.every(event => event.runId === "run-2"),
    ).toBe(true);

    unsubscribe();
});


test("interrupt 会记录被中断的 runId", async () => {
    // Arrange
    const runtime = new FakeAgentRuntime();

    // Act
    await runtime.interrupt("run-1");

    // Assert
    expect(runtime.interruptedRunIds).toEqual([
        "run-1",
    ]);
});

test("取消订阅后不会继续收到事件", async () => {
    // Arrange
    const runtime = new FakeAgentRuntime();

    const events: RuntimeEvent[] = [];

    const request: RuntimeStartRequest = {
        run: {
            runId: "run-1",
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            workspacePath: "/tmp/workspace",
        },
        input: "测试任务",
    };

    const unsubscribe = runtime.subscribe("run-1", event => {
        events.push(event);
    });

    // 第一次运行：此时仍然处于订阅状态
    await runtime.start(request);

    expect(events.map(event => event.type)).toEqual([
        "agent_started",
        "text_delta",
        "agent_completed",
    ]);
    

    // Act：取消订阅
    unsubscribe();

    // 再次运行同一个 Run
    await runtime.start(request);

    // Assert：事件数量没有继续增加
    expect(events).toHaveLength(3);
});

test("不同 runId 的事件不会发送给错误的订阅者", async () => {
    // Arrange
    const runtime = new FakeAgentRuntime();

    const run1Events: RuntimeEvent[] = [];
    const run2Events: RuntimeEvent[] = [];

    const unsubscribeRun1 = runtime.subscribe("run-1", event => {
        run1Events.push(event);
    });

    const unsubscribeRun2 = runtime.subscribe("run-2", event => {
        run2Events.push(event);
    });

    const run1Request: RuntimeStartRequest = {
        run: {
            runId: "run-1",
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            workspacePath: "/tmp/workspace",
        },
        input: "运行 run-1",
    };

    const run2Request: RuntimeStartRequest = {
        run: {
            runId: "run-2",
            tenantId: "tenant-1",
            harnessSessionId: "session-1",
            workspacePath: "/tmp/workspace",
        },
        input: "运行 run-2",
    };

    // Act：只启动 run-1
    await runtime.start(run1Request);

    // run-1 收到三个事件，run-2 没有收到
    expect(run1Events).toHaveLength(3);
    expect(run2Events).toHaveLength(0);

    // 再启动 run-2
    await runtime.start(run2Request);

    // run-1 没有新增事件，run-2 收到自己的三个事件
    expect(run1Events).toHaveLength(3);
    expect(run2Events).toHaveLength(3);

    // 每组事件的 runId 都正确
    expect(
        run1Events.every(event => event.runId === "run-1"),
    ).toBe(true);

    expect(
        run2Events.every(event => event.runId === "run-2"),
    ).toBe(true);

    unsubscribeRun1();
    unsubscribeRun2();
});