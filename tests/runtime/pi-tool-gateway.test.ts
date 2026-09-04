import { expect, test } from "bun:test";
import {
    type AgentToolResult,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
    classifyPiToolEffect,
    createGatewayPiTools,
    wrapPiToolWithGateway,
    type ToolGatewayExecutor,
} from "../../src/runtime/pi-tool-gateway.ts";
import type {
    ExecuteToolInput,
} from "../../src/tools/tool-gateway.ts";

const sandboxEnforcement = Object.freeze({
    toolExecutionBoundary: "SANDBOX" as const,
    filesystemIsolation: true,
    processIsolation: true,
    networkPolicyEnforced: true,
    cpuLimitEnforced: true,
    memoryLimitEnforced: true,
    diskLimitEnforced: false,
    pidLimitEnforced: true,
});

test("Pi 内置工具采用保守副作用分类", () => {
    expect(classifyPiToolEffect("read")).toBe("READ_ONLY");
    expect(classifyPiToolEffect("grep")).toBe("READ_ONLY");
    expect(classifyPiToolEffect("find")).toBe("READ_ONLY");
    expect(classifyPiToolEffect("ls")).toBe("READ_ONLY");

    expect(classifyPiToolEffect("bash")).toBe("UNKNOWN_EFFECT");
    expect(classifyPiToolEffect("edit")).toBe("UNKNOWN_EFFECT");
    expect(classifyPiToolEffect("write")).toBe("UNKNOWN_EFFECT");
});

test("带 Sandbox execution context 的 Pi 工具不会回退到宿主机", async () => {
    const commands: string[][] = [];
    const tools = createGatewayPiTools(
        ["bash", "read", "grep"],
        "/srv/workspace",
        { async execute(_input, invokeTool) { return invokeTool(); } },
        {
            runId: "run-sandbox",
            workspacePath: "/srv/workspace",
            getSandboxId: () => "sandbox-1",
            getSandboxEnforcement: () => sandboxEnforcement,
            getRuntimeSessionRef: () => "session",
            getLastEventSequence: () => 1,
        },
        {
            async execute(sandboxId, command) {
                expect(sandboxId).toBe("sandbox-1");
                commands.push([...command]);
                return { exitCode: 0, stdout: "sandbox-output", stderr: "" };
            },
        },
    );
    const bash = tools.find((tool) => tool.name === "bash")!;
    await bash.execute("bash-1", { command: "pwd" }, undefined, undefined, {} as never);
    expect(commands[0]).toEqual(["sh", "-lc", "pwd"]);

    const read = tools.find((tool) => tool.name === "read")!;
    await read.execute("read-1", { path: "README.md" }, undefined, undefined, {} as never);
    expect(commands[1]).toEqual(["sh", "-lc", "test -r '/workspace/README.md'"]);
    expect(commands[2]).toEqual(["sh", "-lc", "cat -- '/workspace/README.md'"]);

    const grep = tools.find((tool) => tool.name === "grep")!;
    await grep.execute("grep-1", { pattern: "secret" }, undefined, undefined, {} as never);
    expect(commands[3]).toEqual([
        "sh", "-lc",
        "grep -R -n --binary-files=without-match -- 'secret' '/workspace' 2>/dev/null; code=$?; if [ $code -gt 1 ]; then exit $code; fi; exit 0",
    ]);
});

test("Sandbox execution context 缺少命令执行器时 fail closed", () => {
    expect(() => createGatewayPiTools(
        ["read"],
        "/srv/workspace",
        { async execute(_input, invokeTool) { return invokeTool(); } },
        {
            runId: "run-sandbox",
            workspacePath: "/srv/workspace",
            getSandboxId: () => "sandbox-1",
            getSandboxEnforcement: () => sandboxEnforcement,
            getRuntimeSessionRef: () => "session",
            getLastEventSequence: () => 1,
        },
    )).toThrow("拒绝回退宿主机");
});

test("Pi ToolDefinition 的真实 execute 会经过 Gateway", async () => {
    let originalInvokeCount = 0;
    let capturedInput: ExecuteToolInput | null = null;

    const originalResult: AgentToolResult<undefined> = {
        content: [{
            type: "text",
            text: "file content",
        }],
        details: undefined,
    };

    const originalDefinition: ToolDefinition<any, undefined> = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: Type.Object({
            path: Type.String(),
        }),
        async execute() {
            originalInvokeCount += 1;
            return originalResult;
        },
    };

    const gateway: ToolGatewayExecutor = {
        async execute(input, invokeTool) {
            capturedInput = input;
            return invokeTool();
        },
    };

    const wrapped = wrapPiToolWithGateway(
        originalDefinition,
        "READ_ONLY",
        gateway,
        {
            runId: "run-1",
            getRuntimeSessionRef: () => "/tmp/pi-session.jsonl",
            getLastEventSequence: () => 4,
        },
    );

    const result = await wrapped.execute(
        "tool-call-1",
        {
            path: "README.md",
        },
        undefined,
        undefined,
        {} as never,
    );

    expect(result).toEqual(originalResult);
    expect(originalInvokeCount).toBe(1);
    expect(capturedInput as ExecuteToolInput | null).toEqual({
        runId: "run-1",
        toolCallId: "tool-call-1",
        toolName: "read",
        arguments: {
            path: "README.md",
        },
        effect: "READ_ONLY",
        runtimeSessionRef: "/tmp/pi-session.jsonl",
        lastEventSequence: 4,
    });
});
