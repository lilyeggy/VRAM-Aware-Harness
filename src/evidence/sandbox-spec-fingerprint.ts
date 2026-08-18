import { createHash } from "node:crypto";
import type { ResourceLimits } from "../policies/effective-policy.ts";
import type { SandboxSpec } from "../sandbox/sandbox-profile.ts";

/**
 * Deterministic, canonical serialization of the isolation-relevant facts of a
 * compiled SandboxSpec. Instance-local values (workspacePath) are deliberately
 * excluded so the fingerprint reflects the isolation boundary (policy + profile
 * + runtime), not where that particular run happened to live.
 */
export function canonicalSandboxSpec(spec: SandboxSpec): string {
    const canonical = {
        profile: spec.profile,
        runtime: spec.runtime,
        image: spec.image,
        userId: spec.userId,
        workspaceMount: spec.workspaceMount,
        networkMode: spec.networkMode,
        readOnlyRootfs: spec.readOnlyRootfs,
        droppedCapabilities: spec.droppedCapabilities,
        noNewPrivileges: spec.noNewPrivileges,
        pidLimit: spec.pidLimit,
        resourceLimits: orderResourceLimits(spec.resourceLimits),
        secretNames: [...spec.secretNames].sort(),
    };
    return JSON.stringify(canonical);
}

function orderResourceLimits(limits: ResourceLimits): ResourceLimits {
    return {
        cpuCores: limits.cpuCores,
        memoryMiB: limits.memoryMiB,
        diskMiB: limits.diskMiB,
    };
}

/**
 * Truncated sha-256 fingerprint of a sandbox's isolation boundary. Two compiles
 * with identical policy/profile/runtime must yield the same fingerprint; any
 * drift is a signal the boundary changed.
 */
export function fingerprintSandboxSpec(spec: SandboxSpec, length = 16): string {
    return createHash("sha256")
        .update(canonicalSandboxSpec(spec))
        .digest("hex")
        .slice(0, length);
}
