/**
 * N3：把"任务没真正做完"从 COMPLETED 的伪装里解放出来。
 *
 * 受环境约束（如 fail-closed 工具治理）未完成的任务仍会走到 COMPLETED：
 * 模型的最终回答可能诚实说明"环境不支持"，但状态栏与真完成无异。
 * 这里聚合该 Run 的工具策略 DENY 账本，产出结构化的 limitations，
 * 随 Run 详情一起返回，让"已完成但受限"在 API 与 UI 层可辨识。
 * 只读聚合，不改变状态机与终态语义。
 */

export interface ToolPolicyDecisionLike {
    toolName: string;
    action: string;
    reason: string;
    decidedAt: string;
}

export interface RunLimitation {
    toolName: string;
    reason: string;
    count: number;
    lastDecidedAt: string;
}

export function summarizeToolDenials(
    decisions: readonly ToolPolicyDecisionLike[],
): RunLimitation[] {
    const byKey = new Map<string, RunLimitation>();
    for (const decision of decisions) {
        if (decision.action !== "DENY") {
            continue;
        }
        const key = `${decision.toolName}\u0000${decision.reason}`;
        const existing = byKey.get(key);
        if (existing === undefined) {
            byKey.set(key, {
                toolName: decision.toolName,
                reason: decision.reason,
                count: 1,
                lastDecidedAt: decision.decidedAt,
            });
            continue;
        }
        existing.count += 1;
        if (decision.decidedAt > existing.lastDecidedAt) {
            existing.lastDecidedAt = decision.decidedAt;
        }
    }
    return Array.from(byKey.values()).sort(
        (a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName),
    );
}
