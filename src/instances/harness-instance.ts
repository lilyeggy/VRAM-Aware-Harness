import type { RuntimeKind } from "../runtime/runtime-capability.ts";

export type HarnessInstanceDesiredState = "RUNNING" | "STOPPED";

export type HarnessInstanceActualState =
    | "PROVISIONING"
    | "READY"
    | "ACTIVE"
    | "STOPPED"
    | "FAILED";

export interface HarnessInstance {
    readonly id: string;
    readonly tenantId: string;
    readonly templateVersionId: string;
    readonly capabilityProfileId: string;
    readonly runtimeKind: RuntimeKind;
    readonly desiredState: HarnessInstanceDesiredState;
    readonly actualState: HarnessInstanceActualState;
    readonly activeRunCount: number;
    readonly failureReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface CreateHarnessInstanceInput {
    readonly id: string;
    readonly tenantId: string;
    readonly templateVersionId: string;
    readonly capabilityProfileId: string;
    readonly runtimeKind: RuntimeKind;
    readonly createdAt: string;
}

export function createHarnessInstance(
    input: CreateHarnessInstanceInput,
): HarnessInstance {
    for (const [field, value] of Object.entries(input)) {
        if (typeof value === "string" && value.trim().length === 0) {
            throw new Error(`${field} 不能为空`);
        }
    }

    return Object.freeze({
        ...input,
        desiredState: "RUNNING" as const,
        actualState: "PROVISIONING" as const,
        activeRunCount: 0,
        failureReason: null,
        updatedAt: input.createdAt,
    });
}

const actualTransitions: Readonly<Record<
    HarnessInstanceActualState,
    readonly HarnessInstanceActualState[]
>> = {
    PROVISIONING: ["READY", "FAILED", "STOPPED"],
    READY: ["ACTIVE", "FAILED", "STOPPED"],
    ACTIVE: ["READY", "FAILED", "STOPPED"],
    STOPPED: ["PROVISIONING"],
    FAILED: ["PROVISIONING", "STOPPED"],
};

export function transitionHarnessInstance(
    instance: HarnessInstance,
    actualState: HarnessInstanceActualState,
    updatedAt: string,
    failureReason: string | null = null,
): HarnessInstance {
    if (!actualTransitions[instance.actualState].includes(actualState)) {
        throw new Error(
            `非法 HarnessInstance 状态转换：${instance.actualState} -> ${actualState}`,
        );
    }
    if ((actualState === "FAILED") !== (failureReason !== null)) {
        throw new Error("FAILED Instance 必须且只能携带 failureReason");
    }

    return Object.freeze({
        ...instance,
        actualState,
        failureReason,
        updatedAt,
    });
}

export function setHarnessInstanceDesiredState(
    instance: HarnessInstance,
    desiredState: HarnessInstanceDesiredState,
    updatedAt: string,
): HarnessInstance {
    return Object.freeze({
        ...instance,
        desiredState,
        updatedAt,
    });
}
