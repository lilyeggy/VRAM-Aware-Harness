import { expect, test } from "bun:test";

import {
    createHarnessApplication,
} from "../../src/app/create-harness-application.ts";
import {
    loadHarnessConfig,
} from "../../src/app/harness-config.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

async function createComposition(extraEnv:Record<string,string>) {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH:":memory:",
        HARNESS_PUMP_INTERVAL_MS:"60000",
        ...extraEnv,
    });
    return createHarnessApplication(config, {
        runtime: new FakeAgentRuntime(),
    });
}

function registerRequest(email:string, inviteCode?:string):Request {
    return new Request("http://harness.local/auth/register", {
        method:"POST",
        headers:{ "content-type":"application/json" },
        body:JSON.stringify({
            email,
            password:"super-secret-password",
            ...(inviteCode === undefined ? {} : { inviteCode }),
        }),
    });
}

test("open 模式：无邀请码可注册（保持旧行为）", async () => {
    const composition = await createComposition({ HARNESS_REGISTRATION_MODE:"open" });
    try {
        const response = await composition.httpApi.fetch(
            registerRequest("open@example.com"),
        );
        expect(response.status).toBe(201);
        const body = (await response.json()) as { user:{ tenantId:string } };
        expect(body.user.tenantId.length).toBeGreaterThan(0);
    } finally {
        await composition.close();
    }
});

test("closed 模式：注册被 403 拒绝", async () => {
    const composition = await createComposition({ HARNESS_REGISTRATION_MODE:"closed" });
    try {
        const response = await composition.httpApi.fetch(
            registerRequest("closed@example.com"),
        );
        expect(response.status).toBe(403);
        const body = (await response.json()) as { error?:string };
        expect(body.error).toContain("已关闭自助注册");
    } finally {
        await composition.close();
    }
});

test("invite 模式：错误邀请码 403，正确邀请码 201", async () => {
    const composition = await createComposition({
        HARNESS_REGISTRATION_MODE:"invite",
        HARNESS_REGISTRATION_INVITE_CODE:"lab-invite-2026",
    });
    try {
        const wrong = await composition.httpApi.fetch(
            registerRequest("wrong@example.com", "not-the-code"),
        );
        expect(wrong.status).toBe(403);
        const wrongBody = (await wrong.json()) as { error?:string };
        expect(wrongBody.error).toContain("邀请码不正确");

        const right = await composition.httpApi.fetch(
            registerRequest("right@example.com", "lab-invite-2026"),
        );
        expect(right.status).toBe(201);
    } finally {
        await composition.close();
    }
});

test("重复邮箱返回 409 通用文案，不泄露 SQLite 约束（F10）", async () => {
    const composition = await createComposition({ HARNESS_REGISTRATION_MODE:"open" });
    try {
        const first = await composition.httpApi.fetch(registerRequest("duplicate@example.com"));
        expect(first.status).toBe(201);

        const second = await composition.httpApi.fetch(registerRequest("duplicate@example.com"));
        expect(second.status).toBe(409);
        const body = (await second.json()) as { error?:string };
        expect(body.error).toBe("该邮箱已被注册");
        expect(JSON.stringify(body)).not.toContain("UNIQUE constraint failed");
    } finally {
        await composition.close();
    }
});

test("注册输入校验错误返回 400，不把内部异常当 409（F10）", async () => {
    const composition = await createComposition({ HARNESS_REGISTRATION_MODE:"open" });
    try {
        const badEmail = await composition.httpApi.fetch(registerRequest("not-an-email"));
        expect(badEmail.status).toBe(400);
        expect(((await badEmail.json()) as { error?:string }).error).toContain("邮箱格式无效");

        const shortPassword = await composition.httpApi.fetch(new Request(
            "http://harness.local/auth/register",
            {
                method:"POST",
                headers:{ "content-type":"application/json" },
                body:JSON.stringify({ email:"short@example.com", password:"123" }),
            },
        ));
        expect(shortPassword.status).toBe(400);
        expect(((await shortPassword.json()) as { error?:string }).error)
            .toContain("密码至少需要 8 个字符");
    } finally {
        await composition.close();
    }
});
