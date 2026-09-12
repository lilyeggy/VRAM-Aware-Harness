import { expect, test } from "bun:test";

import {
    createHarnessApplication,
} from "../../src/app/create-harness-application.ts";
import {
    loadHarnessConfig,
} from "../../src/app/harness-config.ts";
import type {
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import {
    FakeResourceObserver,
} from "../fakes/fake-resource-observer.ts";

const normalSnapshot:ResourceSnapshot = {
    snapshotId:"squat-snapshot",
    observedAt:"2026-09-09T10:00:00.000Z",
    sources:["FAKE"],
    gpuTotalMemoryMiB:100,
    gpuUsedMemoryMiB:20,
    gpuFreeMemoryMiB:80,
    gpuUtilizationPercent:20,
    runningRequests:0,
    waitingRequests:0,
    kvCacheUsagePercent:20,
    inputTokensPerSecond:1_000,
    outputTokensPerSecond:100,
};


type HarnessComposition = Awaited<ReturnType<typeof createHarnessApplication>>;

async function createTestComposition(): Promise<HarnessComposition> {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"fake-model",
        HARNESS_DATABASE_PATH:":memory:",
        HARNESS_PUMP_INTERVAL_MS:"60000",
    });
    return createHarnessApplication(config, {
        runtime: new FakeAgentRuntime(),
        resourceObserver: new FakeResourceObserver({ ok:true, snapshot:normalSnapshot }),
    });
}

function registerTenant(
    composition: HarnessComposition,
    email: string,
    sessionTag: string,
): Promise<{ token: string; workspaceId: string }> {
    const registerTenantInner = async (): Promise<{ token: string; workspaceId: string }> => {
        const registerResponse = await composition.httpApi.fetch(
            new Request("http://harness.local/auth/register", {
                method:"POST",
                headers:{ "content-type": "application/json" },
                body: JSON.stringify({ email, password:"super-secret-password" }),
            }),
        );
        expect(registerResponse.status).toBe(201);

        const loginResponse = await composition.httpApi.fetch(
            new Request("http://harness.local/auth/login", {
                method:"POST",
                headers:{ "content-type": "application/json" },
                body: JSON.stringify({ email, password:"super-secret-password" }),
            }),
        );
        expect(loginResponse.status).toBe(200);
        const { token } = (await loginResponse.json()) as { token:string };

        const workspaceResponse = await composition.httpApi.fetch(
            new Request("http://harness.local/workspaces", {
                method:"POST",
                headers:{
                    "content-type": "application/json",
                    authorization:`Bearer ${token}`,
                },
                body: JSON.stringify({ name:`ws-${sessionTag}` }),
            }),
        );
        expect(workspaceResponse.status).toBe(201);
        const { workspace } = (await workspaceResponse.json()) as {
            workspace:{ id:string };
        };
        return { token, workspaceId: workspace.id };
    };
    return registerTenantInner();
}

/**
 * B6：harnessSessionId 不能被客户端任意抢注。
 * 会话归属以服务端最早一条 Run 的租户为准：首次使用即认领，
 * 其他租户再提交同一 sessionId 一律 409。
 */
test("POST /runs 拒绝其他租户占用已被认领的 harnessSessionId", async () => {
    const composition = await createTestComposition();

    try {
        await composition.application.start();

        const tenantA = await registerTenant(composition, "owner-a@example.com", "a");
        const tenantB = await registerTenant(composition, "other-b@example.com", "b");

        const submitRun = async (
            token: string,
            workspaceId: string,
            sessionId: string,
        ): Promise<Response> => composition.httpApi.fetch(
            new Request("http://harness.local/runs", {
                method:"POST",
                headers:{
                    "content-type": "application/json",
                    authorization:`Bearer ${token}`,
                },
                body: JSON.stringify({
                    sessionId,
                    userInput:"多租户会话归属验证",
                    workspaceId,
                }),
            }),
        );

        // tenant-a 首次使用 session-shared → 认领成功。
        const first = await submitRun(tenantA.token, tenantA.workspaceId, "session-shared");
        expect(first.status).toBe(202);

        // tenant-b 抢注同一会话 → 409。
        const squatter = await submitRun(tenantB.token, tenantB.workspaceId, "session-shared");
        expect(squatter.status).toBe(409);
        expect(((await squatter.json()) as { error:string }).error)
            .toContain("已被其他租户占用");

        // 归属租户复用自己的会话 → 仍然放行。
        const ownerAgain = await submitRun(tenantA.token, tenantA.workspaceId, "session-shared");
        expect(ownerAgain.status).toBe(202);

        // 全新 sessionId 任意租户都可首次认领。
        const fresh = await submitRun(tenantB.token, tenantB.workspaceId, "session-fresh-b");
        expect(fresh.status).toBe(202);
    } finally {
        await composition.close();
    }
});

/**
 * D3/D4/D7：HTTP 层的可见性标注、资源级审计与登出语义。
 */
test("资源可见性显式化 + 资源级审计 + 登出语义", async () => {
    const composition = await createTestComposition();

    try {
        await composition.application.start();
        const tenant = await registerTenant(composition, "audit-user@example.com", "d");

        const submitResponse = await composition.httpApi.fetch(
            new Request("http://harness.local/runs", {
                method:"POST",
                headers:{
                    "content-type": "application/json",
                    authorization:`Bearer ${tenant.token}`,
                },
                body: JSON.stringify({
                    userInput:"审计验证任务",
                    workspaceId: tenant.workspaceId,
                }),
            }),
        );
        expect(submitResponse.status).toBe(202);
        const { run } = (await submitResponse.json()) as { run:{ id:string } };

        // D4：提交动作落在具体资源上（resourceType=RUN，resourceId=run id）。
        const auditResponse = await composition.httpApi.fetch(
            new Request("http://harness.local/audit", {
                headers:{ authorization:`Bearer ${tenant.token}` },
            }),
        );
        expect(auditResponse.status).toBe(200);
        const auditBody = (await auditResponse.json()) as {
            events: Array<{ action:string; resourceType:string|null; resourceId:string|null; tenantId:string|null }>;
        };
        const submitAudit = auditBody.events.find((event) => event.action === "RUN_SUBMIT");
        expect(submitAudit).toBeDefined();
        expect(submitAudit!.resourceType).toBe("RUN");
        expect(submitAudit!.resourceId).toBe(run.id);
        expect(submitAudit!.tenantId).not.toBeNull();

        // D4：审计查询支持 limit 分页参数。
        const pagedResponse = await composition.httpApi.fetch(
            new Request("http://harness.local/audit?limit=1", {
                headers:{ authorization:`Bearer ${tenant.token}` },
            }),
        );
        expect(((await pagedResponse.json()) as { events:unknown[] }).events)
            .toHaveLength(1);

        // D3：主机级资源遥测显式标注可见性，不再是"悄悄丢弃 principal"。
        const resourcesResponse = await composition.httpApi.fetch(
            new Request("http://harness.local/resources", {
                headers:{ authorization:`Bearer ${tenant.token}` },
            }),
        );
        expect(resourcesResponse.status).toBe(200);
        expect(await resourcesResponse.json()).toMatchObject({
            visibility:"HOST_WIDE",
        });

        // D7：无效 token 登出 → 401；有效登出 → 200；同一 token 二次登出 → 401。
        const badLogout = await composition.httpApi.fetch(
            new Request("http://harness.local/auth/logout", {
                method:"POST",
                headers:{ authorization:"Bearer not-a-real-token" },
            }),
        );
        expect(badLogout.status).toBe(401);

        const goodLogout = await composition.httpApi.fetch(
            new Request("http://harness.local/auth/logout", {
                method:"POST",
                headers:{ authorization:`Bearer ${tenant.token}` },
            }),
        );
        expect(goodLogout.status).toBe(200);

        const repeatLogout = await composition.httpApi.fetch(
            new Request("http://harness.local/auth/logout", {
                method:"POST",
                headers:{ authorization:`Bearer ${tenant.token}` },
            }),
        );
        expect(repeatLogout.status).toBe(401);
    } finally {
        await composition.close();
    }
});
