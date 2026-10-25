/**
 * P0 端到端 smoke：串行、并发、跨用户拒绝。
 *
 * 需要已启动 Harness server（建议 systemd + microVM + broker + 外部模型）。
 * 环境变量：
 *   HARNESS_BASE_URL（默认 http://127.0.0.1:3100）
 *   HARNESS_SMOKE_TIMEOUT_MS（默认 180000）
 *   HARNESS_SMOKE_POLL_INTERVAL_MS（默认 500）
 *   HARNESS_SMOKE_CONCURRENCY（默认 2，最小 2）
 *   HARNESS_SMOKE_USER_INPUT（默认 请使用 bash 工具执行 echo SMOKE-OK，只回答 SMOKE-OK）
 *   HARNESS_SMOKE_INVITE_CODE（注册模式为 invite 时必填，随 /auth/register 一起发送）
 *
 * 成功时输出最后一行：P0_E2E_SMOKE_OK
 */

const baseUrl = (process.env.HARNESS_BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const timeoutMs = positiveInt(process.env.HARNESS_SMOKE_TIMEOUT_MS, 180_000);
const pollMs = positiveInt(process.env.HARNESS_SMOKE_POLL_INTERVAL_MS, 500);
const concurrency = Math.max(2, positiveInt(process.env.HARNESS_SMOKE_CONCURRENCY, 2));
const label = process.env.HARNESS_SMOKE_LABEL ?? crypto.randomUUID().slice(0, 8);
const userInput = process.env.HARNESS_SMOKE_USER_INPUT
    ?? "请使用 bash 工具执行 echo SMOKE-OK，并只回答 SMOKE-OK。";
const inviteCode = process.env.HARNESS_SMOKE_INVITE_CODE;

type Principal = { userId: string; token: string; email: string };
type RunView = { id: string; status: string };

const TERMINAL_STATUSES = new Set<string>(["COMPLETED", "FAILED", "INTERRUPTED"]);

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

async function registerSmokeUser(prefix: string): Promise<Principal> {
    const email = prefix + "-" + label + "-" + Date.now() + "@smoke.local";
    const password = "smoke-password-1234";
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
    const payload = login.payload as { token: string; userId: string };
    return { userId: payload.userId, token: payload.token, email };
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
    sessionId?: string,
): Promise<string> {
    const body: Record<string, unknown> = { workspaceId, userInput };
    if (sessionId !== undefined) {
        body.sessionId = sessionId;
    }
    const result = await requestJson("/runs", {
        method: "POST",
        headers: authHeaders(principal.token),
        body: JSON.stringify(body),
    });
    if (result.response.status !== 202) {
        throw new Error("提交 Run 失败 HTTP " + result.response.status + ": " + JSON.stringify(result.payload));
    }
    const payload = result.payload as { run: { id: string } };
    return payload.run.id;
}

async function getRun(principal: Principal, runId: string): Promise<RunView> {
    const result = await requestJson("/runs/" + encodeURIComponent(runId), {
        headers: authHeaders(principal.token),
    });
    if (result.response.ok === false) {
        throw new Error("查询 Run 失败 HTTP " + result.response.status + ": " + JSON.stringify(result.payload));
    }
    const payload = result.payload as { run: RunView };
    return payload.run;
}

async function waitRuns(principal: Principal, runIds: string[]): Promise<{ runs: RunView[]; maxActive: number }> {
    const deadline = Date.now() + timeoutMs;
    let maxActive = 0;
    while (true) {
        const runs = await Promise.all(runIds.map((runId) => getRun(principal, runId)));
        const active = runs.filter((run) => run.status === "RUNNING" || run.status === "WAITING_TOOL").length;
        if (active > maxActive) {
            maxActive = active;
        }
        if (runs.every((run) => TERMINAL_STATUSES.has(run.status))) {
            return { runs, maxActive };
        }
        if (Date.now() >= deadline) {
            throw new Error("等待 Run 超时: " + JSON.stringify(runs.map((run) => ({ id: run.id, status: run.status }))));
        }
        await Bun.sleep(pollMs);
    }
}

async function eventIntervals(principal: Principal, runIds: string[]): Promise<Array<{ id: string; start: number; end: number }>> {
    const intervals: Array<{ id: string; start: number; end: number }> = [];
    for (const runId of runIds) {
        const result = await requestJson("/runs/" + encodeURIComponent(runId) + "/events", {
            headers: authHeaders(principal.token),
        });
        if (result.response.ok === false) {
            throw new Error("查询事件失败 HTTP " + result.response.status);
        }
        const payload = result.payload as { events: Array<{ type: string; timestamp: string }> };
        const events = payload.events;
        const started = events.find((event) => event.type === "RUN_STARTED" || event.type === "RUN_RESUMED");
        const first = started ?? events[0];
        if (first === undefined) {
            throw new Error("Run 没有事件: " + runId);
        }
        const startedAt = Date.parse(first.timestamp);
        if (Number.isFinite(startedAt) === false) {
            throw new Error("Run 首事件时间戳无法解析: " + runId + " " + first.timestamp);
        }
        const endedAt = events.reduce((max, event) => {
            const value = Date.parse(event.timestamp);
            if (Number.isFinite(value) === false) return max;
            return value > max ? value : max;
        }, startedAt);
        intervals.push({ id: runId, start: startedAt, end: endedAt });
    }
    return intervals;
}

function intervalsOverlap(intervals: Array<{ id: string; start: number; end: number }>): boolean {
    for (let left = 0; left < intervals.length; left += 1) {
        for (let right = left + 1; right < intervals.length; right += 1) {
            const a = intervals[left];
            const b = intervals[right];
            if (a !== undefined && b !== undefined && a.start < b.end && b.start < a.end) {
                return true;
            }
        }
    }
    return false;
}

async function scenarioSerial(): Promise<{ principal: Principal; workspaceId: string; runId: string }> {
    const principal = await registerSmokeUser("serial");
    const workspaceId = await createWorkspace(principal, "smoke-serial-" + label);
    const sessionId = "smoke-serial-session-" + label;
    const firstRunId = await submitRun(principal, workspaceId, sessionId);
    const secondRunId = await submitRun(principal, workspaceId, sessionId);
    const { runs, maxActive } = await waitRuns(principal, [firstRunId, secondRunId]);
    for (const run of runs) {
        if (run.status !== "COMPLETED") {
            throw new Error("串行 Run 未完成: " + run.id + " status=" + run.status);
        }
    }
    const intervals = await eventIntervals(principal, [firstRunId, secondRunId]);
    if (intervalsOverlap(intervals)) {
        throw new Error("串行场景观测到时间重叠: " + JSON.stringify(intervals));
    }
    if (maxActive > 1) {
        throw new Error("串行场景观测到并发超过 1: maxActive=" + maxActive);
    }
    console.log("[p0-smoke] serial ok: runs=" + firstRunId + "," + secondRunId + " maxActive=" + maxActive);
    return { principal, workspaceId, runId: firstRunId };
}

async function scenarioConcurrent(): Promise<void> {
    const principal = await registerSmokeUser("concurrent");
    const workspaceId = await createWorkspace(principal, "smoke-concurrent-" + label);
    const runIds = await Promise.all(
        Array.from({ length: concurrency }, () => submitRun(principal, workspaceId)),
    );
    const { runs, maxActive } = await waitRuns(principal, runIds);
    for (const run of runs) {
        if (run.status !== "COMPLETED") {
            throw new Error("并发 Run 未完成: " + run.id + " status=" + run.status);
        }
    }
    const intervals = await eventIntervals(principal, runIds);
    const overlap = intervalsOverlap(intervals);
    if (maxActive < 2 && overlap === false) {
        throw new Error("并发场景未观测到并发: maxActive=" + maxActive + " intervals=" + JSON.stringify(intervals));
    }
    console.log("[p0-smoke] concurrent ok: runs=" + runIds.join(",") + " maxActive=" + maxActive + " overlap=" + overlap);
}

async function scenarioCrossUser(ownerRunId: string, ownerWorkspaceId: string): Promise<void> {
    const intruder = await registerSmokeUser("intruder");
    const attempts: Array<{ label: string; method: string; path: string; body?: unknown }> = [
        { label: "GET run", method: "GET", path: "/runs/" + encodeURIComponent(ownerRunId) },
        { label: "GET events", method: "GET", path: "/runs/" + encodeURIComponent(ownerRunId) + "/events" },
        { label: "GET output", method: "GET", path: "/runs/" + encodeURIComponent(ownerRunId) + "/output" },
        { label: "POST interrupt", method: "POST", path: "/runs/" + encodeURIComponent(ownerRunId) + "/interrupt", body: {} },
        { label: "POST run in owner workspace", method: "POST", path: "/runs", body: { workspaceId: ownerWorkspaceId, userInput: "cross-user probe" } },
    ];
    const observed: string[] = [];
    for (const attempt of attempts) {
        const result = await requestJson(attempt.path, {
            method: attempt.method,
            headers: authHeaders(intruder.token),
            ...(attempt.body === undefined ? {} : { body: JSON.stringify(attempt.body) }),
        });
        if (result.response.status < 400) {
            throw new Error("跨用户访问未被拒绝: " + attempt.label + " HTTP " + result.response.status + " " + JSON.stringify(result.payload));
        }
        observed.push(attempt.label + "=" + result.response.status);
    }
    const list = await requestJson("/runs", { headers: authHeaders(intruder.token) });
    if (list.response.ok === false) {
        throw new Error("查询用户 Run 列表失败 HTTP " + list.response.status);
    }
    const payload = list.payload as { runs: Array<{ id: string }> };
    if (payload.runs.some((run) => run.id === ownerRunId)) {
        throw new Error("跨用户 Run 出现在列表中: " + ownerRunId);
    }
    console.log("[p0-smoke] cross-user ok: " + observed.join(", "));
}

async function assertHealth(): Promise<void> {
    const result = await requestJson("/health", { method: "GET" });
    if (result.response.ok === false) {
        throw new Error("Harness /health 失败 HTTP " + result.response.status);
    }
    const payload = result.payload as { ok?: boolean; started?: boolean };
    if (payload.ok !== true || payload.started !== true) {
        throw new Error("Harness 未就绪: " + JSON.stringify(payload));
    }
}

await assertHealth();
console.log("[p0-smoke] baseUrl=" + baseUrl + " label=" + label + " concurrency=" + concurrency);
const serial = await scenarioSerial();
await scenarioConcurrent();
await scenarioCrossUser(serial.runId, serial.workspaceId);
console.log("P0_E2E_SMOKE_OK label=" + label);

export {};
