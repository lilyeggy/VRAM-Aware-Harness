import { expect, test } from "bun:test";
import { HarnessHttpApi, type HarnessHttpApplication } from "../../src/http/harness-http-api.ts";
import type { AgentRun } from "../../src/runs/agent-run.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import { AccessAuditStore } from "../../src/audit/access-audit-store.ts";
import { TenantBillingStore } from "../../src/billing/tenant-billing.ts";

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

        // F12：非法分页参数返回 400，而不是静默使用默认值。
        const badLimit = await api.fetch(new Request("http://h/audit?limit=abc", {
            headers: { authorization: "Bearer key-a" },
        }));
        expect(badLimit.status).toBe(400);
        const negativeOffset = await api.fetch(new Request("http://h/audit?offset=-1", {
            headers: { authorization: "Bearer key-a" },
        }));
        expect(negativeOffset.status).toBe(400);
        const hugeLimit = await api.fetch(new Request("http://h/audit?limit=100000", {
            headers: { authorization: "Bearer key-a" },
        }));
        expect(hugeLimit.status).toBe(400);
        const validPage = await api.fetch(new Request("http://h/audit?limit=1&offset=0", {
            headers: { authorization: "Bearer key-a" },
        }));
        expect(validPage.status).toBe(200);
    } finally {
        db.close();
    }
});


test("账单 API 按 Principal Tenant 收口，并要求 billing:read", async () => {
    const db = openHarnessDatabase(":memory:");
    try {
        db.query(`INSERT INTO agent_runs (
            id, tenant_id, harness_session_id, status, user_input, workspace_path,
            created_at, updated_at, started_at, finished_at, checkpoint_id,
            failure_reason, run_policy_json, thinking_level
        ) VALUES ('run-bill-a', 'tenant-a', 's', 'COMPLETED', 't', '/w', 'now', 'now', 'now', 'now', NULL, NULL, NULL, 'off')`).run();
        db.query(`INSERT INTO agent_runs (
            id, tenant_id, harness_session_id, status, user_input, workspace_path,
            created_at, updated_at, started_at, finished_at, checkpoint_id,
            failure_reason, run_policy_json, thinking_level
        ) VALUES ('run-bill-b', 'tenant-b', 's', 'COMPLETED', 't', '/w', 'now', 'now', 'now', 'now', NULL, NULL, NULL, 'off')`).run();
        const payloadA = JSON.stringify({
            usage: { inputTokens: 1000, outputTokens: 0, totalTokens: 1000, cost: { total: 0.5 } },
        });
        const payloadB = JSON.stringify({
            usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100, cost: { total: 9.9 } },
        });
        db.query(`INSERT INTO run_events (event_id, run_id, sequence, type, timestamp, payload_version, payload_json, dedupe_key) VALUES ('event-bill-a', 'run-bill-a', 1, 'MODEL_COMPLETED', 'now', 1, $payload, 'd-bill-a')`).run({ payload: payloadA });
        db.query(`INSERT INTO run_events (event_id, run_id, sequence, type, timestamp, payload_version, payload_json, dedupe_key) VALUES ('event-bill-b', 'run-bill-b', 1, 'MODEL_COMPLETED', 'now', 1, $payload, 'd-bill-b')`).run({ payload: payloadB });

        const billingStore = new TenantBillingStore(db);
        const application: HarnessHttpApplication = {
            isStarted: () => true, submitRun: () => run, getRun: () => run, getRunsForTenant: () => [],
            getRunEvents: () => [], getRunOutput: () => ({ chunks: [], finalText: "" }), getRunWorkspaceDiff: () => null,
            getRunArtifacts: () => [], getRunArtifact: async () => null, getRunDecisions: () => [], getQueue: () => [],
            observeResources: async () => ({ ok: false, observedAt: "now", attemptedSources: [], reason: "UNAVAILABLE", message: "x" }),
            interruptRun: async () => run, resumeRun: () => run,
        };
        const api = new HarnessHttpApi(application, { get: () => null }, {
            authenticate: () => ({ tenantId: "tenant-a", scopes: ["billing:read"] }),
            workspaceService: {} as never, billingStore,
        });
        const response = await api.fetch(new Request("http://h/billing", { headers: { authorization: "Bearer key-a" } }));
        expect(response.status).toBe(200);
        const body = await response.json() as { billing: { tenantId: string; totals: { amount: number } } };
        expect(body.billing.tenantId).toBe("tenant-a");
        expect(body.billing.totals.amount).toBe(0.5);

        const forbiddenApi = new HarnessHttpApi(application, { get: () => null }, {
            authenticate: () => ({ tenantId: "tenant-a", scopes: [] }),
            workspaceService: {} as never, billingStore,
        });
        expect((await forbiddenApi.fetch(new Request("http://h/billing", { headers: { authorization: "Bearer key-a" } }))).status).toBe(403);
    } finally {
        db.close();
    }
});
