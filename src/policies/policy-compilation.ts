import type { PiTemplateSpec } from "../templates/harness-template.ts";
import type { EffectivePolicySnapshot } from "./effective-policy.ts";

export interface PiCompiledPolicy {
    readonly runtimeKind: "PI";
    readonly provider: string;
    readonly modelId: string;
    readonly tools: readonly string[];
    readonly skills: readonly string[];
    readonly policySnapshotId: string;
}

export interface PolicyCompilationRecord {
    readonly id: string;
    readonly snapshotId: string;
    readonly runtimeKind: "PI";
    readonly status: "APPLIED" | "REJECTED" | "DEGRADED";
    readonly compiled: PiCompiledPolicy | null;
    readonly reasons: readonly string[];
    readonly createdAt: string;
}

export function compilePiPolicy(
    template: PiTemplateSpec,
    snapshot: EffectivePolicySnapshot,
): PiCompiledPolicy {
    const model = `${template.provider}/${template.modelId}`;
    if (
        snapshot.allowedModels !== null
        && !snapshot.allowedModels.includes(model)
    ) {
        throw new Error(`有效策略不允许模型：${model}`);
    }

    const allowedTools = snapshot.allowedTools === null
        ? new Set(template.tools)
        : new Set(snapshot.allowedTools);
    const tools = template.tools.filter((tool) => allowedTools.has(tool));
    const templateSkills = template.skills ?? [];
    const allowedSkills = snapshot.allowedSkills === null
        ? new Set(templateSkills)
        : new Set(snapshot.allowedSkills);
    const skills = templateSkills.filter((skill) => allowedSkills.has(skill));

    return Object.freeze({
        runtimeKind: "PI",
        provider: template.provider,
        modelId: template.modelId,
        tools: Object.freeze(tools),
        skills: Object.freeze(skills),
        policySnapshotId: snapshot.id,
    });
}
