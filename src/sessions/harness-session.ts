export interface HarnessSession {
    readonly id: string;
    readonly userId: string;
    readonly workspaceId: string | null;
    readonly title: string | null;
    readonly runtimeSessionRef: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/** 用户前端语境中的 Conversation；存储在 harness_sessions 表。 */
export interface Conversation {
    readonly id: string;
    readonly userId: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export function createHarnessSession(
    input: Omit<
        HarnessSession,
        "runtimeSessionRef" | "updatedAt" | "workspaceId" | "title"
    > & {
        workspaceId?: string | null;
        title?: string | null;
    },
): HarnessSession {
    if (input.id.trim().length === 0) {
        throw new Error("id 不能为空");
    }
    if (input.userId.trim().length === 0) {
        throw new Error("userId 不能为空");
    }
    const workspaceId = input.workspaceId ?? null;
    const title = input.title ?? null;
    if (workspaceId !== null && workspaceId.trim().length === 0) {
        throw new Error("workspaceId 不能为空字符串");
    }
    if (title !== null && title.trim().length === 0) {
        throw new Error("title 不能为空字符串");
    }
    return Object.freeze({
        ...input,
        workspaceId,
        title,
        runtimeSessionRef: null,
        updatedAt: input.createdAt,
    });
}

export function createConversation(input: {
    id?: string;
    userId: string;
    workspaceId: string;
    title?: string;
    createdAt?: string;
}): Conversation {
    if (input.userId.trim().length === 0) {
        throw new Error("userId 不能为空");
    }
    if (input.workspaceId.trim().length === 0) {
        throw new Error("workspaceId 不能为空");
    }
    const now = input.createdAt ?? new Date().toISOString();
    const title = input.title?.trim() || "新对话";
    if (title.length > 120) {
        throw new Error("对话标题最长 120 个字符");
    }
    return Object.freeze({
        id: input.id ?? crypto.randomUUID(),
        userId: input.userId,
        workspaceId: input.workspaceId,
        title,
        createdAt: now,
        updatedAt: now,
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
