import { expect, test } from "bun:test";

import {
    createRuntimeCapabilityProfile,
    validateRuntimeCapabilities,
} from "../../src/runtime/runtime-capability.ts";

test("强制能力缺失会拒绝，非关键能力缺失只产生降级证据", () => {
    const profile = createRuntimeCapabilityProfile({
        id: "profile-1",
        runtimeKind: "PI",
        deploymentKey: "pi-local",
        supported: ["SESSION_CREATE", "INTERRUPT"],
        auditCompleteness: "PARTIAL",
        reportedAt: "2026-08-10T10:00:00.000Z",
    });

    const result = validateRuntimeCapabilities(profile, {
        required: ["SESSION_CREATE", "TOOL_INTERCEPTION"],
        optional: ["MODEL_USAGE"],
    });

    expect(result).toEqual({
        accepted: false,
        missingRequired: ["TOOL_INTERCEPTION"],
        missingOptional: ["MODEL_USAGE"],
    });
});

test("能力清单拒绝重复声明，避免能力协商语义含混", () => {
    expect(() => createRuntimeCapabilityProfile({
        id: "profile-duplicate",
        runtimeKind: "PI",
        deploymentKey: "pi-local",
        supported: ["SESSION_CREATE", "SESSION_CREATE"],
        auditCompleteness: "PARTIAL",
        reportedAt: "2026-08-10T10:00:00.000Z",
    })).toThrow("supported 不能包含重复能力");
});
