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

/**
 * 工作区视野粒度，与隔离边界同属"该 Run 被承诺了什么"的一部分，
 * 因此进 spec 指纹；而具体的挂载路径（含租户/工作区 ID）只是实例局部值。
 * NONE：该沙箱没有真实的工作区挂载（桩驱动），不得声称任何视野承诺。
 */
export type SandboxWorkspaceScope = "RUN" | "TENANT" | "NONE";

export interface SandboxSpec {
    readonly profile: SandboxProfile;
    readonly runtime: SandboxRuntime;
    readonly image: string | null;
    readonly userId: number | null;
    readonly workspaceMount: "/workspace";
    readonly workspacePath: string;
    /** 容器内 /workspace 实际绑定的宿主目录。 */
    readonly mountedRoot: string;
    readonly workspaceScope: SandboxWorkspaceScope;
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
    readonly egressProfile?: "none" | "controlled-egress" | null;
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
