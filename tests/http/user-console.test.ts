import { expect, test } from "bun:test";

import { HarnessHttpApi, type HarnessHttpApplication } from "../../src/http/harness-http-api.ts";
import { userConsoleResponse } from "../../src/http/harness-user-console.ts";

test("userConsoleResponse 返回带 CSP 的中文 HTML 页面", () => {
    const response = userConsoleResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");

    return response.text().then((html) => {
        // 用户视角的关键界面元素：登录卡片、对话侧栏、居中输入区。
        expect(html).toContain("VRAM-Aware Harness");
        expect(html).toContain("authEmail");
        expect(html).toContain("convList");
        expect(html).toContain("新对话");
        // 页面绝不接受客户端自报 tenantId：租户只能由服务端凭证派生。
        expect(html).not.toMatch(/tenantId\s*[=:]/);
        // 模板字符串必须完整闭合，防止把 TS 源码片段发给浏览器。
        expect(html.trim().endsWith("</html>")).toBe(true);
    });
});

test("GET /app 路由返回用户工作台，而 / 仍然是运营控制台", async () => {
    const application: HarnessHttpApplication = {
        isStarted: () => true,
        submitRun: () => {
            throw new Error("not used");
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
            ok: false as const,
            observedAt: "2026-01-01T00:00:00.000Z",
            attemptedSources: ["FAKE" as const],
            reason: "UNAVAILABLE" as const,
            message: "测试资源不可用",
        }),
        interruptRun: async () => {
            throw new Error("not used");
        },
        resumeRun: () => {
            throw new Error("not used");
        },
    };
    const api = new HarnessHttpApi(application, { get: () => null });

    const userPage = await api.fetch(new Request("http://localhost/app"));
    expect(userPage.status).toBe(200);
    expect(await userPage.text()).toContain("用户工作台");

    const operatorPage = await api.fetch(new Request("http://localhost/"));
    expect(operatorPage.status).toBe(200);
    expect(await operatorPage.text()).toContain("Agent Harbor");

    const missing = await api.fetch(new Request("http://localhost/app/nope"));
    expect(missing.status).toBe(404);
});
