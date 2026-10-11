/**
 * 测试用最小 MCP stdio server。
 *
 * 只实现 initialize / tools/list / tools/call，供 §9.8 v1.4 Phase 4 的
 * 客户端与注册表测试使用。真实部署应换成运维提供的 MCP server。
 */
import { createInterface } from "node:readline";

const tools = [
    {
        name: "echo",
        description: "回显输入文本",
        inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "write_note",
        description: "写入一条备注（测试副作用分类）",
        inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
        },
    },
];

const reader = createInterface({ input: process.stdin });

reader.on("line", (line) => {
    if (line.trim().length === 0) {
        return;
    }
    let message: Record<string, unknown>;
    try {
        message = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return;
    }
    if (message.id === undefined) {
        return;
    }
    const id = message.id;
    const method = message.method;
    if (method === "initialize") {
        respond(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "echo", version: "1.0.0" },
        });
        return;
    }
    if (method === "tools/list") {
        respond(id, { tools });
        return;
    }
    if (method === "tools/call") {
        const params = message.params;
        if (typeof params !== "object" || params === null) {
            respondError(id, -32602, "缺少 params");
            return;
        }
        const paramsRecord = params as Record<string, unknown>;
        const name = paramsRecord.name;
        const args = paramsRecord.arguments;
        const text = typeof args === "object" && args !== null
            ? (args as Record<string, unknown>).text
            : undefined;
        if (name === "echo") {
            respond(id, { content: [{ type: "text", text: `echo:${String(text)}` }] });
            return;
        }
        if (name === "write_note") {
            respond(id, { content: [{ type: "text", text: `note:${String(text)}` }] });
            return;
        }
        respondError(id, -32602, `未知工具：${String(name)}`);
        return;
    }
    respondError(id, -32601, `未知方法：${String(method)}`);
});

function respond(id: unknown, result: unknown): void {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: unknown, code: number, message: string): void {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
