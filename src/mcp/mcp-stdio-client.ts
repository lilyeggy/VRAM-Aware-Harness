import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
    isRecord,
    type McpServerConfig,
    type McpToolDescriptor,
} from "./mcp-protocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 最小 MCP stdio 客户端：换行分隔 JSON-RPC。
 *
 * 只支持 initialize / tools/list / tools/call。任何启动、协议或超时错误
 * 都会以 reject 暴露给上层；注册表会跳过不可用的 server，不让单个 MCP
 * 依赖拖垮整个平台启动。
 */
export class McpStdioClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly tools: McpToolDescriptor[] = [];
    private nextRequestId = 1;
    private buffer = "";
    private closed = false;

    constructor(private readonly config: McpServerConfig) {
        this.child = spawn(config.command, [...(config.args ?? [])], {
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            env: { ...process.env, ...(config.env ?? {}) },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stdout.setEncoding("utf8");
        this.child.stdout.on("data", (chunk: string) => {
            this.consume(chunk);
        });
        this.child.stderr.setEncoding("utf8");
        this.child.stderr.on("data", (chunk: string) => {
            const text = chunk.trim();
            if (text.length > 0) {
                console.error(`[mcp:${this.config.name}] ${text}`);
            }
        });
        this.child.on("error", (error) => {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this.failAll(normalized);
        });
        this.child.on("exit", (code, signal) => {
            this.failAll(new Error(`MCP server ${this.config.name} 已退出：code=${code} signal=${signal}`));
        });
    }

    get serverName(): string {
        return this.config.name;
    }

    get descriptors(): readonly McpToolDescriptor[] {
        return this.tools;
    }

    async start(): Promise<void> {
        await this.request("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "vram-aware-harness", version: "0.1.0" },
        });
        this.notify("notifications/initialized", {});
        const result = await this.request("tools/list", {});
        for (const raw of readToolList(result)) {
            const descriptor = toDescriptor(this.config.name, raw);
            if (descriptor === null) {
                continue;
            }
            this.tools.push(descriptor);
        }
    }

    async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
        return await this.request("tools/call", { name: toolName, arguments: args });
    }

    async close(): Promise<void> {
        if (this.closed === true) {
            return;
        }
        this.closed = true;
        this.failAll(new Error(`MCP client ${this.config.name} 已关闭`));
        this.child.kill("SIGTERM");
    }

    private request(method: string, params: unknown): Promise<unknown> {
        if (this.closed === true) {
            return Promise.reject(new Error(`MCP client ${this.config.name} 已关闭`));
        }
        const id = this.nextRequestId;
        this.nextRequestId += 1;
        const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP 请求超时（${timeoutMs}ms）：${this.config.name}/${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.write({ jsonrpc: "2.0", id, method, params });
        });
    }

    private notify(method: string, params: unknown): void {
        this.write({ jsonrpc: "2.0", method, params });
    }

    private write(message: Record<string, unknown>): void {
        if (this.closed === true) {
            return;
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    private consume(chunk: string): void {
        this.buffer += chunk;
        let newlineIndex = this.buffer.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);
            if (line.length > 0) {
                this.handleLine(line);
            }
            newlineIndex = this.buffer.indexOf("\n");
        }
    }

    private handleLine(line: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            console.error(`[mcp:${this.config.name}] 无法解析的响应行：${line.slice(0, 200)}`);
            return;
        }
        if (isRecord(parsed) === false) {
            return;
        }
        const id = parsed.id;
        if (typeof id === "number") {
            // 继续处理
        } else {
            return;
        }
        const pending = this.pending.get(id);
        if (pending === undefined) {
            return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const error = parsed.error;
        if (isRecord(error)) {
            const message = typeof error.message === "string" ? error.message : "未知 MCP 错误";
            pending.reject(new Error(`MCP 错误：${message}`));
            return;
        }
        pending.resolve(parsed.result);
    }

    private failAll(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}

function readToolList(result: unknown): unknown[] {
    if (isRecord(result) === false) {
        return [];
    }
    const tools = result.tools;
    if (Array.isArray(tools)) {
        return tools;
    }
    return [];
}

function toDescriptor(serverName: string, raw: unknown): McpToolDescriptor | null {
    if (isRecord(raw) === false) {
        return null;
    }
    const name = raw.name;
    if (typeof name === "string" && name.length > 0) {
        // 继续
    } else {
        return null;
    }
    const description = typeof raw.description === "string" ? raw.description : "";
    const inputSchema = isRecord(raw.inputSchema)
        ? raw.inputSchema
        : { type: "object", properties: {} };
    const annotations = isRecord(raw.annotations) ? raw.annotations : undefined;
    const readOnly = annotations === undefined ? false : annotations.readOnlyHint === true;
    return { serverName, name, description, inputSchema, readOnly };
}
