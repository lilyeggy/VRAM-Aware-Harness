export interface Conversation {
    readonly id: string;
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export function createConversation(input: {
    id?: string;
    tenantId: string;
    workspaceId: string;
    title?: string;
    createdAt?: string;
}): Conversation {
    if (input.tenantId.trim().length === 0) throw new Error("tenantId 不能为空");
    if (input.workspaceId.trim().length === 0) throw new Error("workspaceId 不能为空");
    const now = input.createdAt ?? new Date().toISOString();
    const title = input.title?.trim() || "新对话";
    if (title.length > 120) throw new Error("对话标题最长 120 个字符");
    return Object.freeze({
        id: input.id ?? crypto.randomUUID(),
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        title,
        createdAt: now,
        updatedAt: now,
    });
}
