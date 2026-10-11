/**
 * §9.8 v1.4 Phase 4：MCP 接入烟测。
 *
 * 默认拉起仓库内最小 echo MCP server，验证 initialize / tools/list /
 * tools/call 全链路；也可用 HARNESS_MCP_SERVERS 指向真实 MCP server 列表
 * （与 Master 使用同一份 JSON 配置）。
 *
 * 用法：
 *   bun run scripts/mcp-smoke.ts
 *   HARNESS_MCP_SERVERS='[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/data"]}]' \
 *     bun run scripts/mcp-smoke.ts
 */
import { McpToolRegistry } from "../src/mcp/mcp-tool-registry.ts";
import { parseMcpServers, type McpServerConfig } from "../src/mcp/mcp-protocol.ts";

const fixturePath = new URL("../tests/mcp/fixtures/echo-mcp-server.ts", import.meta.url).pathname;

const configured = parseMcpServers(process.env.HARNESS_MCP_SERVERS);
const servers: McpServerConfig[] = configured.length === 0
    ? [{ name: "echo", command: process.execPath, args: [fixturePath], requestTimeoutMs: 5_000 }]
    : configured;

const registry = new McpToolRegistry(servers);
try {
    await registry.start();
    const tools = registry.listTools();
    if (registry.connectedServerCount === 0) {
        throw new Error("没有可用的 MCP server");
    }
    const echo = tools.find((descriptor) => descriptor.name === "echo");
    let callResult = "skipped";
    if (echo) {
        const result = await registry.callTool(echo.serverName, "echo", { text: "smoke" }) as {
            content?: { text?: string }[];
        };
        callResult = result.content?.[0]?.text ?? "empty";
    }
    console.log(
        `MCP_SMOKE_OK servers=${registry.connectedServerCount} `
        + `tools=${tools.length} call=${callResult}`,
    );
} catch (error) {
    console.error("MCP_SMOKE_FAIL", error);
    process.exitCode = 1;
} finally {
    await registry.close();
}
