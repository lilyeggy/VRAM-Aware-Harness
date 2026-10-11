import type { McpServerConfig, McpToolDescriptor } from "./mcp-protocol.ts";
import { McpStdioClient } from "./mcp-stdio-client.ts";

/**
 * 多 MCP server 注册表。
 *
 * 启动时逐个 initialize + tools/list；单个 server 失败只记录错误并跳过，
 * 保证 MCP 是可选增强而不是平台启动的单点。
 */
export class McpToolRegistry {
    private readonly clients = new Map<string, McpStdioClient>();
    private readonly tools: McpToolDescriptor[] = [];
    private started = false;

    constructor(private readonly servers: readonly McpServerConfig[]) {}

    get configuredServerCount(): number {
        return this.servers.length;
    }

    get connectedServerCount(): number {
        return this.clients.size;
    }

    async start(): Promise<void> {
        if (this.started === true) {
            return;
        }
        this.started = true;
        for (const server of this.servers) {
            if (this.clients.has(server.name)) {
                console.error(`[mcp] 忽略重复的 server 名称：${server.name}`);
                continue;
            }
            const client = new McpStdioClient(server);
            try {
                await client.start();
            } catch (error) {
                console.error(`[mcp] server ${server.name} 启动失败，已跳过：`, error);
                await client.close();
                continue;
            }
            this.clients.set(server.name, client);
            for (const descriptor of client.descriptors) {
                this.tools.push(descriptor);
            }
        }
    }

    listTools(): readonly McpToolDescriptor[] {
        return this.tools;
    }

    async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
        const client = this.clients.get(serverName);
        if (client === undefined) {
            throw new Error(`MCP server 不可用：${serverName}`);
        }
        return await client.callTool(toolName, args);
    }

    async close(): Promise<void> {
        const clients = [...this.clients.values()];
        this.clients.clear();
        this.tools.length = 0;
        this.started = false;
        await Promise.allSettled(clients.map((client) => client.close()));
    }
}
