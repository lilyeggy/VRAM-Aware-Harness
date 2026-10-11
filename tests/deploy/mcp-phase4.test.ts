import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;

function read(relative: string): string {
    return readFileSync(`${root}${relative}`, "utf8");
}

describe("§9.8 v1.4 Phase 4：MCP 接入文档与接线守卫", () => {
    it("Master 读取 HARNESS_MCP_SERVERS 并把配置下发给 Worker", () => {
        const config = read("src/app/harness-config.ts");
        expect(config).toContain("HARNESS_MCP_SERVERS");
        expect(config).toContain("mcpServers");
        const composition = read("src/app/create-harness-application.ts");
        expect(composition).toContain("new McpToolRegistry(config.mcpServers)");
        expect(composition).toContain("mcpServers: config.mcpServers");
    });

    it("Worker 按下发配置连接 MCP server 并暴露给 PiAdapter", () => {
        const worker = read("src/worker/worker-main.ts");
        expect(worker).toContain("new McpToolRegistry(config.mcpServers)");
        expect(worker).toContain("mcpTools");
        const protocol = read("src/worker/worker-protocol.ts");
        expect(protocol).toContain("mcpServers");
    });

    it(".env.example / README / 部署文档记录了 MCP 边界", () => {
        expect(read(".env.example")).toContain("HARNESS_MCP_SERVERS");
        expect(read("README.md")).toContain("MCP 工具接入（Phase 4");
        const deploy = read("docs/deployment-single-node-systemd.zh-CN.md");
        expect(deploy).toContain("HARNESS_MCP_SERVERS");
        expect(deploy).toContain("WORKER_RW_PATHS");
        expect(read("docs/platform-boundary.md")).toContain("Phase 4：9 的 MCP 接入");
    });

    it("PiAdapter 会话工具白名单包含 customTools 名称，否则 MCP 工具被 Pi 过滤", () => {
        const adapter = read("src/runtime/pi-adapter.ts");
        const matches = adapter.split("...customTools.map((tool) => tool.name)").length - 1;
        expect(matches).toBe(2);
    });

    it("提供 MCP 烟测脚本", () => {
        const smoke = read("scripts/mcp-smoke.ts");
        expect(smoke).toContain("MCP_SMOKE_OK");
        expect(smoke).toContain("McpToolRegistry");
    });
});
