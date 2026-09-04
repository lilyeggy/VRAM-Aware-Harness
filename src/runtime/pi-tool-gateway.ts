import {
    createBashToolDefinition,
    createEditToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    type BashOperations,
    type EditOperations,
    type LsOperations,
    type ReadOperations,
    type WriteOperations,
    type AgentToolResult,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

import type {
    ExecuteToolInput,
} from "../tools/tool-gateway.ts";
import type { ToolEffect } from "../tools/tool-execution.ts";
import type {
    SandboxCommandExecutor,
    SandboxEnforcementCapabilities,
} from "../sandbox/sandbox-provider.ts";

type AnyPiToolDefinition = ToolDefinition<any, any>;

export type PiBuiltInToolName =
    | "read"
    | "bash"
    | "edit"
    | "write"
    | "grep"
    | "find"
    | "ls";

/**
 * Wrapper 只依赖 ToolGateway 的最小合同，方便不启动 SQLite/Pi 的单元测试。
 * 真实 ToolGateway 在结构上满足这个接口。
 */
export interface ToolGatewayExecutor {
    execute(
        input: ExecuteToolInput,
        invokeTool: () => Promise<unknown>,
    ): Promise<unknown>;
}

/**
 * Pi 创建 ToolDefinition 时 Session 尚未完全创建，因此这里使用 getter。
 * 真正执行工具时，PiAdapter 已经拿到 runtimeSessionRef 和最新事件位置。
 */
export interface PiGatewayRunContext {
    runId: string;
    workspacePath?: string;
    getRuntimeSessionRef(): string;
    getLastEventSequence(): number;
    getPolicySnapshotId?(): string | undefined;
    getSandboxId?(): string | undefined;
    getSandboxEnforcement?(): SandboxEnforcementCapabilities | undefined;
}

/**
 * 对实验室 MVP 采用保守分类：
 * - 只读取本地状态的工具可以自动重放；
 * - bash/edit/write 可能产生副作用，默认禁止不确定状态下自动重放。
 *
 * IDEMPOTENT_WRITE 需要具体工具明确提供幂等语义，不能仅凭工具名称猜测。
 */
export function classifyPiToolEffect(
    toolName: PiBuiltInToolName,
): ToolEffect {
    switch (toolName) {
        case "read":
        case "grep":
        case "find":
        case "ls":
            return "READ_ONLY";

        case "bash":
        case "edit":
        case "write":
            return "UNKNOWN_EFFECT";
    }
}

/**
 * 保留原 ToolDefinition 的 schema、描述和渲染逻辑，只包装 execute。
 *
 * Pi 仍然负责参数校验与工具结果格式；Gateway 只包围真实执行，
 * 在执行前后完成幂等判断和持久化。
 */
export function wrapPiToolWithGateway(
    definition: AnyPiToolDefinition,
    effect: ToolEffect,
    gateway: ToolGatewayExecutor,
    runContext: PiGatewayRunContext,
    sandboxExecutor?: SandboxCommandExecutor,
): AnyPiToolDefinition {
    return {
        ...definition,
        async execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            context,
        ) {
            const result = await gateway.execute(
                {
                    runId: runContext.runId,
                    toolCallId,
                    toolName: definition.name,
                    arguments: params,
                    effect,
                    runtimeSessionRef:
                        runContext.getRuntimeSessionRef(),
                    lastEventSequence:
                        runContext.getLastEventSequence(),
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
                () => definition.execute(
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                    context,
                ),
            );

            return result as AgentToolResult<any>;
        },
    };
}

/**
 * 创建 Pi 内置工具的 Gateway 包装版本。
 *
 * SDK 会让同名 customTools 覆盖内置定义，所以工具名称保持 read/bash 等，
 * 模型和现有 Prompt 不需要改变。
 */
export function createGatewayPiTools(
    toolNames: readonly string[],
    workspacePath: string,
    gateway: ToolGatewayExecutor,
    runContext: PiGatewayRunContext,
    sandboxExecutor?: SandboxCommandExecutor,
): AnyPiToolDefinition[] {
    return toolNames.map((toolName) => {
        if (!isPiBuiltInToolName(toolName)) {
            throw new Error(
                `ToolGateway 暂不支持 Pi 工具：${toolName}`,
            );
        }

        return wrapPiToolWithGateway(
            createPiToolDefinition(
                toolName,
                workspacePath,
                runContext.getSandboxId?.(),
                sandboxExecutor,
                runContext.getSandboxEnforcement?.(),
            ),
            classifyPiToolEffect(toolName),
            gateway,
            runContext,
        );
    });
}

function isPiBuiltInToolName(
    toolName: string,
): toolName is PiBuiltInToolName {
    return (
        toolName === "read"
        || toolName === "bash"
        || toolName === "edit"
        || toolName === "write"
        || toolName === "grep"
        || toolName === "find"
        || toolName === "ls"
    );
}

function createPiToolDefinition(
    toolName: PiBuiltInToolName,
    workspacePath: string,
    sandboxId?: string,
    sandboxExecutor?: SandboxCommandExecutor,
    enforcement?: SandboxEnforcementCapabilities,
): AnyPiToolDefinition {
    if (
        enforcement?.toolExecutionBoundary === "SANDBOX"
        && (sandboxId === undefined || sandboxExecutor === undefined)
    ) {
        throw new Error("Sandbox 工具执行边界缺少 sandboxId 或命令执行器，拒绝回退宿主机");
    }
    if (sandboxId !== undefined && sandboxExecutor === undefined) {
        throw new Error("已有 Sandbox execution context 但缺少命令执行器，拒绝回退宿主机");
    }
    if (sandboxId !== undefined && sandboxExecutor !== undefined) {
        return createSandboxedPiToolDefinition(
            toolName, workspacePath, sandboxId, sandboxExecutor,
        );
    }
    switch (toolName) {
        case "read":
            return createReadToolDefinition(workspacePath);
        case "bash":
            return createBashToolDefinition(workspacePath);
        case "edit":
            return createEditToolDefinition(workspacePath);
        case "write":
            return createWriteToolDefinition(workspacePath);
        case "grep":
            return createGrepToolDefinition(workspacePath);
        case "find":
            return createFindToolDefinition(workspacePath);
        case "ls":
            return createLsToolDefinition(workspacePath);
    }
}

function createSandboxedPiToolDefinition(
    toolName: PiBuiltInToolName,
    workspacePath: string,
    sandboxId: string,
    executor: SandboxCommandExecutor,
): AnyPiToolDefinition {
    const shell = (command: string) => executor.execute(sandboxId, ["sh", "-lc", command]);
    const containerPath = (hostPath: string) => {
        if (hostPath === workspacePath) return "/workspace";
        if (!hostPath.startsWith(`${workspacePath}/`)) {
            throw new Error(`工具路径超出 Workspace：${hostPath}`);
        }
        return `/workspace/${hostPath.slice(workspacePath.length + 1)}`;
    };
    const requestedPath = (value: unknown) => {
        const raw = typeof value === "string" && value.length > 0 ? value : ".";
        return containerPath(resolve(workspacePath, raw));
    };
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const ensure = async (command: string) => {
        const result = await shell(command);
        if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
        return result;
    };
    const fileOps = {
        readFile: async (path: string) => Buffer.from((await ensure(`cat -- ${quote(containerPath(path))}`)).stdout),
        writeFile: async (path: string, content: string) => {
            const encoded = Buffer.from(content).toString("base64");
            await ensure(`printf %s ${quote(encoded)} | base64 -d > ${quote(containerPath(path))}`);
        },
        access: async (path: string) => { await ensure(`test -r ${quote(containerPath(path))}`); },
    };
    switch (toolName) {
        case "bash": {
            const operations: BashOperations = {
                exec: async (command, _cwd, options) => {
                    const result = await shell(command);
                    options.onData(Buffer.from(`${result.stdout}${result.stderr}`));
                    return { exitCode: result.exitCode };
                },
            };
            return createBashToolDefinition(workspacePath, { operations });
        }
        case "read": return createReadToolDefinition(workspacePath, { operations: fileOps satisfies ReadOperations });
        case "write": return createWriteToolDefinition(workspacePath, { operations: {
            writeFile: fileOps.writeFile,
            mkdir: async (path) => { await ensure(`mkdir -p -- ${quote(containerPath(path))}`); },
        } satisfies WriteOperations });
        case "edit": return createEditToolDefinition(workspacePath, { operations: fileOps satisfies EditOperations });
        case "ls": {
            const operations: LsOperations = {
                exists: async (path) => (await shell(`test -e ${quote(containerPath(path))}`)).exitCode === 0,
                stat: async (path) => ({ isDirectory: () => false, ...((await shell(`test -d ${quote(containerPath(path))}`)).exitCode === 0 ? { isDirectory: () => true } : {}) }),
                readdir: async (path) => (await ensure(`ls -A1 -- ${quote(containerPath(path))}`)).stdout.split("\n").filter(Boolean),
            };
            return createLsToolDefinition(workspacePath, { operations });
        }
        case "grep": {
            const original = createPiToolDefinition(toolName, workspacePath);
            return {
                ...original,
                execute: async (_id, params) => {
                    const input = params as {
                        pattern: string; path?: string; glob?: string; ignoreCase?: boolean;
                        literal?: boolean; context?: number; limit?: number;
                    };
                    const options = [
                        "-R", "-n", "--binary-files=without-match",
                        input.ignoreCase ? "-i" : "",
                        input.literal ? "-F" : "",
                        input.context && input.context > 0 ? `-C ${Math.floor(input.context)}` : "",
                    ].filter(Boolean).join(" ");
                    const root = requestedPath(input.path);
                    const limit = Math.max(1, Math.floor(input.limit ?? 100));
                    // grep's code 1 means no match, not a failed sandbox command.
                    const scope = input.glob === undefined
                        ? quote(root)
                        : `$(find ${quote(root)} -type f -name ${quote(input.glob)})`;
                    const result = await shell(
                        `grep ${options} -- ${quote(input.pattern)} ${scope} 2>/dev/null; code=$?; `
                        + `if [ $code -gt 1 ]; then exit $code; fi; exit 0`,
                    );
                    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
                    const lines = result.stdout.split("\n").filter(Boolean).slice(0, limit);
                    return {
                        content: [{ type: "text", text: lines.length === 0
                            ? "No matches found" : lines.join("\n") }],
                        details: undefined,
                    };
                },
            };
        }
        case "find": {
            const original = createPiToolDefinition(toolName, workspacePath);
            return {
                ...original,
                execute: async (_id, params) => {
                    const input = params as { pattern: string; path?: string; limit?: number };
                    const root = requestedPath(input.path);
                    const limit = Math.max(1, Math.floor(input.limit ?? 100));
                    const result = await shell(
                        `find ${quote(root)} -type f -name ${quote(input.pattern)} -print`,
                    );
                    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
                    const lines = result.stdout.split("\n").filter(Boolean)
                        .map((item) => item.startsWith(`${root}/`) ? item.slice(root.length + 1) : item)
                        .slice(0, limit);
                    return {
                        content: [{ type: "text", text: lines.length === 0
                            ? "No files found matching pattern" : lines.join("\n") }],
                        details: undefined,
                    };
                },
            };
        }
    }
}
