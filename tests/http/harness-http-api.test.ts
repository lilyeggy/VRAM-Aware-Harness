import { expect, test } from "bun:test";

import type {
    Checkpoint,
} from "../../src/checkpoints/checkpoint.ts";
import {
    HarnessHttpApi,
    type HarnessHttpApplication,
} from "../../src/http/harness-http-api.ts";
import type {
    PolicyDecision,
} from "../../src/resources/execution-policy.ts";
import type {
    AgentRun,
    RunEvent,
} from "../../src/runs/agent-run.ts";
import type {
    ResumeRunInput,
    StartRunInput,
} from "../../src/runs/run-service.ts";

const timestamp = "2026-08-05T12:00:00.000Z";

function createRun(
    overrides:Partial<AgentRun> = {},
):AgentRun {
    return {
        id:"run-http",
        tenantId:"tenant-http",
        harnessSessionId:"session-http",
        status:"QUEUED",
        userInput:"测试 HTTP API",
        workspacePath:"/tmp/http-workspace",
        createdAt:timestamp,
        updatedAt:timestamp,
        startedAt:null,
        finishedAt:null,
        checkpointId:"checkpoint-http",
        failureReason:null,
        ...overrides,
    };
}

function createApi() {
    let currentRun = createRun();
    let submittedInput:StartRunInput | null = null;
    let resumeInput:ResumeRunInput | null = null;
    const event:RunEvent = {
        eventId:"event-http",
        runId:currentRun.id,
        sequence:1,
        type:"RUN_CREATED",
        timestamp,
        payloadVersion:1,
        payload:{},
    };
    const decision:PolicyDecision = {
        decisionId:"decision-http",
        runId:currentRun.id,
        action:"QUEUE",
        reasonCode:"RESOURCE_CRITICAL",
        resourceSnapshotId:"snapshot-http",
        pressure:"CRITICAL",
        observationFailureReason:null,
        decidedAt:timestamp,
    };
    const checkpoint:Checkpoint = {
        id:"checkpoint-http",
        runId:currentRun.id,
        toolExecutionId:"tool-http",
        runtimeSessionRef:"/tmp/http-session.jsonl",
        lastEventSequence:1,
        createdAt:timestamp,
    };
    const application:HarnessHttpApplication = {
        isStarted() {
            return true;
        },
        submitRun(input) {
            submittedInput = input;
            currentRun = {
                ...currentRun,
                tenantId:input.tenantId,
                harnessSessionId:input.harnessSessionId,
                userInput:input.userInput,
                workspacePath:input.workspacePath,
            };
            return currentRun;
        },
        getRun(runId) {
            return runId === currentRun.id ? currentRun : null;
        },
        getRunsForTenant(tenantId) {
            return tenantId === currentRun.tenantId ? [currentRun] : [];
        },
        getAgentsForTenant() {
            return [];
        },
        getRunEvents(runId) {
            return runId === currentRun.id ? [event] : [];
        },
        getRunOutput(runId) {
            return runId === currentRun.id
                ? { chunks: [], finalText: "" }
                : { chunks: [], finalText: "" };
        },
        getRunWorkspaceDiff(runId) {
            return runId === currentRun.id ? { added: [], modified: [], deleted: [] } : null;
        },
        getRunArtifacts() { return [{ runId: currentRun.id, path: "report.txt", hash: "hash", size: 6, createdAt: timestamp }]; },
        async getRunArtifact(_runId, path) { return path === "report.txt" ? new TextEncoder().encode("report") : null; },
        getRunDecisions(runId) {
            return runId === currentRun.id ? [decision] : [];
        },
        getQueue() {
            return [{
                runId:currentRun.id,
                tenantId:currentRun.tenantId,
                reasonCode:"RESOURCE_CRITICAL",
                enqueuedAt:timestamp,
                position:1,
                tenantPosition:1,
            }];
        },
        async observeResources() {
            return {
                ok:false as const,
                observedAt:timestamp,
                attemptedSources:["FAKE" as const],
                reason:"UNAVAILABLE" as const,
                message:"测试资源不可用",
            };
        },
        async interruptRun(runId) {
            if (runId !== currentRun.id) {
                throw new Error("找不到 Run");
            }

            currentRun = {
                ...currentRun,
                status:"INTERRUPTED",
            };
            return currentRun;
        },
        resumeRun(input) {
            resumeInput = input;
            currentRun = {
                ...currentRun,
                status:"QUEUED",
            };
            return currentRun;
        },
    };

    return {
        api:new HarnessHttpApi(application, {
            get(checkpointId) {
                return checkpointId === checkpoint.id
                    ? checkpoint
                    : null;
            },
        }),
        getResumeInput:() => resumeInput,
        getSubmittedInput:() => submittedInput,
    };
}

async function jsonBody<T>(response:Response):Promise<T> {
    return await response.json() as T;
}

test("最小 HTTP API 覆盖提交、查询、中断、恢复、队列、资源和健康检查", async () => {
    const { api, getResumeInput, getSubmittedInput } = createApi();

    const consoleResponse = await api.fetch(new Request("http://harness.local/"));
    expect(consoleResponse.status).toBe(200);
    const consoleHtml = await consoleResponse.text();
    expect(consoleHtml).toContain("Agent Harbor");
    expect(consoleHtml).toContain("多 Agent 执行工作台");
    expect(consoleHtml).not.toContain("\\\\u63D0\\\\u4EA4");

    const healthResponse = await api.fetch(new Request(
        "http://harness.local/health",
    ));
    expect(healthResponse.status).toBe(200);
    expect(await jsonBody<{
        ok:boolean;
        started:boolean;
    }>(healthResponse)).toEqual({
        ok:true,
        started:true,
    });
    const readyResponse = await api.fetch(new Request("http://harness.local/ready"));
    expect(readyResponse.status).toBe(200);
    expect(await jsonBody<{ ready:boolean }>(readyResponse)).toEqual({ ready:true });

    const agentsResponse = await api.fetch(new Request("http://harness.local/agents"));
    expect(agentsResponse.status).toBe(200);
    expect(await jsonBody<{ agents:unknown[] }>(agentsResponse)).toEqual({ agents:[] });

    const submitResponse = await api.fetch(new Request(
        "http://harness.local/runs",
        {
            method:"POST",
            headers:{ "content-type":"application/json" },
            body:JSON.stringify({
                tenantId:"tenant-api",
                sessionId:"session-api",
                userInput:"通过 HTTP 提交",
                workspacePath:"/tmp/api-workspace",
            }),
        },
    ));
    expect(submitResponse.status).toBe(202);
    expect(getSubmittedInput()).toEqual({
        tenantId:"tenant-api",
        harnessSessionId:"session-api",
        userInput:"通过 HTTP 提交",
        workspacePath:"/tmp/api-workspace",
    });

    const historyResponse = await api.fetch(new Request("http://harness.local/runs"));
    // Direct legacy API construction has no authenticated Tenant by design.
    expect(await jsonBody<{ runs: AgentRun[] }>(historyResponse)).toEqual({ runs: [] });

    const runResponse = await api.fetch(new Request(
        "http://harness.local/runs/run-http",
    ));
    expect(runResponse.status).toBe(200);
    expect(await jsonBody<{
        run:AgentRun;
        decisions:PolicyDecision[];
    }>(runResponse)).toMatchObject({
        run:{ id:"run-http" },
        decisions:[{ decisionId:"decision-http" }],
    });

    const eventsResponse = await api.fetch(new Request(
        "http://harness.local/runs/run-http/events",
    ));
    expect(await jsonBody<{ events:RunEvent[] }>(eventsResponse))
        .toMatchObject({ events:[{ type:"RUN_CREATED" }] });

    const outputResponse = await api.fetch(new Request(
        "http://harness.local/runs/run-http/output",
    ));
    expect(await jsonBody<{ chunks: unknown[]; finalText: string }>(outputResponse))
        .toEqual({ chunks: [], finalText: "" });

    const artifactsResponse = await api.fetch(new Request(
        "http://harness.local/runs/run-http/artifacts",
    ));
    expect(await jsonBody<{ artifacts: unknown[] }>(artifactsResponse)).toMatchObject({ artifacts: [{ path: "report.txt" }] });
    const artifactResponse = await api.fetch(new Request(
        "http://harness.local/runs/run-http/artifacts/report.txt",
    ));
    expect(artifactResponse.status).toBe(200);
    expect(await artifactResponse.text()).toBe("report");

    const diffResponse = await api.fetch(new Request(
        "http://harness.local/runs/run-http/workspace-diff",
    ));
    expect(await jsonBody<{ diff: { added: unknown[]; modified: unknown[]; deleted: unknown[] } }>(diffResponse)).toEqual({
        diff: { added: [], modified: [], deleted: [] },
    });

    const queueResponse = await api.fetch(new Request(
        "http://harness.local/queue",
    ));
    expect(await jsonBody<{ queue:unknown[] }>(queueResponse))
        .toMatchObject({ queue:[{ position:1 }] });

    const resourcesResponse = await api.fetch(new Request(
        "http://harness.local/resources",
    ));
    expect(await jsonBody(resourcesResponse)).toMatchObject({
        observation:{
            ok:false,
            reason:"UNAVAILABLE",
        },
    });

    const interruptResponse = await api.fetch(new Request(
        "http://harness.local/runs/run-http/interrupt",
        { method:"POST" },
    ));
    expect(await jsonBody(interruptResponse)).toMatchObject({
        run:{ status:"INTERRUPTED" },
    });

    const resumeResponse = await api.fetch(new Request(
        "http://harness.local/runs/run-http/resume",
        {
            method:"POST",
            headers:{ "content-type":"application/json" },
            body:JSON.stringify({
                continuationInput:"继续 HTTP 恢复任务",
            }),
        },
    ));
    expect(resumeResponse.status).toBe(202);
    expect(getResumeInput()).toMatchObject({
        runId:"run-http",
        checkpoint:{ id:"checkpoint-http" },
        continuationInput:"继续 HTTP 恢复任务",
    });
});

test("LLM 网关入口走统一身份主干：无 key 401、作用域不足 403、合法放行", async () => {
    // 构造带 accessControl 的 API，LLM 网关启用。
    const app: HarnessHttpApplication = {
        isStarted: () => true,
        submitRun: () => createRun(),
        getRun: () => null,
        getRunsForTenant: () => [],
        getRunEvents: () => [],
        getRunOutput: () => ({ chunks: [], finalText: "" }),
        getRunWorkspaceDiff: () => null,
        getRunArtifacts: () => [],
        getRunArtifact: async () => null,
        getRunDecisions: () => [],
        getQueue: () => [],
        observeResources: async () => ({ ok: false as const, observedAt: timestamp, attemptedSources: ["FAKE" as const], reason: "UNAVAILABLE" as const, message: "x" }),
        interruptRun: async () => createRun(),
        resumeRun: () => createRun(),
    };

    // 用一个极薄的假网关后端响应，验证鉴权拦截发生在路由真正转发之前。
    const { ModelRouter } = await import("../../src/llm-gateway/model-router.ts");
    const fakeRouter = new ModelRouter([]);
    let threwForward = false;
    const fakeGateway = {
        handleChatCompletions: async () => {
            threwForward = true;
            return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        },
        router: fakeRouter,
    };

    const build = (scopes: string[], keyOk: boolean) => new HarnessHttpApi(
        app,
        { get: () => null },
        {
            authenticate: (raw) => keyOk
                ? { tenantId: "tenant-a", scopes }
                : null,
            workspaceService: {} as never,
        },
        undefined,
        fakeGateway as never,
    );

    const chatUrl = "http://h/v1/chat/completions";
    const payload = { model: "qwen", messages: [{ role: "user", content: "hi" }] };
    const chat = (api: HarnessHttpApi, head: Record<string,string>) => api.fetch(new Request(
        chatUrl,
        { method: "POST", headers: { "content-type": "application/json", ...head }, body: JSON.stringify(payload) },
    ));

    // 1) 完全没带 key → 401，且不会转发到网关
    threwForward = false;
    const noKey = await build(["*"], true).fetch(new Request(
        chatUrl,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
    ));
    expect(noKey.status).toBe(401);
    expect(threwForward).toBe(false);

    // 2) key 无效 → 401
    threwForward = false;
    const badKey = await chat(build(["models:generate"], false), { authorization: "Bearer bad" });
    expect(badKey.status).toBe(401);
    expect(threwForward).toBe(false);

    // 3) key 有效但缺 models:generate 作用域 → 403
    threwForward = false;
    const noScope = await chat(build(["tasks:read"], true), { authorization: "Bearer good" });
    expect(noScope.status).toBe(403);
    expect(threwForward).toBe(false);

    // 4) key 有效且具备作用域 → 200，并真正转发到网关
    threwForward = false;
    const ok = await chat(build(["models:generate"], true), { authorization: "Bearer good" });
    expect(ok.status).toBe(200);
    expect(threwForward).toBe(true);

    // 5) 网关统计端点同样要求鉴权
    threwForward = false;
    const statsNoKey = await build(["models:observe"], true).fetch(new Request("http://h/llm-gateway/stats"));
    expect(statsNoKey.status).toBe(401);
    const statsOk = await build(["models:observe"], true).fetch(new Request(
        "http://h/llm-gateway/stats",
        { headers: { authorization: "Bearer good" } },
    ));
    expect(statsOk.status).toBe(200);
});

test("HTTP API 为无效输入和不存在的资源返回稳定错误", async () => {
    const { api } = createApi();

    const invalidJsonResponse = await api.fetch(new Request(
        "http://harness.local/runs",
        {
            method:"POST",
            body:"not-json",
        },
    ));
    expect(invalidJsonResponse.status).toBe(400);
    expect(await jsonBody<{ error:string }>(invalidJsonResponse)).toEqual({
        error:"请求体必须是有效 JSON",
    });

    const missingRunResponse = await api.fetch(new Request(
        "http://harness.local/runs/missing-run",
    ));
    expect(missingRunResponse.status).toBe(404);

    const missingRouteResponse = await api.fetch(new Request(
        "http://harness.local/unknown",
    ));
    expect(missingRouteResponse.status).toBe(404);
});
