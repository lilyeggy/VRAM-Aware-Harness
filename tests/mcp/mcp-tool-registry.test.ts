import { describe, expect, it } from "bun:test";
import { McpToolRegistry } from "../../src/mcp/mcp-tool-registry.ts";

const fixturePath = new URL("./fixtures/echo-mcp-server.ts", import.meta.url).pathname;

describe("McpToolRegistry", () => {
    it("启动后汇总工具，并可按 server 调用", async () => {
        const registry = new McpToolRegistry([
            {
                name: "echo",
                command: process.execPath,
                args: [fixturePath],
                requestTimeoutMs: 5_000,
            },
        ]);
        try {
            await registry.start();
            expect(registry.configuredServerCount).toBe(1);
            expect(registry.connectedServerCount).toBe(1);
            const names = registry.listTools().map((descriptor) => descriptor.name).sort();
            expect(names).toEqual(["echo", "write_note"]);
            const result = await registry.callTool("echo", "echo", { text: "reg" }) as {
                content: { text: string }[];
            };
            expect(result.content[0]?.text).toBe("echo:reg");
        } finally {
            await registry.close();
        }
    });

    it("单个 server 启动失败时跳过其余 server", async () => {
        const registry = new McpToolRegistry([
            {
                name: "broken",
                command: "/nonexistent/mcp-server-binary",
                requestTimeoutMs: 500,
            },
            {
                name: "echo",
                command: process.execPath,
                args: [fixturePath],
                requestTimeoutMs: 5_000,
            },
        ]);
        try {
            await registry.start();
            expect(registry.configuredServerCount).toBe(2);
            expect(registry.connectedServerCount).toBe(1);
            expect(registry.listTools().map((descriptor) => descriptor.serverName)).toEqual(["echo", "echo"]);
        } finally {
            await registry.close();
        }
    });

    it("不可用的 server 调用 fail-closed", async () => {
        const registry = new McpToolRegistry([]);
        await expect(registry.callTool("missing", "echo", {})).rejects.toThrow("MCP server 不可用");
    });
});
