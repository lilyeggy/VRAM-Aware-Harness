import { resolve } from "node:path";
import type { SandboxEnforcementCapabilities } from "../sandbox/sandbox-provider.ts";
import { isWithin } from "../utils/path-utils.ts";
import type { EffectivePolicyStore } from "./effective-policy-store.ts";

/**
 * 策略守卫需要的工具调用视图：与 tools/ExecuteToolInput 结构兼容，但
 * 在 policies 层独立声明——policies 不再反向依赖 tools，tools 层注入时
 * 由 TypeScript 结构化匹配自动满足。
 */
export interface ToolPolicyCheckInput {
    runId: string;
    toolCallId: string;
    toolName: string;
    arguments: unknown;
    policySnapshotId?: string;
    workspacePath?: string;
    sandboxEnforcement?: SandboxEnforcementCapabilities;
}

export interface ToolPolicyGuard {
    assertAllowed(input: ToolPolicyCheckInput): void;
}

export class PersistentToolPolicyGuard implements ToolPolicyGuard {
    constructor(private readonly policies: EffectivePolicyStore) {}

    assertAllowed(input: ToolPolicyCheckInput): void {
        if (input.policySnapshotId === undefined) {
            return;
        }
        const snapshot = this.policies.getSnapshot(input.policySnapshotId);
        if (snapshot === null || snapshot.runId !== input.runId) {
            throw new Error(`找不到 Run 的有效策略快照：${input.runId}`);
        }

        let denial: string | null = null;
        if (
            snapshot.allowedTools !== null
            && !snapshot.allowedTools.includes(input.toolName)
        ) {
            denial = `策略不允许工具：${input.toolName}`;
        } else if (input.toolName === "bash") {
            const enforcement = input.sandboxEnforcement;
            if (!snapshot.allowProcess) {
                denial = "策略禁止工具启动进程";
            } else if (
                !snapshot.allowNetwork
                && enforcement?.networkPolicyEnforced !== true
            ) {
                denial = "执行环境无法落实禁网策略，拒绝 bash";
            } else if (
                snapshot.workspaceRoots !== null
                && enforcement?.filesystemIsolation !== true
            ) {
                denial = "执行环境无法隔离 Workspace，拒绝 bash";
            } else if (
                enforcement?.toolExecutionBoundary === "SANDBOX"
                && enforcement.processIsolation !== true
            ) {
                denial = "Sandbox 未提供进程隔离，拒绝 bash";
            }
        } else {
            const path = toolPath(input.arguments, input.workspacePath);
            if (
                path !== null
                && snapshot.workspaceRoots !== null
                && !snapshot.workspaceRoots.some((root) => isWithin(path, root))
            ) {
                denial = `工具路径超出 Workspace 策略：${path}`;
            }
        }

        this.policies.recordToolDecision({
            id: crypto.randomUUID(),
            snapshotId: snapshot.id,
            runId: input.runId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            action: denial === null ? "ALLOW" : "DENY",
            reason: denial ?? "有效策略允许工具调用",
            decidedAt: new Date().toISOString(),
        });
        if (denial !== null) {
            throw new Error(denial);
        }
    }
}

function toolPath(argumentsValue: unknown, workspacePath?: string): string | null {
    if (
        typeof argumentsValue !== "object"
        || argumentsValue === null
        || Array.isArray(argumentsValue)
    ) return null;
    const record = argumentsValue as Record<string, unknown>;
    const value = record.path ?? record.filePath;
    if (typeof value !== "string") return null;
    return resolve(workspacePath ?? process.cwd(), value);
}
