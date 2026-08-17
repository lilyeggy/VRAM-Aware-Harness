import type { RuntimeCapability } from "../runtime/runtime-capability.ts";

export interface HarnessTemplate {
    readonly id: string;
    readonly tenantId: string;
    readonly createdAt: string;
}

export interface PiTemplateSpec {
    readonly runtimeKind: "PI";
    readonly provider: string;
    readonly modelId: string;
    readonly tools: readonly string[];
    readonly skills?: readonly string[];
    readonly requiredCapabilities?: readonly RuntimeCapability[];
    readonly optionalCapabilities?: readonly RuntimeCapability[];
}

export interface HarnessTemplateVersion {
    readonly id: string;
    readonly templateId: string;
    readonly version: number;
    readonly spec: PiTemplateSpec;
    readonly createdAt: string;
}

export interface CreateHarnessTemplateInput {
    readonly id: string;
    readonly tenantId: string;
    readonly createdAt: string;
}

export interface CreatePiTemplateVersionInput {
    readonly id: string;
    readonly templateId: string;
    readonly version: number;
    readonly provider: string;
    readonly modelId: string;
    readonly tools: readonly string[];
    readonly skills?: readonly string[];
    readonly requiredCapabilities?: readonly RuntimeCapability[];
    readonly optionalCapabilities?: readonly RuntimeCapability[];
    readonly createdAt: string;
}

export function createHarnessTemplate(
    input: CreateHarnessTemplateInput,
): HarnessTemplate {
    assertNonEmpty(input.id, "id");
    assertNonEmpty(input.tenantId, "tenantId");
    assertNonEmpty(input.createdAt, "createdAt");

    return Object.freeze({
        id: input.id,
        tenantId: input.tenantId,
        createdAt: input.createdAt,
    });
}

export function createPiTemplateVersion(
    input: CreatePiTemplateVersionInput,
): HarnessTemplateVersion {
    assertNonEmpty(input.id, "id");
    assertNonEmpty(input.templateId, "templateId");
    assertPositiveInteger(input.version, "version");
    assertNonEmpty(input.provider, "provider");
    assertNonEmpty(input.modelId, "modelId");
    assertNonEmpty(input.createdAt, "createdAt");
    assertValidTools(input.tools);

    const tools = Object.freeze([...input.tools]);
    const skills = input.skills === undefined
        ? undefined
        : Object.freeze(assertUniqueStrings(input.skills, "skills", true));
    const requiredCapabilities = input.requiredCapabilities === undefined
        ? undefined
        : Object.freeze([...new Set(input.requiredCapabilities)]);
    const optionalCapabilities = input.optionalCapabilities === undefined
        ? undefined
        : Object.freeze([...new Set(input.optionalCapabilities)]);
    const spec: PiTemplateSpec = Object.freeze({
        runtimeKind: "PI",
        provider: input.provider,
        modelId: input.modelId,
        tools,
        ...(skills === undefined ? {} : { skills }),
        ...(requiredCapabilities === undefined
            ? {}
            : { requiredCapabilities }),
        ...(optionalCapabilities === undefined
            ? {}
            : { optionalCapabilities }),
    });

    return Object.freeze({
        id: input.id,
        templateId: input.templateId,
        version: input.version,
        spec,
        createdAt: input.createdAt,
    });
}

function assertNonEmpty(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${field} 不能为空`);
    }
}

function assertPositiveInteger(value: number, field: string): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${field} 必须为正整数`);
    }
}

function assertValidTools(tools: readonly string[]): void {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error("tools 不能为空");
    }

    const uniqueTools = new Set<string>();
    for (const tool of tools) {
        assertNonEmpty(tool, "tool");
        if (uniqueTools.has(tool)) {
            throw new Error(`tools 不能包含重复项: ${tool}`);
        }
        uniqueTools.add(tool);
    }
}

function assertUniqueStrings(
    values: readonly string[],
    field: string,
    allowEmpty: boolean,
): string[] {
    if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
        throw new Error(`${field} 不能为空`);
    }
    const unique = new Set<string>();
    for (const value of values) {
        assertNonEmpty(value, field.slice(0, -1) || field);
        if (unique.has(value)) {
            throw new Error(`${field} 不能包含重复项: ${value}`);
        }
        unique.add(value);
    }
    return [...unique];
}
