import { expect, test } from "bun:test";

import {
    HarnessHttpApi,
    type HarnessHttpApplication,
    type HttpAccessControl,
} from "../../src/http/harness-http-api.ts";

const timestamp = "2026-09-15T12:00:00.000Z";

/**
 * 内存版工作区服务。记录每一个被创建的工作区，用于断言"自动建了几个、
 * 根目录是什么"——这正是预热池能否命中的前提。
 */
function memoryWorkspaceService() {
    const created: {
        id: string; tenantId: string; name: string; rootPath: string; createdAt: string;
    }[] = [];
    return {
        created,
        create(tenantId: string, name: string) {
            const id = `ws-${created.length + 1}`;
            const workspace = {
                id, tenantId, name,
                rootPath: `/srv/workspaces/${tenantId}/${id}`,
                createdAt: timestamp,
            };
            created.push(workspace);
            return workspace;
        },
        getForTenant(id: string, tenantId: string) {
            return created.find((item) => item.id === id && item.tenantId === tenantId) ?? null;
        },
        listForTenant(tenantId: string) {
            return created.filter((item) => item.tenantId === tenantId);
        },
    };
}

function buildApi() {
    const workspaces = memoryWorkspaceService();
    const conversations = new Map<string, {
        id: string; tenantId: string; workspaceId: string; createdAt: string; updatedAt: string;
    }>();
    const runs: { id: string; workspacePath: string; harnessSessionId: string }[] = [];

    const application = {
        isStarted: () => true,
        submitRun(input: { tenantId: string; harnessSessionId: string; userInput: string; workspacePath: string }) {
            const run = {
                id: `run-${runs.length + 1}`,
                tenantId: input.tenantId,
                harnessSessionId: input.harnessSessionId,
                status: "QUEUED",
                userInput: input.userInput,
                workspacePath: input.workspacePath,
                createdAt: timestamp, updatedAt: timestamp,
                startedAt: null, finishedAt: null,
                checkpointId: null, failureReason: null,
            };
            runs.push(run);
            return run;
        },
        getRun: () => null,
        getRunsForTenant: () => [],
        getRunEvents: () => [],
        getRunOutput: () => ({ chunks: [], finalText: "" }),
        getRunWorkspaceDiff: () => null,
        getRunArtifacts: () => [],
        getRunArtifact: async () => null,
        getRunDecisions: () => [],
        getQueue: () => [],
        observeResources: async () => ({
            ok: false as const, observedAt: timestamp,
            attemptedSources: [], reason: "UNAVAILABLE" as const, message: "测试环境",
        }),
        interruptRun: async () => { throw new Error("本测试不使用 interruptRun"); },
        resumeRun: () => { throw new Error("本测试不使用 resumeRun"); },
        createConversation(input: { tenantId: string; workspaceId: string; title?: string }) {
            const id = `conv-${conversations.size + 1}`;
            const conversation = {
                id, tenantId: input.tenantId, workspaceId: input.workspaceId,
                createdAt: timestamp, updatedAt: timestamp,
            };
            conversations.set(id, conversation);
            return conversation;
        },
        getConversation(id: string, tenantId: string) {
            const conversation = conversations.get(id) ?? null;
            return conversation !== null && conversation.tenantId === tenantId
                ? conversation
                : null;
        },
        getRunsForConversation: (_tenantId: string, conversationId: string) =>
            runs.filter((run) => run.harnessSessionId === conversationId),
    } as unknown as HarnessHttpApplication;

    const accessControl = {
        authenticate: (rawKey: string) =>
            rawKey === "good-key" ? { tenantId: "tenant-a", scopes: ["*"] } : null,
        workspaceService: workspaces,
    } as unknown as HttpAccessControl;

    const api = new HarnessHttpApi(application, { get: () => null }, accessControl);

    const call = (path: string, body: unknown) => api.fetch(new Request(`http://h${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer good-key" },
        body: JSON.stringify(body),
    }));

    return { call, workspaces, runs, conversations };
}

test("建会话时不传工作区，会自动建一个并绑到会话上", async () => {
    const { call, workspaces, conversations } = buildApi();

    const response = await call("/conversations", { title: "第一次对话" });
    expect(response.status).toBe(201);
    const body = await response.json() as { conversation: { id: string; workspaceId: string } };

    // 自动建了恰好一个工作区，并且会话绑在它上面
    expect(workspaces.created).toHaveLength(1);
    expect(body.conversation.workspaceId).toBe(workspaces.created[0]!.id);
    // 名字不能用会话标题（可能含中文，过不了命名校验），走时间戳加随机后缀
    expect(workspaces.created[0]!.name).toMatch(/^conv-\d{14}-[0-9a-f]{8}$/);
    expect(conversations.size).toBe(1);
});

test("同一会话的多条消息共用同一个工作区路径", async () => {
    const { call, workspaces, runs } = buildApi();

    const created = await call("/conversations", {});
    const { conversation } = await created.json() as { conversation: { id: string } };

    for (const text of ["第一轮", "第二轮", "第三轮"]) {
        const response = await call(`/conversations/${conversation.id}/messages`, { userInput: text });
        expect(response.status).toBe(202);
    }

    // 三次 Run 的 workspacePath 必须完全一致：这正是预热池能反复命中的前提
    expect(runs).toHaveLength(3);
    const paths = new Set(runs.map((run) => run.workspacePath));
    expect(paths.size).toBe(1);
    expect([...paths][0]).toBe(workspaces.created[0]!.rootPath);
});

test("不同会话各自拿到一个工作区，路径互不相同", async () => {
    const { call, workspaces, runs } = buildApi();

    const first = await (await call("/conversations", {})).json() as { conversation: { id: string } };
    const second = await (await call("/conversations", {})).json() as { conversation: { id: string } };

    await call(`/conversations/${first.conversation.id}/messages`, { userInput: "a" });
    await call(`/conversations/${second.conversation.id}/messages`, { userInput: "b" });

    expect(workspaces.created).toHaveLength(2);
    // 会话之间不共享目录 —— 隔离没有被复用换掉
    expect(new Set(runs.map((run) => run.workspacePath)).size).toBe(2);
});

test("显式指定工作区仍走归属校验，拿不到别人的工作区", async () => {
    const { call, workspaces } = buildApi();
    const mine = workspaces.create("tenant-a", "explicit-ws");

    const ok = await call("/conversations", { workspaceId: mine.id });
    expect(ok.status).toBe(201);
    const body = await ok.json() as { conversation: { workspaceId: string } };
    expect(body.conversation.workspaceId).toBe(mine.id);

    const foreign = await call("/conversations", { workspaceId: "ws-not-mine" });
    expect(foreign.status).toBe(404);
    // 失败的请求不应该偷偷再建一个工作区
    expect(workspaces.created).toHaveLength(1);
});
