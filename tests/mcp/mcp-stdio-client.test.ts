import { describe, expect, it } from "bun:test";
import { McpStdioClient } from "../../src/mcp/mcp-stdio-client.ts";

const fixturePath = new URL("./fixtures/echo-mcp-server.ts", import.meta.url).pathname;

function createClient(): McpStdioClient {
    return new McpStdioClient({
        name: "echo",
        command: process.execPath,
        args: [fixturePath],
        requestTimeoutMs: 5_000,
    });
}

describe("McpStdioClient", () => {
    it("initialize 后列出工具，并能调用只读工具", async () => {
        const client = createClient();
        try {
            await client.start();
            expect(client.serverName).toBe("echo");
            const names = client.descriptors.map((descriptor) => descriptor.name).sort();
            expect(names).toEqual(["echo", "write_note"]);
            const echo = client.descriptors.find((descriptor) => descriptor.name === "echo");
            expect(echo?.readOnly).toBe(true);
            const result = await client.callTool("echo", { text: "hi" }) as {
                content: { type: string; text: string }[];
            };
            expect(result.content[0]?.text).toBe("echo:hi");
        } finally {
            await client.close();
        }
    });

    it("未知工具返回 MCP 错误", async () => {
        const client = createClient();
        try {
            await client.start();
            await expect(client.callTool("missing", {})).rejects.toThrow("未知工具");
        } finally {
            await client.close();
        }
    });

    it("command 不存在时 start 拒绝", async () => {
        const client = new McpStdioClient({
            name: "missing",
            command: "/nonexistent/mcp-server-binary",
            requestTimeoutMs: 1_000,
        });
        await expect(client.start()).rejects.toThrow();
    });
});
