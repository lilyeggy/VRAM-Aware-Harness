/**
 * 用户工作台（/app）端到端冒烟：
 * 用 Fake Runtime + Fake 资源观测启动完整 HTTP 服务，然后按真实用户顺序
 * 走一遍 注册 → 登录 → 建 Workspace → 建对话 → 发任务 → 轮询结果。
 *
 * 运行：bun run scripts/user-console-smoke.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarnessApplication } from "../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../src/app/harness-config.ts";
import { startHarnessHttpServer } from "../src/http/harness-http-server.ts";
import type {
    ResourceObservation,
    ResourceObserver,
} from "../src/resources/resource-observer.ts";
import { DemoAgentRuntime } from "../src/demo/demo-agent-runtime.ts";

class FakeResourceObserver implements ResourceObserver {
    async observe(): Promise<ResourceObservation> {
        return {
            ok: true,
            snapshot: {
                snapshotId: `fake-${Date.now()}`,
                observedAt: new Date().toISOString(),
                sources: ["FAKE"] as const,
                gpuTotalMemoryMiB: 48000,
                gpuUsedMemoryMiB: 8000,
                gpuFreeMemoryMiB: 40000,
                gpuUtilizationPercent: 10,
                runningRequests: 0,
                waitingRequests: 0,
                kvCacheUsagePercent: 10,
                inputTokensPerSecond: 0,
                outputTokensPerSecond: 0,
            },
        };
    }
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`冒烟失败：${message}`);
}

async function json(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(request);
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { status: response.status, body };
}

function bearer(base: string, token: string): (path: string, init?: RequestInit) => Request {
    return (path, init = {}) => new Request(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
}

const tempDirectory = mkdtempSync(join(tmpdir(), "vram-aware-harness-user-console-"));
const databasePath = join(tempDirectory, "harness.sqlite");

try {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "demo-model",
        HARNESS_DATABASE_PATH: databasePath,
        HARNESS_PUMP_INTERVAL_MS: "200",
    });
    const composition = await createHarnessApplication(config, {
        runtime: new DemoAgentRuntime(),
        resourceObserver: new FakeResourceObserver(),
    });
    await composition.application.start();
    const server = startHarnessHttpServer(composition.httpApi, { port: 0 });
    const base = `http://127.0.0.1:${server.port}`;

    // 1. 用户工作台页面可访问，运营台仍在 /。
    const appPage = await fetch(`${base}/app`);
    const appHtml = await appPage.text();
    assert(appPage.status === 200, `/app 状态码 ${appPage.status}`);
    assert(appHtml.includes("用户工作台") && appHtml.includes("authEmail"), "/app 页面缺少关键元素");
    console.log(`PASS  GET /app → 用户工作台 (${appHtml.length} bytes)`);

    // 2. 注册 + 登录，获得会话 Token。
    const email = `user-${Date.now()}@team.local`;
    const registered = await json(new Request(`${base}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password-123" }),
    }));
    assert(registered.status === 201 && "user" in registered.body, `注册失败 ${JSON.stringify(registered.body)}`);
    console.log(`PASS  POST /auth/register → tenant ${JSON.stringify(registered.body.user)}`);

    const loggedIn = await json(new Request(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password-123" }),
    }));
    const token = loggedIn.body.token;
    assert(typeof token === "string" && token.length > 0, "登录未返回 token");
    console.log("PASS  POST /auth/login → 会话 Token 已签发");

    // 3. 用会话 Token 创建 Workspace 与对话。
    const call = bearer(base, token);
    const wsResponse = await json(call("/workspaces", { method: "POST", body: JSON.stringify({ name: "smoke-project" }) }));
    assert(wsResponse.status === 201, "创建 Workspace 失败");
    const workspaceId = (wsResponse.body.workspace as { id: string }).id;
    console.log(`PASS  POST /workspaces → ${workspaceId.slice(0, 8)}…`);

    const convResponse = await json(call(`/workspaces/${workspaceId}/conversations`, {
        method: "POST",
        body: JSON.stringify({ title: "冒烟对话" }),
    }));
    assert(convResponse.status === 201, "创建对话失败");
    const conversationId = (convResponse.body.conversation as { id: string }).id;
    console.log(`PASS  POST /workspaces/:id/conversations → ${conversationId.slice(0, 8)}…`);

    // 4. 发送任务并轮询到完成。
    const runResponse = await json(call(`/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ userInput: "检查项目中的测试失败原因，修复后运行测试。" }),
    }));
    assert(runResponse.status === 202 && "run" in runResponse.body, "发送消息失败");
    const runId = (runResponse.body.run as { id: string }).id;
    console.log(`PASS  POST /conversations/:id/messages → run ${runId.slice(0, 8)}…`);

    let finalStatus = "";
    for (let index = 0; index < 50; index += 1) {
        const detail = await json(call(`/runs/${runId}`));
        finalStatus = (detail.body.run as { status: string }).status;
        if (["COMPLETED", "FAILED", "INTERRUPTED"].includes(finalStatus)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(finalStatus === "COMPLETED", `Run 未完成，最终状态 ${finalStatus}`);
    console.log(`PASS  Run 轮询 → ${finalStatus}`);

    // 5. 用户可见的结果接口全部可用。
    const output = await json(call(`/runs/${runId}/output`));
    assert(typeof output.body.finalText === "string" && (output.body.finalText as string).length > 0, "输出为空");
    const diff = await json(call(`/runs/${runId}/workspace-diff`));
    assert("diff" in diff.body, "workspace-diff 响应缺少 diff");
    const artifacts = await json(call(`/runs/${runId}/artifacts`));
    assert(Array.isArray(artifacts.body.artifacts), "artifacts 响应缺少数组");
    const events = await json(call(`/runs/${runId}/events`));
    assert(Array.isArray(events.body.events) && (events.body.events as unknown[]).length > 0, "events 为空");
    const conversation = await json(call(`/conversations/${conversationId}`));
    assert(Array.isArray(conversation.body.runs) && (conversation.body.runs as unknown[]).length === 1, "对话应包含 1 个 Run");
    console.log("PASS  output / workspace-diff / artifacts / events / conversation 全部可读");

    // 6. 租户边界：伪造凭证不能读。
    const intruder = bearer(base, "not-a-real-token");
    const denied = await json(intruder(`/runs/${runId}`));
    assert(denied.status === 401, `无效凭证应被 401 拒绝，实际 ${denied.status}`);
    console.log("PASS  无效凭证访问 Run → 401 拒绝");

    await server.stop(true);
    await composition.close();
    console.log("\n用户工作台冒烟全部通过 ✔");
} finally {
    rmSync(tempDirectory, { recursive: true, force: true });
}
