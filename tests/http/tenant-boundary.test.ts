import { expect, test } from "bun:test";
import { HarnessHttpApi, type HarnessHttpApplication } from "../../src/http/harness-http-api.ts";
import type { AgentRun } from "../../src/runs/agent-run.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import { AccessAuditStore } from "../../src/audit/access-audit-store.ts";

const run: AgentRun = {
    id: "run-tenant-a", tenantId: "tenant-a", harnessSessionId: "session",
    status: "QUEUED", userInput: "task", workspacePath: "/server/a", createdAt: "now",
    updatedAt: "now", startedAt: null, finishedAt: null, checkpointId: null, failureReason: null,
};

test("认证身份绑定 Tenant，伪造 tenantId 和跨租户 Run ID 都不会穿透", async () => {
    let submitted: unknown;
    let conversation: { id: string; tenantId: string; workspaceId: string; title: string; createdAt: string; updatedAt: string } | null = null;
    const application: HarnessHttpApplication = {
        isStarted: () => true,
        submitRun: (input) => { submitted = input; return { ...run, ...input }; },
        getRun: (id) => id === run.id ? run : null,
        getRunsForTenant: (tenantId) => tenantId === run.tenantId ? [run] : [],
        createConversation: (input) => conversation = { id: "conversation-a", title: input.title ?? "新对话", createdAt: "now", updatedAt: "now", ...input },
        getConversation: (id, tenantId) => conversation?.id === id && conversation.tenantId === tenantId ? conversation : null,
        getConversationsForWorkspace: (tenantId, workspaceId) => conversation?.tenantId === tenantId && conversation.workspaceId === workspaceId ? [conversation] : [],
        getRunsForConversation: (_tenantId, id) => id === conversation?.id ? [run] : [],
        getRunEvents: () => [], getRunOutput: () => ({ chunks: [], finalText: "" }), getRunWorkspaceDiff: () => null, getRunArtifacts: () => [], getRunArtifact: async () => null, getRunDecisions: () => [], getQueue: () => [],
        observeResources: async () => ({ ok: false, observedAt: "now", attemptedSources: [], reason: "UNAVAILABLE", message: "x" }),
        interruptRun: async () => run, resumeRun: () => run,
    };
    const workspaceService = {
        getForTenant: (id: string, tenantId: string) =>
            id === "workspace-a" && tenantId === "tenant-a"
                ? { id, tenantId, name: "a", rootPath: "/server/a", createdAt: "now" } : null,
        listForTenant: () => [], create: () => { throw new Error("unused"); },
    };
    const api = new HarnessHttpApi(application, { get: () => null }, {
        authenticate: (key) => key === "key-a"
            ? { tenantId: "tenant-a", scopes: ["*"] } : null,
        workspaceService: workspaceService as never,
    });
    const headers = { authorization: "Bearer key-a", "content-type": "application/json" };
    const submit = await api.fetch(new Request("http://h/runs", { method: "POST", headers,
        body: JSON.stringify({ tenantId: "tenant-b", workspaceId: "workspace-a", userInput: "safe" }),
    }));
    expect(submit.status).toBe(202);
    expect(submitted).toMatchObject({ tenantId: "tenant-a", workspacePath: "/server/a" });

    const created = await api.fetch(new Request("http://h/workspaces/workspace-a/conversations", {
        method: "POST", headers, body: JSON.stringify({ title: "修复测试" }),
    }));
    expect(created.status).toBe(201);
    const message = await api.fetch(new Request("http://h/conversations/conversation-a/messages", {
        method: "POST", headers, body: JSON.stringify({ userInput: "继续修复" }),
    }));
    expect(message.status).toBe(202);
    expect(submitted).toMatchObject({
        tenantId: "tenant-a",
        harnessSessionId: "conversation-a",
        workspacePath: "/server/a",
        userInput: "继续修复",
    });
    expect(await (await api.fetch(new Request("http://h/runs", { headers }))).json())
        .toMatchObject({ runs: [{ id: "run-tenant-a" }] });
    const idor = await api.fetch(new Request("http://h/runs/run-tenant-a", {
        headers: { authorization: "Bearer wrong" },
    }));
    expect(idor.status).toBe(401);
    const otherTenantApi = new HarnessHttpApi(application, { get: () => null }, {
        authenticate: () => ({ tenantId: "tenant-b", scopes: ["*"] }),
        workspaceService: workspaceService as never,
    });
    expect((await otherTenantApi.fetch(new Request("http://h/runs/run-tenant-a", {
        headers: { authorization: "Bearer key-b" },
    }))).status).toBe(404);
});

test("审计 API 按 Principal Tenant 收口，并要求 audits:read", async () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const auditStore = new AccessAuditStore(db);
        auditStore.record({ action: "tasks:read", outcome: "ALLOW", tenantId: "tenant-a", resourceType: "HTTP_REQUEST", resourceId: null, reason: "scope_granted" });
        auditStore.record({ action: "tasks:read", outcome: "ALLOW", tenantId: "tenant-b", resourceType: "HTTP_REQUEST", resourceId: null, reason: "scope_granted" });
        const application: HarnessHttpApplication = {
            isStarted: () => true, submitRun: () => run, getRun: () => run, getRunsForTenant: () => [],
            getRunEvents: () => [], getRunOutput: () => ({ chunks: [], finalText: "" }), getRunWorkspaceDiff: () => null,
            getRunArtifacts: () => [], getRunArtifact: async () => null, getRunDecisions: () => [], getQueue: () => [],
            observeResources: async () => ({ ok: false, observedAt: "now", attemptedSources: [], reason: "UNAVAILABLE", message: "x" }),
            interruptRun: async () => run, resumeRun: () => run,
        };
        const api = new HarnessHttpApi(application, { get: () => null }, {
            authenticate: () => ({ tenantId: "tenant-a", scopes: ["audits:read"] }),
            workspaceService: {} as never, auditStore,
        });
        const response = await api.fetch(new Request("http://h/audit", { headers: { authorization: "Bearer key-a" } }));
        expect(response.status).toBe(200);
        const body = await response.json() as { events: Array<{ tenantId: string }> };
        expect(body.events.some((event) => event.tenantId === "tenant-a")).toBe(true);
        expect(body.events.every((event) => event.tenantId === "tenant-a")).toBe(true);
    } finally {
        db.close();
    }
});
