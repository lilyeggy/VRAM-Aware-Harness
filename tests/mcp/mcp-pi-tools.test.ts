import { describe, expect, it } from "bun:test";
import { createMcpPiTools, mcpPiToolName } from "../../src/mcp/mcp-pi-tools.ts";
import type { McpToolDescriptor } from "../../src/mcp/mcp-protocol.ts";

const echoDescriptor: McpToolDescriptor = {
    serverName: "echo",
    name: "echo",
    description: "回显输入文本",
    inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
    },
    readOnly: true,
};

interface CapturedInput {
    effect: string;
    toolName: string;
    runId: string;
    toolCallId: string;
    runtimeSessionRef: string;
    lastEventSequence: number;
    workspacePath?: string;
}

function createGateway(captured: CapturedInput[]): {
    execute(input: unknown, invoke: () => Promise<unknown>): Promise<unknown>;
} {
    return {
        async execute(input, invoke) {
            captured.push(input as CapturedInput);
            return await invoke();
        },
    };
}

describe("createMcpPiTools", () => {
    it("生成 mcp__server__tool 命名，并把只读标记映射为 READ_ONLY", async () => {
        const captured: CapturedInput[] = [];
        const tools = createMcpPiTools(
            [echoDescriptor],
            {
                async callTool() {
                    return { content: [{ type: "text", text: "pong" }] };
                },
            },
            createGateway(captured),
            {
                runId: "run-1",
                workspacePath: "/tmp/ws",
                getRuntimeSessionRef: () => "session-1",
                getLastEventSequence: () => 7,
            },
        );
        expect(tools).toHaveLength(1);
        expect(tools[0]?.name).toBe("mcp__echo__echo");

        const tool = tools[0] as unknown as {
            execute(
                toolCallId: string,
                params: unknown,
                signal: unknown,
                onUpdate: unknown,
                ctx: unknown,
            ): Promise<{ content: { type: string; text: string }[] }>;
        };
        const result = await tool.execute("call-1", { text: "hi" }, undefined, undefined, undefined);
        expect(result.content[0]?.text).toBe("pong");

        expect(captured).toHaveLength(1);
        expect(captured[0]?.effect).toBe("READ_ONLY");
        expect(captured[0]?.toolName).toBe("mcp__echo__echo");
        expect(captured[0]?.runId).toBe("run-1");
        expect(captured[0]?.toolCallId).toBe("call-1");
        expect(captured[0]?.runtimeSessionRef).toBe("session-1");
        expect(captured[0]?.lastEventSequence).toBe(7);
        expect(captured[0]?.workspacePath).toBe("/tmp/ws");
    });

    it("无 readOnlyHint 的工具按 UNKNOWN_EFFECT 记账", async () => {
        const captured: CapturedInput[] = [];
        const writeDescriptor: McpToolDescriptor = { ...echoDescriptor, name: "write_note", readOnly: false };
        const tools = createMcpPiTools(
            [writeDescriptor],
            {
                async callTool() {
                    return { content: [{ type: "text", text: "note" }] };
                },
            },
            createGateway(captured),
            {
                runId: "run-2",
                getRuntimeSessionRef: () => "session-2",
                getLastEventSequence: () => 0,
            },
        );
        expect(mcpPiToolName(writeDescriptor)).toBe("mcp__echo__write_note");
        expect(tools[0]?.name).toBe("mcp__echo__write_note");
        const tool = tools[0] as unknown as {
            execute(
                toolCallId: string,
                params: unknown,
                signal: unknown,
                onUpdate: unknown,
                ctx: unknown,
            ): Promise<unknown>;
        };
        await tool.execute("call-2", { text: "x" }, undefined, undefined, undefined);
        expect(captured[0]?.effect).toBe("UNKNOWN_EFFECT");
    });

    it("MCP 返回 isError 时抛出错误", async () => {
        const tools = createMcpPiTools(
            [echoDescriptor],
            {
                async callTool() {
                    return { content: [{ type: "text", text: "boom" }], isError: true };
                },
            },
            createGateway([]),
            {
                runId: "run-3",
                getRuntimeSessionRef: () => "session-3",
                getLastEventSequence: () => 0,
            },
        );
        const tool = tools[0] as unknown as {
            execute(
                toolCallId: string,
                params: unknown,
                signal: unknown,
                onUpdate: unknown,
                ctx: unknown,
            ): Promise<unknown>;
        };
        await expect(tool.execute("call-3", {}, undefined, undefined, undefined)).rejects.toThrow("MCP 工具返回错误");
    });

    it("server 名与工具名中的非法字符会被清洗", () => {
        expect(mcpPiToolName({ ...echoDescriptor, serverName: "my server", name: "read/file" }))
            .toBe("mcp__my_server__read_file");
    });
});
