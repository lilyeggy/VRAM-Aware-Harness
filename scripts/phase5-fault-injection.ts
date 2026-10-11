/**
 * §9.9 v1.5 Phase 5 故障注入 smoke（HTTP 层：F4 / F5 / F7）。
 *
 * 需要已启动 Harness server。环境变量：
 *   HARNESS_BASE_URL（默认 http://127.0.0.1:3100）
 *   HARNESS_SMOKE_INVITE_CODE（注册模式为 invite 时必填）
 *   HARNESS_PHASE5_TIMEOUT_MS（默认 120000）
 *   HARNESS_PHASE5_EXPECT_BACKPRESSURE（=1 时跑 F5；要求服务端已设
 *     HARNESS_MAX_ACTIVE_RUNS=1、HARNESS_MAX_QUEUED_RUNS=1）
 *   HARNESS_PHASE5_LABEL（可选，报告用）
 *
 * 成功时输出最后一行：PHASE5_FAULT_INJECTION_OK
 */

const baseUrl = (process.env.HARNESS_BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const timeoutMs = positiveInt(process.env.HARNESS_PHASE5_TIMEOUT_MS, 120_000);
const label = process.env.HARNESS_PHASE5_LABEL ?? crypto.randomUUID().slice(0, 8);
const inviteCode = process.env.HARNESS_SMOKE_INVITE_CODE;
const expectBackpressure = process.env.HARNESS_PHASE5_EXPECT_BACKPRESSURE === "1";

type Principal = { tenantId: string; token: string; email: string };

const TERMINAL = new Set<string>(["COMPLETED", "FAILED", "INTERRUPTED"]);

function positiveInt(rawValue: string | undefined, fallback: number): number {
    if (rawValue === undefined || rawValue.trim() === "") {
        return fallback;
    }
    const value = Number(rawValue);
    if (Number.isInteger(value) === false || value <= 0) {
        throw new Error("必须是正整数: " + rawValue);
    }
    return value;
}

async function requestJson(
    path: string,
    init?: RequestInit,
): Promise<{ response: Response; payload: unknown }> {
    const response = await fetch(baseUrl + path, init);
    const text = await response.text();
    let payload: unknown = text;
    try {
        payload = JSON.parse(text);
    } catch {
        payload = text;
    }
    return { response, payload };
}

function authHeaders(token: string): Record<string, string> {
    return { authorization: "Bearer " + token, "content-type": "application/json" };
}

async function registerTenant(prefix: string): Promise<Principal> {
    const email = prefix + "-" + label + "-" + Date.now() + "@fault.local";
    const password = "fault-password-1234";
    const registration = await requestJson("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            email,
            password,
            ...(inviteCode === undefined ? {} : { inviteCode }),
        }),
    });
    if (registration.response.status !== 201) {
        throw new Error("注册失败 HTTP " + registration.response.status + ": " + JSON.stringify(registration.payload));
    }
    const login = await requestJson("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    if (login.response.status !== 200) {
        throw new Error("登录失败 HTTP " + login.response.status + ": " + JSON.stringify(login.payload));
    }
    const payload = login.payload as { token: string; tenantId: string };
    return { tenantId: payload.tenantId, token: payload.token, email };
}

async function createWorkspace(principal: Principal, name: string): Promise<string> {
    const result = await requestJson("/workspaces", {
        method: "POST",
        headers: authHeaders(principal.token),
        body: JSON.stringify({ name }),
    });
    if (result.response.status !== 200 && result.response.status !== 201) {
        throw new Error("创建 Workspace 失败 HTTP " + result.response.status + ": " + JSON.stringify(result.payload));
    }
    const payload = result.payload as { workspace: { id: string } };
    return payload.workspace.id;
}

async function submitRun(
    principal: Principal,
    workspaceId: string,
    body: Record<string, unknown>,
): Promise<{ status: number; payload: unknown; retryAfter: string | null }> {
    const result = await requestJson("/runs", {
        method: "POST",
        headers: authHeaders(principal.token),
        body: JSON.stringify({ workspaceId, ...body }),
    });
    return {
        status: result.response.status,
        payload: result.payload,
        retryAfter: result.response.headers.get("retry-after"),
    };
}

async function waitForRunStatus(
    principal: Principal,
    runId: string,
    predicate: (status: string) => boolean,
    deadline: number,
): Promise<string> {
    let status = "UNKNOWN";
    while (Date.now() < deadline) {
        const result = await requestJson("/runs/" + runId, {
            headers: authHeaders(principal.token),
        });
        if (result.response.status === 200) {
            status = (result.payload as { run: { status: string } }).run.status;
            if (predicate(status)) {
                return status;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return status;
}

async function faultInjectionF4(owner: Principal, workspaceId: string): Promise<string> {
    const key = "phase5-f4-" + label;
    const body = { userInput: "只回答 F4-OK", idempotencyKey: key };
    const [first, second] = await Promise.all([
        submitRun(owner, workspaceId, body),
        submitRun(owner, workspaceId, body),
    ]);
    if (first.status !== 202 || second.status !== 202) {
        throw new Error("F4 期望两次都 202，实际 " + first.status + "/" + second.status);
    }
    const firstId = (first.payload as { run: { id: string } }).run.id;
    const secondId = (second.payload as { run: { id: string } }).run.id;
    if (firstId !== secondId) {
        throw new Error("F4 幂等键命中却返回不同 Run：" + firstId + " vs " + secondId);
    }
    return firstId;
}

async function faultInjectionF7(
    other: Principal,
    ownerWorkspaceId: string,
    runId: string,
): Promise<void> {
    const paths = [
        "/runs/" + runId,
        "/runs/" + runId + "/events",
        "/runs/" + runId + "/output",
        "/runs/" + runId + "/artifacts",
    ];
    for (const path of paths) {
        const result = await requestJson(path, { headers: authHeaders(other.token) });
        if (result.response.status !== 404) {
            throw new Error("F7 跨租户 GET " + path + " 期望 404，实际 " + result.response.status);
        }
    }
    const interrupt = await requestJson("/runs/" + runId + "/interrupt", {
        method: "POST",
        headers: authHeaders(other.token),
        body: "{}",
    });
    if (interrupt.response.status !== 404) {
        throw new Error("F7 跨租户 interrupt 期望 404，实际 " + interrupt.response.status);
    }
    const submit = await submitRun(other, ownerWorkspaceId, { userInput: "跨租户提交" });
    if (submit.status !== 404) {
        throw new Error("F7 在对方 workspace 提交期望 404，实际 " + submit.status);
    }
}

async function faultInjectionF5(owner: Principal, workspaceId: string): Promise<string> {
    // 需要服务端 HARNESS_MAX_ACTIVE_RUNS=1 + HARNESS_MAX_QUEUED_RUNS=1：
    // 第 1 个 Run 占住 slot，第 2 个排队，第 3 个应被 429 拒绝。
    const blockingInput = "请使用 bash 工具执行 sleep 120，然后只回答 BLOCK-DONE。";
    const accepted: string[] = [];
    let rejected: { status: number; retryAfter: string | null } | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await submitRun(owner, workspaceId, { userInput: blockingInput });
        if (result.status === 202) {
            accepted.push((result.payload as { run: { id: string } }).run.id);
            continue;
        }
        rejected = { status: result.status, retryAfter: result.retryAfter };
        break;
    }
    if (rejected === null) {
        throw new Error("F5 提交 5 次都没有触发 backpressure");
    }
    if (rejected.status !== 429 || rejected.retryAfter === null) {
        throw new Error("F5 期望 429 + Retry-After，实际 " + rejected.status + " retry-after=" + rejected.retryAfter);
    }
    for (const runId of accepted) {
        await requestJson("/runs/" + runId + "/interrupt", {
            method: "POST",
            headers: authHeaders(owner.token),
            body: "{}",
        });
    }
    return "accepted=" + accepted.length;
}

async function main(): Promise<void> {
    const owner = await registerTenant("phase5-owner");
    const other = await registerTenant("phase5-other");
    const ownerWorkspace = await createWorkspace(owner, "phase5-owner");
    await createWorkspace(other, "phase5-other");

    const deadline = Date.now() + timeoutMs;

    const f4RunId = await faultInjectionF4(owner, ownerWorkspace);
    const f4Status = await waitForRunStatus(owner, f4RunId, (status) => TERMINAL.has(status), deadline);
    if (TERMINAL.has(f4Status) === false) {
        throw new Error("F4 Run 未在超时内进入终态，当前 " + f4Status);
    }

    const f7Submission = await submitRun(owner, ownerWorkspace, { userInput: "只回答 F7-OK" });
    if (f7Submission.status !== 202) {
        throw new Error("F7 准备 Run 失败 HTTP " + f7Submission.status);
    }
    const f7RunId = (f7Submission.payload as { run: { id: string } }).run.id;
    await faultInjectionF7(other, ownerWorkspace, f7RunId);

    let f5 = "skipped";
    if (expectBackpressure) {
        f5 = await faultInjectionF5(owner, ownerWorkspace);
    }

    console.log("PHASE5_FAULT_INJECTION_OK label=" + label + " f4=" + f4Status + " f5=" + f5 + " f7=ok");
}

await main();
