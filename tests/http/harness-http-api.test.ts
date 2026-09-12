import { expect, test } from "bun:test";

import type {
    Checkpoint,
} from "../../src/checkpoints/checkpoint.ts";
import {
    HarnessHttpApi,
    type HarnessHttpApplication,
    type HttpAccessControl,
} from "../../src/http/harness-http-api.ts";
import type {
    PolicyConstraints,
    PolicyLayer,
} from "../../src/policies/effective-policy.ts";
import type {
    ToolExecution,
} from "../../src/tools/tool-execution.ts";
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

function createApi(
    limits?: { maxUserInputChars: number },
    accessControl?: HttpAccessControl,
) {
    let currentRun = createRun();
    let submittedInput:StartRunInput | null = null;
    let resumeInput:ResumeRunInput | null = null;
    // N15/N16：策略管理面与人工消解的观测点。
    const unrestricted: PolicyConstraints = {
        allowedTools: null,
        allowedSkills: null,
        allowedModels: null,
        workspaceRoots: null,
        allowNetwork: true,
        allowProcess: true,
        allowedSecrets: null,
        resourceLimits: { cpuCores: null, memoryMiB: null, diskMiB: null },
    };
    let platformPolicy: PolicyLayer = { ...unrestricted, id: "platform:default", kind: "PLATFORM" };
    let tenantPolicy: PolicyLayer = { ...unrestricted, id: "tenant:tenant-http:default", kind: "TENANT" };
    let preparedExecutions: ToolExecution[] = [];
    let resolveInput: { runId: string; resolution: string; note?: string; actor: string | null } | null = null;
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
        getRunLimitations(runId) {
            return runId === currentRun.id
                ? [{ toolName: "bash", reason: "执行环境无法隔离 Workspace，拒绝 bash", count: 3, lastDecidedAt: timestamp }]
                : [];
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
        getPlatformPolicy() {
            return platformPolicy;
        },
        getTenantPolicy(tenantId) {
            return tenantId === currentRun.tenantId ? tenantPolicy : tenantPolicy;
        },
        setPlatformPolicy(id, policy) {
            platformPolicy = { ...policy, id, kind: "PLATFORM" };
            return true;
        },
        setTenantPolicy(_tenantId, id, policy) {
            tenantPolicy = { ...policy, id, kind: "TENANT" };
            return true;
        },
        getRunUnknownEffects(runId) {
            return runId === currentRun.id ? preparedExecutions : [];
        },
        resolveUnknownEffect(runId, input) {
            resolveInput = {
                runId,
                resolution: input.resolution,
                ...(input.note === undefined ? {} : { note: input.note }),
                actor: input.actor,
            };
            return {
                run: currentRun,
                resolvedExecutionIds: preparedExecutions.map((execution) => execution.id),
            };
        },
    };

    return {
        api:new HarnessHttpApi(application, {
            get(checkpointId) {
                return checkpointId === checkpoint.id
                    ? checkpoint
                    : null;
            },
        }, accessControl, undefined, undefined, undefined, limits),
        getResumeInput:() => resumeInput,
        getSubmittedInput:() => submittedInput,
        getResolveInput:() => resolveInput,
        setPreparedExecutions:(executions: ToolExecution[]) => { preparedExecutions = executions; },
        getPlatformPolicy:() => platformPolicy,
        getTenantPolicy:() => tenantPolicy,
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
        limitations:unknown[];
    }>(runResponse)).toMatchObject({
        run:{ id:"run-http" },
        decisions:[{ decisionId:"decision-http" }],
        limitations:[{ toolName: "bash", reason: "执行环境无法隔离 Workspace，拒绝 bash", count: 3, lastDecidedAt: timestamp }],
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
        // 支柱 2：stats 端点会一并读取缓存命中指标。
        cacheMetrics: () => ({
            totalRequests: 0,
            promptTokensTotal: 0,
            cachedTokensTotal: 0,
            cacheHitRate: null,
            recentSamples: [],
        }),
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

// N8 回归：2026-09-10 真机发现 78 万字符输入被 202 接受后才在模型侧 400 失败，
// 且提交响应把全量输入原样回显。这里断言提交期上界与回显收敛。
test("N8：超过提交期上界的输入必须 413 且不创建 Run", async () => {
    const { api, getSubmittedInput } = createApi({ maxUserInputChars: 50 });
    const response = await api.fetch(new Request(
        "http://harness.local/runs",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                tenantId: "tenant-api",
                sessionId: "session-api",
                userInput: "x".repeat(51),
                workspacePath: "/tmp/api-workspace",
            }),
        },
    ));
    expect(response.status).toBe(413);
    const body = await jsonBody<{ error: string }>(response);
    expect(body.error).toContain("任务输入过长");
    expect(body.error).toContain("51");
    // 校验发生在创建之前：不能留下 Run。
    expect(getSubmittedInput()).toBeNull();
});

test("N8：边界内输入按 202 接受，且提交响应不回显全量输入", async () => {
    // 上界 1000 字符，但回显只保留 200 字符摘要。
    const { api, getSubmittedInput } = createApi({ maxUserInputChars: 1000 });
    const long = "y".repeat(600);
    const response = await api.fetch(new Request(
        "http://harness.local/runs",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                tenantId: "tenant-api",
                sessionId: "session-api",
                userInput: long,
                workspacePath: "/tmp/api-workspace",
            }),
        },
    ));
    expect(response.status).toBe(202);
    const body = await jsonBody<{ run: { userInput: string; userInputTruncated?: boolean; userInputLength?: number } }>(response);
    expect(body.run.userInput.length).toBe(200);
    expect(body.run.userInputTruncated).toBe(true);
    expect(body.run.userInputLength).toBe(600);
    // 后端仍然拿到完整输入。
    expect(getSubmittedInput()?.userInput).toBe(long);
});

// ---------------------------------------------------------------------------
// N15：策略管理面——租户资源限额 / 授权 Secret 的产品入口。
// 修复前 PolicyRegistry.setTenantPolicy 只被测试调用，HTTP 没有任何路由，
// 每次运行都落在 unrestrictedPolicy（CPU/内存无限额、无 Secret）。
// ---------------------------------------------------------------------------

function createToolExecution(overrides: Partial<ToolExecution> = {}): ToolExecution {
    return {
        id: "tool-exec-1",
        runId: "run-http",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: { command: "rm -rf /tmp/scratch" },
        effect: "UNKNOWN_EFFECT",
        status: "PREPARED",
        result: null,
        errorMessage: null,
        createdAt: timestamp,
        finishedAt: null,
        ...overrides,
    };
}

test("N15：PUT /admin/policies/tenants/:id 落地租户资源限额与授权 Secret", async () => {
    const { api, getTenantPolicy } = createApi();

    const response = await api.fetch(new Request(
        "http://harness.local/admin/policies/tenants/tenant-http",
        {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                policy: {
                    allowedTools: ["read", "bash"],
                    allowedSecrets: ["GITHUB_TOKEN"],
                    allowNetwork: false,
                    resourceLimits: { cpuCores: 1.5, memoryMiB: 1024 },
                },
            }),
        },
    ));

    expect(response.status).toBe(200);
    const body = await jsonBody<{ tenant: PolicyLayer }>(response);
    expect(body.tenant.allowedTools).toEqual(["read", "bash"]);
    expect(body.tenant.allowedSecrets).toEqual(["GITHUB_TOKEN"]);
    expect(body.tenant.allowNetwork).toBe(false);
    expect(body.tenant.resourceLimits).toEqual({ cpuCores: 1.5, memoryMiB: 1024, diskMiB: null });
    expect(getTenantPolicy().resourceLimits.memoryMiB).toBe(1024);
});

test("N15：GET /admin/policies 返回平台层与租户层", async () => {
    const { api } = createApi();

    const response = await api.fetch(new Request("http://harness.local/admin/policies"));
    expect(response.status).toBe(200);
    const body = await jsonBody<{ platform: PolicyLayer; tenant: PolicyLayer }>(response);
    expect(body.platform.kind).toBe("PLATFORM");
    expect(body.tenant.kind).toBe("TENANT");
});

test("N15：策略字段类型错误 → 400，不静默降级成无限额", async () => {
    const { api } = createApi();

    const response = await api.fetch(new Request(
        "http://harness.local/admin/policies/tenants/tenant-http",
        {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ policy: { resourceLimits: { memoryMiB: "1024" } } }),
        },
    ));

    expect(response.status).toBe(400);
});

test("N15：POST /runs 的 runPolicy 透传到 StartRunInput（此前无产品调用方）", async () => {
    const { api, getSubmittedInput } = createApi();

    const response = await api.fetch(new Request("http://harness.local/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            tenantId: "tenant-http",
            workspacePath: "/tmp/http-workspace",
            userInput: "受限运行",
            runPolicy: { allowedTools: ["read"], resourceLimits: { cpuCores: 2 } },
        }),
    }));

    expect(response.status).toBe(202);
    const submitted = getSubmittedInput();
    expect(submitted?.runPolicy?.allowedTools).toEqual(["read"]);
    expect(submitted?.runPolicy?.resourceLimits.cpuCores).toBe(2);
});

test("N15：非通配 scope 不能改别的租户（404）；缺写权限 → 403", async () => {
    const scoped = createApi(undefined, {
        authenticate(rawKey: string) {
            if (rawKey === "other-tenant-key") {
                return { tenantId: "tenant-other", scopes: ["policies:read", "policies:write"] };
            }
            if (rawKey === "readonly-key") {
                return { tenantId: "tenant-http", scopes: ["policies:read"] };
            }
            return null;
        },
    } as unknown as HttpAccessControl);

    const denied = await scoped.api.fetch(new Request(
        "http://harness.local/admin/policies/tenants/tenant-http",
        {
            method: "PUT",
            headers: { "content-type": "application/json", authorization: "Bearer other-tenant-key" },
            body: JSON.stringify({ policy: { allowNetwork: false } }),
        },
    ));
    expect(denied.status).toBe(404);

    const forbidden = await scoped.api.fetch(new Request(
        "http://harness.local/admin/policies/tenants/tenant-http",
        {
            method: "PUT",
            headers: { "content-type": "application/json", authorization: "Bearer readonly-key" },
            body: JSON.stringify({ policy: { allowNetwork: false } }),
        },
    ));
    expect(forbidden.status).toBe(403);
});

// ---------------------------------------------------------------------------
// N16：UNKNOWN_EFFECT 的人工消解出口
// ---------------------------------------------------------------------------

test("N16：GET /runs/:id 暴露待核对的不确定副作用", async () => {
    const { api, setPreparedExecutions } = createApi();
    setPreparedExecutions([createToolExecution()]);

    const response = await api.fetch(new Request("http://harness.local/runs/run-http"));
    expect(response.status).toBe(200);
    const body = await jsonBody<{
        unknownEffects: Array<{
            executionId: string;
            toolCallId: string;
            toolName: string;
            effect: string;
            createdAt: string;
        }>;
    }>(response);

    expect(body.unknownEffects).toEqual([
        {
            executionId: "tool-exec-1",
            toolCallId: "call-1",
            toolName: "bash",
            effect: "UNKNOWN_EFFECT",
            createdAt: timestamp,
        },
    ]);
});

test("N16：POST /runs/:id/resolve-unknown-effect 记录人工核对结论", async () => {
    const { api, getResolveInput, setPreparedExecutions } = createApi();
    setPreparedExecutions([createToolExecution()]);

    const response = await api.fetch(new Request(
        "http://harness.local/runs/run-http/resolve-unknown-effect",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ resolution: "EFFECT_OCCURRED", note: "日志显示命令已执行" }),
        },
    ));

    expect(response.status).toBe(200);
    const body = await jsonBody<{ resolvedExecutionIds: string[] }>(response);
    expect(body.resolvedExecutionIds).toEqual(["tool-exec-1"]);
    expect(getResolveInput()).toEqual({
        runId: "run-http",
        resolution: "EFFECT_OCCURRED",
        note: "日志显示命令已执行",
        actor: "legacy",
    });
});

test("N16：非法 resolution → 400", async () => {
    const { api } = createApi();

    const response = await api.fetch(new Request(
        "http://harness.local/runs/run-http/resolve-unknown-effect",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ resolution: "MAYBE" }),
        },
    ));

    expect(response.status).toBe(400);
});
