import { resolve } from "node:path";
import type { SandboxProfile } from "../sandbox/sandbox-profile.ts";
import { isWithin } from "../utils/path-utils.ts";

// 兼容既有从本模块导入 isWithin 的调用方。
export { isWithin } from "../utils/path-utils.ts";

export type PolicyLayerKind =
    | "PLATFORM"
    | "USER"
    | "TEMPLATE"
    | "WORKSPACE"
    | "RUN";

export interface ResourceLimits {
    readonly cpuCores: number | null;
    readonly memoryMiB: number | null;
    readonly diskMiB: number | null;
}

export interface PolicyConstraints {
    /** Optional policy request; the managed runtime supplies the immutable default. */
    readonly sandboxProfile?: SandboxProfile | null;
    readonly allowedTools: readonly string[] | null;
    readonly allowedSkills: readonly string[] | null;
    readonly allowedModels: readonly string[] | null;
    readonly workspaceRoots: readonly string[] | null;
    readonly allowNetwork: boolean;
    readonly allowProcess: boolean;
    readonly allowedSecrets: readonly string[] | null;
    readonly resourceLimits: ResourceLimits;
}

export interface PolicyLayer extends PolicyConstraints {
    readonly id: string;
    readonly kind: PolicyLayerKind;
}

export interface EffectivePolicySnapshot extends PolicyConstraints {
    readonly id: string;
    readonly runId: string;
    readonly userId: string;
    readonly layers: readonly PolicyLayer[];
    readonly createdAt: string;
}

export const unrestrictedPolicy: PolicyConstraints = Object.freeze({
    sandboxProfile: null,
    allowedTools: null,
    allowedSkills: null,
    allowedModels: null,
    workspaceRoots: null,
    allowNetwork: true,
    allowProcess: true,
    allowedSecrets: null,
    resourceLimits: Object.freeze({
        cpuCores: null,
        memoryMiB: null,
        diskMiB: null,
    }),
});

export function createPolicyLayer(
    id: string,
    kind: PolicyLayerKind,
    constraints: PolicyConstraints = unrestrictedPolicy,
): PolicyLayer {
    if (id.trim().length === 0) {
        throw new Error("PolicyLayer id 不能为空");
    }
    return Object.freeze({
        id,
        kind,
        ...freezeConstraints(constraints),
    });
}

export function computeEffectivePolicy(input: {
    id: string;
    runId: string;
    userId: string;
    layers: readonly PolicyLayer[];
    createdAt: string;
}): EffectivePolicySnapshot {
    const kinds = new Set(input.layers.map((layer) => layer.kind));
    for (const kind of ["PLATFORM", "USER", "TEMPLATE", "WORKSPACE", "RUN"] as const) {
        if (!kinds.has(kind)) {
            throw new Error(`缺少策略层：${kind}`);
        }
    }

    let effective = unrestrictedPolicy;
    for (const layer of input.layers) {
        effective = intersectConstraints(effective, layer);
    }
    return Object.freeze({
        id: input.id,
        runId: input.runId,
        userId: input.userId,
        layers: Object.freeze([...input.layers]),
        createdAt: input.createdAt,
        ...freezeConstraints(effective),
    });
}

function intersectConstraints(
    left: PolicyConstraints,
    right: PolicyConstraints,
): PolicyConstraints {
    return {
        sandboxProfile: intersectSandboxProfiles(
            left.sandboxProfile ?? null,
            right.sandboxProfile ?? null,
        ),
        allowedTools: intersectValues(left.allowedTools, right.allowedTools),
        allowedSkills: intersectValues(left.allowedSkills, right.allowedSkills),
        allowedModels: intersectValues(left.allowedModels, right.allowedModels),
        workspaceRoots: intersectRoots(left.workspaceRoots, right.workspaceRoots),
        allowNetwork: left.allowNetwork && right.allowNetwork,
        allowProcess: left.allowProcess && right.allowProcess,
        allowedSecrets: intersectValues(left.allowedSecrets, right.allowedSecrets),
        resourceLimits: {
            cpuCores: minimum(left.resourceLimits.cpuCores, right.resourceLimits.cpuCores),
            memoryMiB: minimum(left.resourceLimits.memoryMiB, right.resourceLimits.memoryMiB),
            diskMiB: minimum(left.resourceLimits.diskMiB, right.resourceLimits.diskMiB),
        },
    };
}

function intersectValues(
    left: readonly string[] | null,
    right: readonly string[] | null,
): string[] | null {
    if (left === null) return right === null ? null : [...new Set(right)];
    if (right === null) return [...new Set(left)];
    const rightSet = new Set(right);
    return [...new Set(left)].filter((item) => rightSet.has(item));
}

function intersectRoots(
    left: readonly string[] | null,
    right: readonly string[] | null,
): string[] | null {
    if (left === null) return right === null ? null : right.map((item) => resolve(item));
    if (right === null) return left.map((item) => resolve(item));
    const roots = new Set<string>();
    for (const leftRoot of left.map((item) => resolve(item))) {
        for (const rightRoot of right.map((item) => resolve(item))) {
            if (isWithin(leftRoot, rightRoot)) roots.add(leftRoot);
            else if (isWithin(rightRoot, leftRoot)) roots.add(rightRoot);
        }
    }
    return [...roots];
}

/**
 * B2 网络边界：请求级策略显式要求联网，而平台/用户交集后的有效策略不允许联网时，
 * 必须 fail-closed 拒绝该 Run，而不是静默降级为“无网运行”。
 *
 * 背景：`computeEffectivePolicy` 对布尔权限取交集（deny wins），因此
 * `runPolicy.allowNetwork=true` 会被平台层的 `allowNetwork=false` 吞掉；
 * 若不在执行前显式拒绝，Provider 只会看到 effective=false 并正常创建 VM。
 */
/**
 * §9.8 v1.4 Phase 3：确定性的策略拒绝（不是可重试的瞬时故障）。
 * RunService 的重试器必须把这类错误排除在退避重试之外，否则策略违规
 * 会被反复重试而不是 fail-closed 到 INTERRUPTED。
 */
export class PolicyRejectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PolicyRejectionError";
    }
}

export function assertNetworkRequestAllowed(
    requested: PolicyConstraints | undefined,
    effective: Pick<EffectivePolicySnapshot, "allowNetwork">,
): void {
    if (requested?.allowNetwork === true && effective.allowNetwork === false) {
        throw new PolicyRejectionError(
            "allowNetwork=true 被平台策略拒绝：本部署 microVM 不提供网卡服务，"
            + "请将 runPolicy.allowNetwork 设为 false。",
        );
    }
}

export function withSandboxProfile(
    snapshot: EffectivePolicySnapshot,
    profile: SandboxProfile,
): EffectivePolicySnapshot {
    // An explicit policy profile is already part of the immutable snapshot.
    // The process configuration is only the fallback for legacy/default layers;
    // the ProviderRouter will still reject an unavailable requested profile.
    if (snapshot.sandboxProfile !== null && snapshot.sandboxProfile !== undefined) {
        return snapshot;
    }
    return Object.freeze({
        ...snapshot,
        sandboxProfile: profile,
    });
}

function intersectSandboxProfiles(    left: SandboxProfile | null,
    right: SandboxProfile | null,
): SandboxProfile | null {
    if (left === null) return right;
    if (right === null || left === right) return left;
    throw new Error(`Sandbox profile 策略冲突：${left} 与 ${right}`);
}

function minimum(left: number | null, right: number | null): number | null {
    if (left === null) return right;
    if (right === null) return left;
    return Math.min(left, right);
}

function freezeConstraints(value: PolicyConstraints): PolicyConstraints {
    const freezeList = (items: readonly string[] | null) =>
        items === null ? null : Object.freeze([...new Set(items)]);
    return {
        sandboxProfile: value.sandboxProfile ?? null,
        allowedTools: freezeList(value.allowedTools),
        allowedSkills: freezeList(value.allowedSkills),
        allowedModels: freezeList(value.allowedModels),
        workspaceRoots: freezeList(
            value.workspaceRoots?.map((item) => resolve(item)) ?? null,
        ),
        allowNetwork: value.allowNetwork,
        allowProcess: value.allowProcess,
        allowedSecrets: freezeList(value.allowedSecrets),
        resourceLimits: Object.freeze({ ...value.resourceLimits }),
    };
}
