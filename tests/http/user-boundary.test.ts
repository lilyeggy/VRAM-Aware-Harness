import { expect, test } from "bun:test";
import { HarnessHttpApi, type HarnessHttpApplication } from "../../src/http/harness-http-api.ts";
import type { AgentRun } from "../../src/runs/agent-run.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import { AccessAuditStore } from "../../src/audit/access-audit-store.ts";
import { UserBillingStore } from "../../src/billing/user-billing.ts";

const run: AgentRun = {
    id: "run-user-a", userId: "user-a", harnessSessionId: "session",
    status: "QUEUED", userInput: "task", workspacePath: "/server/a", createdAt: "now",
    updatedAt: "now", startedAt: null, finishedAt: null, checkpointId: null, failureReason: null,
};

test("认证身份绑定 User，伪造 userId 和跨用户 Run ID 都不会穿透", async () => {
    let submitted: unknown;
    let conversation: { id: string; userId: string; workspaceId: string; title: string; createdAt: string; updatedAt: string } | null = null;
    const application: HarnessHttpApplication = {
        isStarted: () => true,
        submitRun: (input) => { submitted = input; return { ...run, ...input }; },
        getRun: (id) => id === run.id ? run : null,
        getRunsForUser: (userId) => userId === run.userId ? [run] : [],
        createConversation: (input) => conversation = { id: "conversation-a", title: input.title ?? "新对话", createdAt: "now", updatedAt: "now", ...input },
        getConversation: (id, userId) => conversation?.id === id && conversation.userId === userId ? conversation : null,
        getConversationsForWorkspace: (userId, workspaceId) => conversation?.userId === userId && conversation.workspaceId === workspaceId ? [conversation] : [],
        getRunsForConversation: (_userId, id) => id === conversation?.id ? [run] : [],
        getRunEvents: () => [], getRunTrace: () => null, getRunOutput: () => ({ chunks: [], finalText: "" }), getRunWorkspaceDiff: () => null, getRunArtifacts: () => [], getRunArtifact: async () => null, getQueue: () => [],
        interruptRun: async () => run, resumeRun: () => run,
    };
    const workspaceService = {
        getForUser: (id: string, userId: string) =>
            id === "workspace-a" && userId === "user-a"
                ? { id, userId, name: "a", rootPath: "/server/a", createdAt: "now" } : null,
        listForUser: () => [], create: () => { throw new Error("unused"); },
    };
    const api = new HarnessHttpApi(application, { get: () => null }, {
        authenticate: (key) => key === "key-a"
            ? { userId: "user-a", scopes: ["*"] } : null,
        workspaceService: workspaceService as never,
    });
    const headers = { authorization: "Bearer key-a", "content-type": "application/json" };
    const submit = await api.fetch(new Request("http://h/runs", { method: "POST", headers,
        body: JSON.stringify({ userId: "user-b", workspaceId: "workspace-a", userInput: "safe" }),
    }));
    expect(submit.status).toBe(202);
    expect(submitted).toMatchObject({ userId: "user-a", workspacePath: "/server/a" });

    const created = await api.fetch(new Request("http://h/workspaces/workspace-a/conversations", {
        method: "POST", headers, body: JSON.stringify({ title: "修复测试" }),
    }));
    expect(created.status).toBe(201);
    const message = await api.fetch(new Request("http://h/conversations/conversation-a/messages", {
        method: "POST", headers, body: JSON.stringify({ userInput: "继续修复" }),
    }));
    expect(message.status).toBe(202);
    expect(submitted).toMatchObject({
        userId: "user-a",
        harnessSessionId: "conversation-a",
        workspacePath: "/server/a",
        userInput: "继续修复",
    });
    expect(await (await api.fetch(new Request("http://h/runs", { headers }))).json())
        .toMatchObject({ runs: [{ id: "run-user-a" }] });
    const idor = await api.fetch(new Request("http://h/runs/run-user-a", {
        headers: { authorization: "Bearer wrong" },
    }));
    expect(idor.status).toBe(401);
    const otherUserApi = new HarnessHttpApi(application, { get: () => null }, {
        authenticate: () => ({ userId: "user-b", scopes: ["*"] }),
        workspaceService: workspaceService as never,
    });
    expect((await otherUserApi.fetch(new Request("http://h/runs/run-user-a", {
        headers: { authorization: "Bearer key-b" },
    }))).status).toBe(404);
});

test("审计 API 按 Principal User 收口，并要求 audits:read", async () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const auditStore = new AccessAuditStore(db);
        auditStore.record({ action: "tasks:read", outcome: "ALLOW", userId: "user-a", resourceType: "HTTP_REQUEST", resourceId: null, reason: "scope_granted" });
        auditStore.record({ action: "tasks:read", outcome: "ALLOW", userId: "user-b", resourceType: "HTTP_REQUEST", resourceId: null, reason: "scope_granted" });
        const application: HarnessHttpApplication = {
            isStarted: () => true, submitRun: () => run, getRun: () => run, getRunsForUser: () => [],
            getRunEvents: () => [], getRunTrace: () => null, getRunOutput: () => ({ chunks: [], finalText: "" }), getRunWorkspaceDiff: () => null,
            getRunArtifacts: () => [], getRunArtifact: async () => null, getQueue: () => [],
            interruptRun: async () => run, resumeRun: () => run,
        };
        const api = new HarnessHttpApi(application, { get: () => null }, {
            authenticate: () => ({ userId: "user-a", scopes: ["audits:read"] }),
            workspaceService: {} as never, auditStore,
        });
        const response = await api.fetch(new Request("http://h/audit", { headers: { authorization: "Bearer key-a" } }));
        expect(response.status).toBe(200);
        const body = await response.json() as { events: Array<{ userId: string }> };
        expect(body.events.some((event) => event.userId === "user-a")).toBe(true);
        expect(body.events.every((event) => event.userId === "user-a")).toBe(true);

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


test("账单 API 按 Principal User 收口，并要求 billing:read", async () => {
    const db = openHarnessDatabase(":memory:");
    try {
        db.query(`INSERT INTO agent_runs (
            id, user_id, harness_session_id, status, user_input, workspace_path,
            created_at, updated_at, started_at, finished_at, checkpoint_id,
            failure_reason, run_policy_json, thinking_level
        ) VALUES ('run-bill-a', 'user-a', 's', 'COMPLETED', 't', '/w', 'now', 'now', 'now', 'now', NULL, NULL, NULL, 'off')`).run();
        db.query(`INSERT INTO agent_runs (
            id, user_id, harness_session_id, status, user_input, workspace_path,
            created_at, updated_at, started_at, finished_at, checkpoint_id,
            failure_reason, run_policy_json, thinking_level
        ) VALUES ('run-bill-b', 'user-b', 's', 'COMPLETED', 't', '/w', 'now', 'now', 'now', 'now', NULL, NULL, NULL, 'off')`).run();
        const payloadA = JSON.stringify({
            usage: { inputTokens: 1000, outputTokens: 0, totalTokens: 1000, cost: { total: 0.5 } },
        });
        const payloadB = JSON.stringify({
            usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100, cost: { total: 9.9 } },
        });
        db.query(`INSERT INTO run_events (event_id, run_id, sequence, type, timestamp, payload_version, payload_json, dedupe_key) VALUES ('event-bill-a', 'run-bill-a', 1, 'MODEL_COMPLETED', 'now', 1, $payload, 'd-bill-a')`).run({ payload: payloadA });
        db.query(`INSERT INTO run_events (event_id, run_id, sequence, type, timestamp, payload_version, payload_json, dedupe_key) VALUES ('event-bill-b', 'run-bill-b', 1, 'MODEL_COMPLETED', 'now', 1, $payload, 'd-bill-b')`).run({ payload: payloadB });

        const billingStore = new UserBillingStore(db);
        const application: HarnessHttpApplication = {
            isStarted: () => true, submitRun: () => run, getRun: () => run, getRunsForUser: () => [],
            getRunEvents: () => [], getRunTrace: () => null, getRunOutput: () => ({ chunks: [], finalText: "" }), getRunWorkspaceDiff: () => null,
            getRunArtifacts: () => [], getRunArtifact: async () => null, getQueue: () => [],
            interruptRun: async () => run, resumeRun: () => run,
        };
        const api = new HarnessHttpApi(application, { get: () => null }, {
            authenticate: () => ({ userId: "user-a", scopes: ["billing:read"] }),
            workspaceService: {} as never, billingStore,
        });
        const response = await api.fetch(new Request("http://h/billing", { headers: { authorization: "Bearer key-a" } }));
        expect(response.status).toBe(200);
        const body = await response.json() as { billing: { userId: string; totals: { amount: number } } };
        expect(body.billing.userId).toBe("user-a");
        expect(body.billing.totals.amount).toBe(0.5);

        const forbiddenApi = new HarnessHttpApi(application, { get: () => null }, {
            authenticate: () => ({ userId: "user-a", scopes: [] }),
            workspaceService: {} as never, billingStore,
        });
        expect((await forbiddenApi.fetch(new Request("http://h/billing", { headers: { authorization: "Bearer key-a" } }))).status).toBe(403);
    } finally {
        db.close();
    }
});
