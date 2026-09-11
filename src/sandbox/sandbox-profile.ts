import type { ResourceLimits } from "../policies/effective-policy.ts";

/**
 * User-visible execution isolation tiers. `development` is deliberately not a
 * multi-tenant production tier; it exists only for the existing local/fake
 * development path.
 */
export type SandboxProfile =
    | "development"
    | "default"
    | "restricted-egress"
    | "strict";

/** Runtime names are evidence, not an instruction to silently downgrade. */
export type SandboxRuntime =
    | "managed-local"
    | "runc"
    | "runsc"
    | "kata"
    | "firecracker";

export interface SandboxSpec {
    readonly profile: SandboxProfile;
    readonly runtime: SandboxRuntime;
    readonly image: string | null;
    readonly userId: number | null;
    readonly workspaceMount: "/workspace";
    readonly workspacePath: string;
    readonly networkMode: "none" | "bridge" | "controlled-egress";
    readonly readOnlyRootfs: boolean;
    readonly droppedCapabilities: "ALL" | "NONE";
    readonly noNewPrivileges: boolean;
    readonly pidLimit: number | null;
    readonly resourceLimits: Readonly<ResourceLimits>;
    readonly secretNames: readonly string[];
}

export interface SandboxRuntimeEvidence {
    readonly adapter: string;
    readonly requestedRuntime: SandboxRuntime;
    readonly observedRuntime: string | null;
    readonly verified: boolean;
    readonly verificationReason: string | null;
    readonly verifiedAt: string | null;
}

export function freezeSandboxSpec(spec: SandboxSpec): SandboxSpec {
    return Object.freeze({
        ...spec,
        resourceLimits: Object.freeze({ ...spec.resourceLimits }),
        secretNames: Object.freeze([...spec.secretNames]),
    });
}

export function freezeRuntimeEvidence(
    evidence: SandboxRuntimeEvidence,
): SandboxRuntimeEvidence {
    return Object.freeze({ ...evidence });
}

export function resolveSandboxProfile(
    requested: SandboxProfile | null | undefined,
    configured: SandboxProfile,
): SandboxProfile {
    return requested ?? configured;
}
