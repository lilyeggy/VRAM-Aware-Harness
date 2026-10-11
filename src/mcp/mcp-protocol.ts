/**
 * §9.8 v1.4 Phase 4：MCP（Model Context Protocol）接入的最小协议类型。
 *
 * 只覆盖 stdio 传输的 initialize / tools/list / tools/call。
 * resources / prompts / sampling 不在本平台边界内。
 */

export interface McpServerConfig {
    readonly name: string;
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Record<string, string>;
    readonly cwd?: string;
    readonly requestTimeoutMs?: number;
}

export interface McpToolDescriptor {
    readonly serverName: string;
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly readOnly: boolean;
}

export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
    if (raw === undefined) {
        return [];
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`HARNESS_MCP_SERVERS 不是合法 JSON：${message}`);
    }
    if (Array.isArray(parsed) === false) {
        throw new Error("HARNESS_MCP_SERVERS 必须是数组");
    }
    const servers: McpServerConfig[] = [];
    for (let index = 0; index < parsed.length; index += 1) {
        servers.push(parseServerEntry(parsed[index], index));
    }
    return servers;
}

export function sanitizeMcpToolSegment(segment: string): string {
    const sanitized = segment.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (sanitized.length === 0) {
        return "tool";
    }
    return sanitized;
}

function parseServerEntry(entry: unknown, index: number): McpServerConfig {
    if (isRecord(entry) === false) {
        throw new Error(`HARNESS_MCP_SERVERS[${index}] 必须是对象`);
    }
    const name = entry.name;
    const command = entry.command;
    if (isNonEmptyString(name) === false) {
        throw new Error(`HARNESS_MCP_SERVERS[${index}].name 必须是非空字符串`);
    }
    if (isNonEmptyString(command) === false) {
        throw new Error(`HARNESS_MCP_SERVERS[${index}].command 必须是非空字符串`);
    }

    const args = entry.args;
    if (args === undefined) {
        // 无参数
    } else if (isStringArray(args) === false) {
        throw new Error(`HARNESS_MCP_SERVERS[${index}].args 必须是字符串数组`);
    }

    const env = entry.env;
    if (env === undefined) {
        // 无额外环境变量
    } else if (isStringRecord(env) === false) {
        throw new Error(`HARNESS_MCP_SERVERS[${index}].env 必须是字符串映射`);
    }

    const cwd = entry.cwd;
    if (cwd === undefined) {
        // 继承当前工作目录
    } else if (typeof cwd === "string") {
        // ok
    } else {
        throw new Error(`HARNESS_MCP_SERVERS[${index}].cwd 必须是字符串`);
    }

    const requestTimeoutMs = entry.requestTimeoutMs;
    if (requestTimeoutMs === undefined) {
        // 使用默认超时
    } else if (typeof requestTimeoutMs === "number" && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
        // ok
    } else {
        throw new Error(`HARNESS_MCP_SERVERS[${index}].requestTimeoutMs 必须是正数`);
    }

    return {
        name,
        command,
        ...(args === undefined ? {} : { args }),
        ...(env === undefined ? {} : { env }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    if (value === null) {
        return false;
    }
    if (typeof value === "object") {
        if (Array.isArray(value)) {
            return false;
        }
        return true;
    }
    return false;
}

function isNonEmptyString(value: unknown): value is string {
    if (typeof value === "string") {
        return value.trim().length > 0;
    }
    return false;
}

function isStringArray(value: unknown): value is string[] {
    if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item === "string") {
                continue;
            }
            return false;
        }
        return true;
    }
    return false;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (isRecord(value) === false) {
        return false;
    }
    for (const item of Object.values(value)) {
        if (typeof item === "string") {
            continue;
        }
        return false;
    }
    return true;
}
