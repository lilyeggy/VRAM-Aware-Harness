import { expect, test } from "bun:test";

import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

async function createComposition(extraEnv:Record<string,string>) {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH:":memory:",
        HARNESS_PUMP_INTERVAL_MS:"60000",
        HARNESS_RATE_LIMIT_ENABLED:"true",
        ...extraEnv,
    });
    return createHarnessApplication(config, {
        runtime: new FakeAgentRuntime(),
    });
}

function registerRequest(email:string):Request {
    return new Request("http://harness.local/auth/register", {
        method:"POST",
        headers:{ "content-type":"application/json" },
        body:JSON.stringify({ email, password:"super-secret-password" }),
    });
}

function loginRequest(email:string):Request {
    return new Request("http://harness.local/auth/login", {
        method:"POST",
        headers:{ "content-type":"application/json" },
        body:JSON.stringify({ email, password:"super-secret-password" }),
    });
}

test("单 IP 超过窗口上限返回 429 + Retry-After", async () => {
    const composition = await createComposition({
        HARNESS_RATE_LIMIT_MAX_PER_IP:"2",
        HARNESS_RATE_LIMIT_MAX_PER_USER:"100",
    });
    try {
        expect((await composition.httpApi.fetch(registerRequest("ip-1@example.com"))).status).toBe(201);
        expect((await composition.httpApi.fetch(registerRequest("ip-2@example.com"))).status).toBe(201);

        const third = await composition.httpApi.fetch(registerRequest("ip-3@example.com"));
        expect(third.status).toBe(429);
        expect(third.headers.get("retry-after")).toBeTruthy();
        const body = (await third.json()) as { error?:string };
        expect(body.error).toContain("请求过于频繁");
    } finally {
        await composition.close();
    }
});

test("同一用户超过窗口上限返回 429，另一个用户不受影响", async () => {
    const composition = await createComposition({
        HARNESS_RATE_LIMIT_MAX_PER_IP:"100",
        HARNESS_RATE_LIMIT_MAX_PER_USER:"2",
    });
    try {
        await composition.httpApi.fetch(registerRequest("user-a@example.com"));
        const login = await composition.httpApi.fetch(loginRequest("user-a@example.com"));
        const { token } = (await login.json()) as { token:string };

        const workspaceRequest = () => new Request("http://harness.local/workspaces", {
            headers:{ authorization:`Bearer ${token}` },
        });

        expect((await composition.httpApi.fetch(workspaceRequest())).status).toBe(200);
        expect((await composition.httpApi.fetch(workspaceRequest())).status).toBe(200);

        const third = await composition.httpApi.fetch(workspaceRequest());
        expect(third.status).toBe(429);
        expect(third.headers.get("retry-after")).toBeTruthy();
        const body = (await third.json()) as { error?:string };
        expect(body.error).toContain("用户请求过于频繁");

        // 新用户自己的桶是空的，不应被 user-a 的限流波及。
        await composition.httpApi.fetch(registerRequest("user-b@example.com"));
        const loginB = await composition.httpApi.fetch(loginRequest("user-b@example.com"));
        const { token: tokenB } = (await loginB.json()) as { token:string };
        const responseB = await composition.httpApi.fetch(new Request("http://harness.local/workspaces", {
            headers:{ authorization:`Bearer ${tokenB}` },
        }));
        expect(responseB.status).toBe(200);
    } finally {
        await composition.close();
    }
});

test("健康检查不参与限流", async () => {
    const composition = await createComposition({
        HARNESS_RATE_LIMIT_MAX_PER_IP:"1",
        HARNESS_RATE_LIMIT_MAX_PER_USER:"100",
    });
    try {
        for (let i = 0; i < 5; i += 1) {
            const response = await composition.httpApi.fetch(
                new Request("http://harness.local/health"),
            );
            expect(response.status).toBe(200);
        }
    } finally {
        await composition.close();
    }
});

test("trustProxy=true 时按 X-Forwarded-For 首跳限流", async () => {
    const composition = await createComposition({
        HARNESS_RATE_LIMIT_MAX_PER_IP:"1",
        HARNESS_RATE_LIMIT_MAX_PER_USER:"100",
        HARNESS_TRUST_PROXY:"true",
    });
    try {
        const request = (ip:string) => new Request("http://harness.local/auth/register", {
            method:"POST",
            headers:{ "content-type":"application/json", "x-forwarded-for":ip },
            body:JSON.stringify({ email:`proxy-${ip}@example.com`, password:"super-secret-password" }),
        });

        expect((await composition.httpApi.fetch(request("10.0.0.1"))).status).toBe(201);
        expect((await composition.httpApi.fetch(request("10.0.0.2"))).status).toBe(201);
        expect((await composition.httpApi.fetch(request("10.0.0.1"))).status).toBe(429);
    } finally {
        await composition.close();
    }
});
