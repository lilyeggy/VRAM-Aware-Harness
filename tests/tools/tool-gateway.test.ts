import {expect,test} from "bun:test";

import type {Database} from "bun:sqlite";

import type {
    AgentRun,
    RunEvent,
}   from "../../src/runs/agent-run.ts";

import { RunStore } from "../../src/runs/runstore.ts";

import {
    openHarnessDatabase,
} from "../../src/storage/database.ts";
import {
    ToolGateway,
    type ExecuteToolInput,
}   from "../../src/tools/tool-gateway.ts";

import {
    ToolExecutionStore,
}   from "../../src/tools/tool-execution-store.ts";

const createdAt = new Date().toISOString();

function seedRunningRun(db:Database):AgentRun{
    const runStore = new RunStore(db);

    const queuedRun : AgentRun = {
        id : "run-1",
        tenantId : "tenant-1",
        harnessSessionId : "session-1",
        status : "QUEUED",
        userInput : "读取 README",
        workspacePath : "/tmp/workspace",

        createdAt : createdAt,
        updatedAt : createdAt,
        startedAt : null,
        finishedAt : null,

        checkpointId : null,
        failureReason : null,
    };

    const createdEvent : RunEvent = {
        eventId : "event-1",
        runId : queuedRun.id,
        sequence : 1,
        type : "RUN_CREATED",
        timestamp : createdAt,
        payloadVersion : 1,
        payload : {},
    };

    runStore.create(queuedRun,createdEvent);

    const startedAt = new Date().toISOString();

    const runningRun : AgentRun = {
        ...queuedRun,
        status : "RUNNING",
        updatedAt : startedAt,
        startedAt : startedAt,
    };

    const startedEvent : RunEvent = {
        eventId:"event-2",
        runId : runningRun.id,
        sequence:2,
        type : "RUN_STARTED",
        timestamp:startedAt,
        payloadVersion:1,
        payload:{},
    };

    runStore.update(runningRun,startedEvent);
    return runningRun;

}

test("首次工具调用会执行并保存成功结果和checkpoint", async () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const run = seedRunningRun(db);
        const executionStore = new ToolExecutionStore(db);
        const gateway = new ToolGateway(executionStore);
        const runStore = new RunStore(db);

        const input : ExecuteToolInput = {
            runId:run.id,
            toolCallId : "tool-call-1",
            toolName : "read",
            arguments : {
                path : "README.md",
            },
            effect : "READ_ONLY",
            runtimeSessionRef : "/tmp/pi-session.jsonl",
            lastEventSequence : 2,
        };

        let invokeCount = 0;
        const result = await gateway.execute(
            input,
            async() => {
                invokeCount += 1;

                return {
                    content:"README content",
                };
            }
        )

        expect(invokeCount).toBe(1);
        expect(result).toEqual({
            content:"README content",
        });

        const savedExecution = executionStore.getByToolCall(
            run.id,
            input.toolCallId,
        );

        expect(savedExecution?.status).toBe("SUCCEEDED");
        expect(savedExecution?.result).toEqual({
            content:"README content",
        });

        expect(
            runStore.get(run.id)?.checkpointId,
        ).not.toBeNull();

    } finally{
        db.close();
    }
});

test("重复工具调用会复用历史结果", async () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const run = seedRunningRun(db);
        const executionStore = new ToolExecutionStore(db);
        const gateway = new ToolGateway(executionStore);

        const input: ExecuteToolInput = {
            runId: run.id,
            toolCallId: "tool-call-1",
            toolName: "read",
            arguments: {
                path: "README.md",
            },
            effect: "READ_ONLY",
            runtimeSessionRef: "/tmp/pi-session.jsonl",
            lastEventSequence: 2,
        };

        let invokeCount = 0;

        const firstResult = await gateway.execute(
            input,
            async () => {
                invokeCount += 1;
                return {
                    content: "README content",
                };
            },
        );

        const secondResult = await gateway.execute(
            input,
            async () => {
                invokeCount += 1;
                return {
                    content: "不应该出现的新结果",
                };
            },
        );

        expect(secondResult).toEqual(firstResult);
        expect(invokeCount).toBe(1);
    } finally {
        db.close();
    }
});

test("真实工具抛错后会保存 FAILED", async () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const run = seedRunningRun(db);
        const executionStore = new ToolExecutionStore(db);
        const gateway = new ToolGateway(executionStore);

        const input: ExecuteToolInput = {
            runId: run.id,
            toolCallId: "tool-call-1",
            toolName: "read",
            arguments: {
                path: "missing.txt",
            },
            effect: "READ_ONLY",
            runtimeSessionRef: "/tmp/pi-session.jsonl",
            lastEventSequence: 2,
        };

        await expect(
            gateway.execute(
                input,
                async () => {
                    throw new Error("文件不存在");
                },
            ),
        ).rejects.toThrow("文件不存在");

        const saved = executionStore.getByToolCall(
            run.id,
            input.toolCallId,
        );

        expect(saved?.status).toBe("FAILED");
        expect(saved?.errorMessage).toBe("文件不存在");
    } finally {
        db.close();
    }
});

test("PREPARED 只读工具允许自动重放", async () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const run = seedRunningRun(db);
        const executionStore = new ToolExecutionStore(db);
        const gateway = new ToolGateway(executionStore);

        const input: ExecuteToolInput = {
            runId: run.id,
            toolCallId: "tool-call-1",
            toolName: "read",
            arguments: {
                path: "README.md",
            },
            effect: "READ_ONLY",
            runtimeSessionRef: "/tmp/pi-session.jsonl",
            lastEventSequence: 2,
        };

        executionStore.prepare({
            id: "prepared-execution",
            runId: run.id,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            arguments: input.arguments,
            effect: input.effect,
            status: "PREPARED",
            result: null,
            errorMessage: null,
            createdAt,
            finishedAt: null,
        });

        const result = await gateway.execute(
            input,
            async () => ({
                content: "replayed content",
            }),
        );

        expect(result).toEqual({
            content: "replayed content",
        });
        expect(
            executionStore.getByToolCall(
                run.id,
                input.toolCallId,
            )?.status,
        ).toBe("SUCCEEDED");
    } finally {
        db.close();
    }
});

test("PREPARED 未知副作用工具禁止自动重放", async () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const run = seedRunningRun(db);
        const executionStore = new ToolExecutionStore(db);
        const gateway = new ToolGateway(executionStore);

        const input: ExecuteToolInput = {
            runId: run.id,
            toolCallId: "tool-call-1",
            toolName: "bash",
            arguments: {
                command: "send-email",
            },
            effect: "UNKNOWN_EFFECT",
            runtimeSessionRef: "/tmp/pi-session.jsonl",
            lastEventSequence: 2,
        };

        executionStore.prepare({
            id: "prepared-execution",
            runId: run.id,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            arguments: input.arguments,
            effect: input.effect,
            status: "PREPARED",
            result: null,
            errorMessage: null,
            createdAt,
            finishedAt: null,
        });

        let invoked = false;

        await expect(
            gateway.execute(
                input,
                async () => {
                    invoked = true;
                    return "不应该执行";
                },
            ),
        ).rejects.toThrow("不允许自动重放");

        expect(invoked).toBe(false);
        expect(
            executionStore.getByToolCall(
                run.id,
                input.toolCallId,
            )?.status,
        ).toBe("PREPARED");
    } finally {
        db.close();
    }
});
