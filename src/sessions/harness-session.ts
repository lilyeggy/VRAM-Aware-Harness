export interface HarnessSession {
    readonly id: string;
    readonly tenantId: string;
    readonly instanceId: string;
    readonly runtimeSessionRef: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export function createHarnessSession(
    input: Omit<HarnessSession, "runtimeSessionRef" | "updatedAt">,
): HarnessSession {
    for (const [field, value] of Object.entries(input)) {
        if (value.trim().length === 0) {
            throw new Error(`${field} 不能为空`);
        }
    }

    return Object.freeze({
        ...input,
        runtimeSessionRef: null,
        updatedAt: input.createdAt,
    });
}

export function bindRuntimeSession(
    session: HarnessSession,
    runtimeSessionRef: string,
    updatedAt: string,
): HarnessSession {
    if (runtimeSessionRef.trim().length === 0) {
        throw new Error("runtimeSessionRef 不能为空");
    }
    return Object.freeze({
        ...session,
        runtimeSessionRef,
        updatedAt,
    });
}
