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
    expect(consoleHtml).toContain("TASK CONSOLE");
    expect(consoleHtml).toContain("提交任务，看到它如何结束。");
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
