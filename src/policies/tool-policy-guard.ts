import { resolve } from "node:path";
import type { ExecuteToolInput } from "../tools/tool-gateway.ts";
import { isWithin } from "./effective-policy.ts";
import type { EffectivePolicyStore } from "./effective-policy-store.ts";

export interface ToolPolicyGuard {
    assertAllowed(input: ExecuteToolInput): void;
}

export class PersistentToolPolicyGuard implements ToolPolicyGuard {
    constructor(private readonly policies: EffectivePolicyStore) {}

    assertAllowed(input: ExecuteToolInput): void {
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
        } else if (
            input.toolName === "bash"
            && (
                !snapshot.allowProcess
                || !snapshot.allowNetwork
                || snapshot.workspaceRoots !== null
            )
        ) {
            denial = !snapshot.allowProcess
                ? "策略禁止工具启动进程"
                : !snapshot.allowNetwork
                    ? "无法证明 bash 命令不访问网络，按策略拒绝"
                    : "MANAGED_LOCAL 无法证明 bash 不越过 Workspace，按策略拒绝";
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
