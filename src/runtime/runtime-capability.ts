export type RuntimeKind = "PI";

export type RuntimeCapability =
    | "SESSION_CREATE"
    | "SESSION_RESUME"
    | "SESSION_FORK"
    | "CROSS_HOST_RESUME"
    | "INTERRUPT"
    | "WORKSPACE_REUSE"
    | "TOOL_INTERCEPTION"
    | "TOOL_RESULT_REUSE"
    | "SIDE_EFFECT_EVIDENCE"
    | "NATIVE_SANDBOX"
    | "EXTERNAL_SANDBOX"
    | "MODEL_USAGE"
    | "MODEL_EVENTS"
    | "RAW_RUNTIME_EVENTS";

export interface RuntimeCapabilityProfile {
    readonly id: string;
    readonly runtimeKind: RuntimeKind;
    readonly deploymentKey: string;
    readonly supported: readonly RuntimeCapability[];
    readonly auditCompleteness: "FULL" | "PARTIAL";
    readonly reportedAt: string;
}

export interface CapabilityRequirement {
    readonly required: readonly RuntimeCapability[];
    readonly optional: readonly RuntimeCapability[];
}

export interface CapabilityValidation {
    readonly accepted: boolean;
    readonly missingRequired: readonly RuntimeCapability[];
    readonly missingOptional: readonly RuntimeCapability[];
}

export function createRuntimeCapabilityProfile(
    profile: RuntimeCapabilityProfile,
): RuntimeCapabilityProfile {
    assertNonEmpty(profile.id, "id");
    assertNonEmpty(profile.deploymentKey, "deploymentKey");
    assertNonEmpty(profile.reportedAt, "reportedAt");

    const supported = uniqueCapabilities(profile.supported, "supported");

    return Object.freeze({
        ...profile,
        supported: Object.freeze(supported),
    });
}

export function validateRuntimeCapabilities(
    profile: RuntimeCapabilityProfile,
    requirement: CapabilityRequirement,
): CapabilityValidation {
    const supported = new Set(profile.supported);
    const required = uniqueCapabilities(requirement.required, "required");
    const optional = uniqueCapabilities(requirement.optional, "optional");
    const missingRequired = required.filter((item) => !supported.has(item));
    const missingOptional = optional.filter((item) => !supported.has(item));

    return Object.freeze({
        accepted: missingRequired.length === 0,
        missingRequired: Object.freeze(missingRequired),
        missingOptional: Object.freeze(missingOptional),
    });
}

export function createPiCapabilityProfile(
    id: string,
    deploymentKey: string,
    reportedAt = new Date().toISOString(),
): RuntimeCapabilityProfile {
    return createRuntimeCapabilityProfile({
        id,
        runtimeKind: "PI",
        deploymentKey,
        supported: [
            "SESSION_CREATE",
            "SESSION_RESUME",
            "INTERRUPT",
            "WORKSPACE_REUSE",
            "TOOL_INTERCEPTION",
            "TOOL_RESULT_REUSE",
            "SIDE_EFFECT_EVIDENCE",
            "EXTERNAL_SANDBOX",
            "MODEL_USAGE",
            "MODEL_EVENTS",
        ],
        auditCompleteness: "PARTIAL",
        reportedAt,
    });
}

function uniqueCapabilities(
    capabilities: readonly RuntimeCapability[],
    field: string,
): RuntimeCapability[] {
    const unique = new Set(capabilities);
    if (unique.size !== capabilities.length) {
        throw new Error(`${field} 不能包含重复能力`);
    }
    return [...unique];
}

function assertNonEmpty(value: string, field: string): void {
    if (value.trim().length === 0) {
        throw new Error(`${field} 不能为空`);
    }
}
