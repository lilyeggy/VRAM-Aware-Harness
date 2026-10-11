import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isRecord, sanitizeMcpToolSegment, type McpToolDescriptor } from "./mcp-protocol.ts";
import type { McpToolRegistry } from "./mcp-tool-registry.ts";
import type { PiGatewayRunContext, ToolGatewayExecutor } from "../runtime/pi-tool-gateway.ts";

type AnyPiToolDefinition = ToolDefinition<any, any>;

/**
 * MCP 工具在 Pi 中的稳定命名：mcp__<server>__<tool>。
 * 前缀避免与内置 read/bash/edit/write 冲突；非法字符替换为下划线。
 */
export function mcpPiToolName(descriptor: McpToolDescriptor): string {
    return `mcp__${sanitizeMcpToolSegment(descriptor.serverName)}__${sanitizeMcpToolSegment(descriptor.name)}`;
}

/**
 * 把 MCP 工具描述转成 Pi 自定义工具，并用 ToolGateway 包围真实执行。
 *
 * 效果分类：MCP annotations.readOnlyHint === true 记为 READ_ONLY，
 * 其余一律 UNKNOWN_EFFECT（不能仅凭工具名猜测幂等语义）。
 */
export function createMcpPiTools(
    descriptors: readonly McpToolDescriptor[],
    registry: Pick<McpToolRegistry, "callTool">,
    gateway: ToolGatewayExecutor,
    runContext: PiGatewayRunContext,
): AnyPiToolDefinition[] {
    return descriptors.map((descriptor) => createMcpPiTool(descriptor, registry, gateway, runContext));
}

function createMcpPiTool(
    descriptor: McpToolDescriptor,
    registry: Pick<McpToolRegistry, "callTool">,
    gateway: ToolGatewayExecutor,
    runContext: PiGatewayRunContext,
): AnyPiToolDefinition {
    const toolName = mcpPiToolName(descriptor);
    const definition: AnyPiToolDefinition = {
        name: toolName,
        label: `${descriptor.serverName}/${descriptor.name}`,
        description: descriptor.description.length > 0
            ? descriptor.description
            : `MCP 工具 ${descriptor.serverName}/${descriptor.name}`,
        parameters: Type.Unsafe<Record<string, unknown>>(descriptor.inputSchema),
        async execute(toolCallId, params, _signal, _onUpdate, _context) {
            const result = await gateway.execute(
                {
                    runId: runContext.runId,
                    toolCallId,
                    toolName,
                    arguments: params,
                    effect: descriptor.readOnly ? "READ_ONLY" : "UNKNOWN_EFFECT",
                    runtimeSessionRef: runContext.getRuntimeSessionRef(),
                    lastEventSequence: runContext.getLastEventSequence(),
                    ...(runContext.getPolicySnapshotId?.() === undefined
                        ? {}
                        : { policySnapshotId: runContext.getPolicySnapshotId() }),
                    ...(runContext.workspacePath === undefined
                        ? {}
                        : { workspacePath: runContext.workspacePath }),
                    ...(runContext.getSandboxEnforcement?.() === undefined
                        ? {}
                        : { sandboxEnforcement: runContext.getSandboxEnforcement() }),
                },
                async () => toAgentToolResult(
                    await registry.callTool(
                        descriptor.serverName,
                        descriptor.name,
                        params as Record<string, unknown>,
                    ),
                ),
            );
            return result as AgentToolResult<unknown>;
        },
    };
    return definition;
}

function toAgentToolResult(result: unknown): AgentToolResult<Record<string, unknown>> {
    return {
        content: [{ type: "text", text: extractMcpText(result) }],
        details: {},
    };
}

function extractMcpText(result: unknown): string {
    if (isRecord(result) === false) {
        return stringifyUnknown(result);
    }
    if (result.isError === true) {
        throw new Error(`MCP 工具返回错误：${readContentText(result.content)}`);
    }
    const content = result.content;
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const item of content) {
            if (isRecord(item) === false) {
                parts.push(stringifyUnknown(item));
                continue;
            }
            if (item.type === "text" && typeof item.text === "string") {
                parts.push(item.text);
                continue;
            }
            parts.push(stringifyUnknown(item));
        }
        if (parts.length > 0) {
            return parts.join("\n");
        }
    }
    return stringifyUnknown(result);
}

function readContentText(content: unknown): string {
    if (Array.isArray(content) === false) {
        return stringifyUnknown(content);
    }
    const parts: string[] = [];
    for (const item of content) {
        if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
            parts.push(item.text);
        }
    }
    if (parts.length === 0) {
        return "未知错误";
    }
    return parts.join("\n");
}

function stringifyUnknown(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    try {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) {
            return String(value);
        }
        return encoded;
    } catch {
        return String(value);
    }
}
