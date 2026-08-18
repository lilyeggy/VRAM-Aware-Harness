import { createHash } from "node:crypto";
import type { EffectivePolicySnapshot } from "../policies/effective-policy.ts";

/**
 * Canonical serialization of the *isolation-relevant* fields of an effective
 * policy. Purpose-identity fields (id, runId, tenantId, templateVersionId,
 * createdAt, layers metadata) are deliberately excluded: the fingerprint
 * describes "what boundary was required", not which request happened to carry
 * it. Two policies that demand the same boundary get the same fingerprint.
 */
export function canonicalPolicyBoundary(policy: EffectivePolicySnapshot): string {
    const canonical = {
        sandboxProfile: policy.sandboxProfile ?? null,
        workspaceRoots: policy.workspaceRoots === null
            ? null
            : [...policy.workspaceRoots].sort(),
        allowNetwork: policy.allowNetwork,
        allowProcess: policy.allowProcess,
        allowedSecrets: policy.allowedSecrets === null
            ? null
            : [...policy.allowedSecrets].sort(),
        resourceLimits: {
            cpuCores: policy.resourceLimits.cpuCores ?? null,
            memoryMiB: policy.resourceLimits.memoryMiB ?? null,
            diskMiB: policy.resourceLimits.diskMiB ?? null,
        },
    };
    return JSON.stringify(canonical);
}

/**
 * Truncated sha-256 of the policy's isolation boundary. Stable across sessions
 * as long as the policy keeps demanding the same boundary.
 */
export function policyBoundaryFingerprint(
    policy: EffectivePolicySnapshot,
    length = 16,
): string {
    return createHash("sha256")
        .update(canonicalPolicyBoundary(policy))
        .digest("hex")
        .slice(0, length);
}
