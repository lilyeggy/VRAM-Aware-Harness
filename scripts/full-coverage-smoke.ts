/**
 * 全覆盖 smoke：HTTP/API + 工具 + Run 生命周期。
 *
 * 用法：
 *   HARNESS_BASE_URL=http://127.0.0.1:3210 HARNESS_API_KEY=<key> bun run scripts/full-coverage-smoke.ts
 *
 * 可选 phase 开关（未设置则相应项 SKIP 并记录原因）：
 *   FULLCOVER_BACKPRESSURE=1   需要 HARNESS_MAX_QUEUED_RUNS=1 且 HARNESS_MAX_ACTIVE_RUNS=1
 *   FULLCOVER_RATELIMIT=1      需要 HARNESS_RATE_LIMIT_MAX_PER_IP=2，且必须搭配
 *                              FULLCOVER_ONLY=system.ratelimit + FULLCOVER_SKIP_BOOTSTRAP=1
 *                              （否则脚本自己的注册/登录就会被 429 拦下）
 *   FULLCOVER_MCP=1            需要 HARNESS_MCP_SERVERS 配置 echo fixture
 *   FULLCOVER_ONLY=id1,id2     只跑指定 id（用于隔离 phase）
 *   FULLCOVER_SKIP_BOOTSTRAP=1 隔离 phase 时不预建用户
 *
 * 结果 JSON 写入 HARNESS_FULLCOVER_OUT。
 */

type Status = "PASS" | "FAIL" | "SKIP";

interface MatrixResult {
    id: string;
    name: string;
    status: Status;
    detail: string;
    evidence: string;
}

const baseUrl = (process.env.HARNESS_BASE_URL ?? "http://127.0.0.1:3210").replace(/\/+$/, "");
const apiKey = process.env.HARNESS_API_KEY ?? process.env.HARNESS_BOOTSTRAP_API_KEY ?? "fullcov-key-2026";
const inviteCode = process.env.HARNESS_FULLCOVER_INVITE ?? process.env.HARNESS_REGISTRATION_INVITE_CODE ?? "fullcov-2026";
const outPath = process.env.HARNESS_FULLCOVER_OUT ?? "/data/harness/fullcoverage-test/full-coverage-report.json";
const runTimeoutMs = Number(process.env.HARNESS_FULLCOVER_RUN_TIMEOUT_MS ?? "240000");
const pollMs = Number(process.env.HARNESS_FULLCOVER_POLL_MS ?? "3000");
const onlyRaw = process.env.FULLCOVER_ONLY ?? "";
const onlyIds = onlyRaw.length === 0 ? null : onlyRaw.split(",").map((item) => item.trim());
const flag = (name: string): boolean => process.env[name] === "1";
const tag = process.env.FULLCOVER_TAG ?? Date.now().toString(36);
const skipBootstrap = process.env.FULLCOVER_SKIP_BOOTSTRAP === "1";

const results: MatrixResult[] = [];

function selected(id: string): boolean {
    return onlyIds === null || onlyIds.includes(id);
}

function record(id: string, name: string, status: Status, detail: string, evidence: string): void {
    results.push({ id, name, status, detail, evidence });
    console.log("[" + status + "] " + id + " :: " + name + " :: " + detail);
}

type StepOutcome = void | string | { status?: Status; detail?: string; evidence?: string };

async function step(id: string, name: string, fn: () => Promise<StepOutcome>): Promise<void> {
    if (selected(id) === false) {
        return;
    }
    try {
        const outcome = await fn();
        if (outcome === undefined || outcome === null) {
            record(id, name, "PASS", "ok", "");
            return;
        }
        if (typeof outcome === "string") {
            record(id, name, "PASS", outcome, "");
            return;
        }
        record(id, name, outcome.status ?? "PASS", outcome.detail ?? "ok", outcome.evidence ?? "");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log("  [" + id + "] 异常：" + message);
        record(id, name, "FAIL", message, "");
    }
}

function assert(condition: boolean, message: string): void {
    if (condition === false) {
        throw new Error(message);
    }
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual !== expected) {
        throw new Error(label + "：期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual));
    }
}

interface ApiResult {
    status: number;
    headers: Record<string, string>;
    text: string;
    json: any;
}

interface ApiOptions {
    token?: string | null;
    body?: unknown;
}

async function api(method: string, path: string, options: ApiOptions = {}): Promise<ApiResult> {
    const headers: Record<string, string> = {};
    const token = options.token === undefined ? apiKey : options.token;
    if (token !== null && token !== undefined && token.length > 0) {
        headers["authorization"] = "Bearer " + token;
    }
    let payload: string | undefined = undefined;
    if (options.body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(options.body);
    }
    const response = await fetch(baseUrl + path, { method, headers, body: payload });
    const text = await response.text();
    let json: any = null;
    try {
        json = JSON.parse(text);
    } catch (error) {
        json = null;
    }
    const headerRecord: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        headerRecord[key.toLowerCase()] = value;
    });
    return { status: response.status, headers: headerRecord, text, json };
}

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "INTERRUPTED"];

function runIdOf(response: ApiResult): string {
    assertEq(response.status, 202, "提交 Run 状态 body=" + response.text.slice(0, 300));
    const run = response.json && response.json.run;
    assert(typeof run === "object" && run !== null && typeof run.id === "string", "提交 Run 响应缺少 run.id body=" + response.text.slice(0, 300));
    return run.id;
}

async function getRunDetail(runId: string, token: string | null): Promise<any> {
    const response = await api("GET", "/runs/" + encodeURIComponent(runId), { token });
    assertEq(response.status, 200, "GET /runs/:id 状态 body=" + response.text.slice(0, 200));
    return response.json;
}

async function pollRun(runId: string, token: string | null, timeoutMs: number = runTimeoutMs): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = "UNKNOWN";
    while (Date.now() < deadline) {
        const response = await api("GET", "/runs/" + encodeURIComponent(runId), { token });
        if (response.status === 200 && response.json && response.json.run) {
            lastStatus = response.json.run.status;
            if (TERMINAL_STATUSES.includes(lastStatus)) {
                return response.json;
            }
        }
        await Bun.sleep(pollMs);
    }
    throw new Error("Run " + runId + " 等待终态超时，最后状态=" + lastStatus);
}

/**
 * 终态先落库、工作区快照与产物在 finally 里采集（src/runs/run-service.ts:441-471），
 * 由 RUN_ARTIFACTS_READY 标记就绪。客户端在断言 workspace-diff / artifacts 之前
 * 必须等这个事件，否则会读到空结果（真机实测窗口约 232ms）。
 */
async function waitForArtifactsReady(runId: string, token: string | null, timeoutMs: number = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const events = await getEvents(runId, token);
        if (events.some((event: any) => event.type === "RUN_ARTIFACTS_READY")) {
            return true;
        }
        await Bun.sleep(200);
    }
    return false;
}

async function waitForStatus(runId: string, wanted: string[], token: string | null, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = "UNKNOWN";
    while (Date.now() < deadline) {
        const response = await api("GET", "/runs/" + encodeURIComponent(runId), { token });
        if (response.status === 200 && response.json && response.json.run) {
            lastStatus = response.json.run.status;
            if (wanted.includes(lastStatus)) {
                return lastStatus;
            }
        }
        await Bun.sleep(500);
    }
    return lastStatus;
}

async function getEvents(runId: string, token: string | null): Promise<any[]> {
    const response = await api("GET", "/runs/" + encodeURIComponent(runId) + "/events", { token });
    assertEq(response.status, 200, "GET /runs/:id/events 状态 body=" + response.text.slice(0, 200));
    return (response.json && response.json.events) || [];
}

function describeTools(events: any[]): string {
    const parts: string[] = [];
    for (const event of events) {
        if (event.type === "TOOL_COMPLETED" || event.type === "TOOL_FAILED") {
            const payload = (event.payload || {}) as any;
            const resultText = typeof payload.result === "object" && payload.result !== null && Array.isArray(payload.result.content)
                ? payload.result.content.map((chunk: any) => chunk.text || "").join(" ")
                : "";
            parts.push(event.type + ":" + payload.toolName + ":isError=" + String(payload.isError) + (resultText.length > 0 ? ":" + resultText.slice(0, 120) : ""));
        }
    }
    return parts.length === 0 ? "无工具事件" : parts.join(" | ");
}

function findToolEvent(events: any[], toolName: string, type: string): any | null {
    for (const event of events) {
        if (event.type === type) {
            const payload = (event.payload || {}) as any;
            if (payload.toolName === toolName) {
                return payload;
            }
        }
    }
    return null;
}

function requireToolCompleted(events: any[], toolName: string): void {
    const completed = findToolEvent(events, toolName, "TOOL_COMPLETED");
    if (completed === null) {
        throw new Error("未观察到 " + toolName + " 的 TOOL_COMPLETED；工具事件：" + describeTools(events));
    }
    assert(completed.isError === false, toolName + " TOOL_COMPLETED 但 isError=" + String(completed.isError));
}

async function diffPaths(runId: string, token: string | null): Promise<{ added: any[]; modified: any[]; deleted: any[] }> {
    const response = await api("GET", "/runs/" + encodeURIComponent(runId) + "/workspace-diff", { token });
    assertEq(response.status, 200, "GET workspace-diff 状态 body=" + response.text.slice(0, 200));
    const diff = response.json && response.json.diff;
    assert(diff !== null && diff !== undefined, "workspace-diff 响应缺少 diff body=" + response.text.slice(0, 200));
    return { added: diff.added || [], modified: diff.modified || [], deleted: diff.deleted || [] };
}

async function artifactPaths(runId: string, token: string | null): Promise<any[]> {
    const response = await api("GET", "/runs/" + encodeURIComponent(runId) + "/artifacts", { token });
    assertEq(response.status, 200, "GET artifacts 状态 body=" + response.text.slice(0, 200));
    return (response.json && response.json.artifacts) || [];
}

interface RunOutcome {
    runId: string;
    detail: any;
    events: any[];
    status: string;
}

async function submitAndWait(workspaceId: string, userInput: string, token: string, options: { idempotencyKey?: string; sessionId?: string; timeoutMs?: number } = {}): Promise<RunOutcome> {
    const body: Record<string, unknown> = { workspaceId, userInput };
    if (options.idempotencyKey !== undefined) body.idempotencyKey = options.idempotencyKey;
    if (options.sessionId !== undefined) body.sessionId = options.sessionId;
    const response = await api("POST", "/runs", { token, body });
    const runId = runIdOf(response);
    const detail = await pollRun(runId, token, options.timeoutMs ?? runTimeoutMs);
    const finalStatus = detail.run.status;
    if (finalStatus === "COMPLETED" || finalStatus === "FAILED") {
        // 契约：结果（workspace-diff / artifacts）在 RUN_ARTIFACTS_READY 之后才可读。
        await waitForArtifactsReady(runId, token);
    }
    const events = await getEvents(runId, token);
    return { runId, detail, events, status: detail.run.status };
}

async function bootstrapUser(context: any, email: string): Promise<void> {
    const registered = await api("POST", "/auth/register", { token: null, body: { email, password: "password123", inviteCode } });
    assertEq(registered.status, 201, "引导注册状态 body=" + registered.text.slice(0, 200));
    const login = await api("POST", "/auth/login", { token: null, body: { email, password: "password123" } });
    assertEq(login.status, 200, "引导登录状态 body=" + login.text.slice(0, 200));
    context.token = login.json.token;
    context.userId = login.json.userId;
    const workspace = await api("POST", "/workspaces", { token: context.token, body: { name: "fc-only-ws-" + tag } });
    assertEq(workspace.status, 201, "引导 workspace 状态 body=" + workspace.text.slice(0, 200));
    context.workspaceId = workspace.json.workspace.id;
    const conversation = await api("POST", "/workspaces/" + encodeURIComponent(context.workspaceId) + "/conversations", { token: context.token, body: { title: "fc-only-conv-" + tag } });
    assertEq(conversation.status, 201, "引导 conversation 状态 body=" + conversation.text.slice(0, 200));
    context.conversationId = conversation.json.conversation.id;
}

async function main(): Promise<void> {
    const context: any = {};
    const email = "fullcov-" + tag + "@example.com";
    context.email = email;

    if (onlyIds !== null && skipBootstrap === false) {
        await bootstrapUser(context, "fullcov-only-" + tag + "@example.com");
    }

    // ---------------- 系统探针 ----------------
    await step("system.health", "GET /health → 200 ok=true", async () => {
        const response = await api("GET", "/health", { token: null });
        assertEq(response.status, 200, "GET /health 状态");
        assert(response.json && response.json.ok === true, "/health 缺少 ok=true body=" + response.text);
        return "ok=" + String(response.json.ok) + " started=" + String(response.json.started);
    });

    await step("system.ready", "GET /ready → 200 ready=true", async () => {
        const response = await api("GET", "/ready", { token: null });
        assertEq(response.status, 200, "GET /ready 状态");
        assert(response.json && response.json.ready === true, "/ready 缺少 ready=true body=" + response.text);
        return "ready=true";
    });

    await step("system.metrics", "GET /metrics → 200（metrics:read）", async () => {
        const response = await api("GET", "/metrics", { token: apiKey });
        assertEq(response.status, 200, "GET /metrics 状态");
        assert(response.text.length > 0, "/metrics 为空");
        return "content-type=" + String(response.headers["content-type"]) + " bytes=" + response.text.length;
    });

    // ---------------- 认证 ----------------
    await step("auth.register.no_invite", "POST /auth/register 缺邀请码 → 403", async () => {
        const response = await api("POST", "/auth/register", { token: null, body: { email: "fc-noinv-" + tag + "@example.com", password: "password123" } });
        assertEq(response.status, 403, "缺邀请码注册状态 body=" + response.text.slice(0, 200));
        return "403 " + response.text.slice(0, 120);
    });

    await step("auth.register.wrong_invite", "POST /auth/register 错邀请码 → 403", async () => {
        const response = await api("POST", "/auth/register", { token: null, body: { email: "fc-badinv-" + tag + "@example.com", password: "password123", inviteCode: "wrong-code" } });
        assertEq(response.status, 403, "错邀请码注册状态 body=" + response.text.slice(0, 200));
        return "403 " + response.text.slice(0, 120);
    });

    await step("auth.register.ok", "POST /auth/register 正确邀请码 → 201", async () => {
        const response = await api("POST", "/auth/register", { token: null, body: { email, password: "password123", inviteCode } });
        assertEq(response.status, 201, "正确邀请码注册状态 body=" + response.text.slice(0, 200));
        const userId = response.json && response.json.user && response.json.user.userId;
        assert(typeof userId === "string" && userId.length > 0, "注册响应缺少 userId body=" + response.text.slice(0, 200));
        context.userId = userId;
        return "201 userId=" + userId;
    });

    await step("auth.register.duplicate", "POST /auth/register 重复邮箱 → 409", async () => {
        const response = await api("POST", "/auth/register", { token: null, body: { email, password: "password123", inviteCode } });
        assertEq(response.status, 409, "重复邮箱注册状态 body=" + response.text.slice(0, 200));
        return "409 " + response.text.slice(0, 120);
    });

    await step("auth.register.weak_password", "POST /auth/register 弱密码 → 400", async () => {
        const response = await api("POST", "/auth/register", { token: null, body: { email: "fc-weak-" + tag + "@example.com", password: "short", inviteCode } });
        assertEq(response.status, 400, "弱密码注册状态 body=" + response.text.slice(0, 200));
        return "400 " + response.text.slice(0, 120);
    });

    await step("auth.login", "POST /auth/login → 200", async () => {
        const response = await api("POST", "/auth/login", { token: null, body: { email, password: "password123" } });
        assertEq(response.status, 200, "登录状态 body=" + response.text.slice(0, 200));
        const token = response.json && response.json.token;
        assert(typeof token === "string" && token.length > 0, "登录响应缺少 token body=" + response.text.slice(0, 200));
        context.token = token;
        context.userId = response.json.userId;
        return "200 userId=" + String(response.json.userId) + " expiresAt=" + String(response.json.expiresAt);
    });

    await step("auth.logout", "POST /auth/logout → 200 且 token 失效", async () => {
        const sessionEmail = "fc-logout-" + tag + "@example.com";
        const registered = await api("POST", "/auth/register", { token: null, body: { email: sessionEmail, password: "password123", inviteCode } });
        assertEq(registered.status, 201, "会话账号注册状态 body=" + registered.text.slice(0, 200));
        const login = await api("POST", "/auth/login", { token: null, body: { email: sessionEmail, password: "password123" } });
        assertEq(login.status, 200, "会话账号登录状态 body=" + login.text.slice(0, 200));
        const sessionToken = login.json.token;
        const logout = await api("POST", "/auth/logout", { token: sessionToken });
        assertEq(logout.status, 200, "logout 状态 body=" + logout.text.slice(0, 200));
        const after = await api("GET", "/workspaces", { token: sessionToken });
        assertEq(after.status, 401, "logout 后旧 token 访问状态 body=" + after.text.slice(0, 200));
        return "logout=200 旧 token 访问=" + after.status;
    });

    await step("auth.sessions.delete", "DELETE /auth/sessions → 200 且吊销", async () => {
        const sessionEmail = "fc-sessions-" + tag + "@example.com";
        const registered = await api("POST", "/auth/register", { token: null, body: { email: sessionEmail, password: "password123", inviteCode } });
        assertEq(registered.status, 201, "会话账号注册状态 body=" + registered.text.slice(0, 200));
        const loginA = await api("POST", "/auth/login", { token: null, body: { email: sessionEmail, password: "password123" } });
        assertEq(loginA.status, 200, "登录 A 状态 body=" + loginA.text.slice(0, 200));
        const loginB = await api("POST", "/auth/login", { token: null, body: { email: sessionEmail, password: "password123" } });
        assertEq(loginB.status, 200, "登录 B 状态 body=" + loginB.text.slice(0, 200));
        const revoke = await api("DELETE", "/auth/sessions", { token: loginB.json.token });
        assertEq(revoke.status, 200, "DELETE /auth/sessions 状态 body=" + revoke.text.slice(0, 200));
        assert(revoke.json && revoke.json.ok === true, "DELETE /auth/sessions 缺少 ok=true body=" + revoke.text.slice(0, 200));
        const after = await api("GET", "/workspaces", { token: loginB.json.token });
        assertEq(after.status, 401, "吊销后旧 token 访问状态 body=" + after.text.slice(0, 200));
        return "revoked=" + String(revoke.json.revoked) + " 旧 token 访问=" + after.status;
    });

    // ---------------- workspace / conversation ----------------
    await step("workspace.create", "POST /workspaces → 201", async () => {
        const response = await api("POST", "/workspaces", { token: context.token, body: { name: "fc-ws-" + tag } });
        assertEq(response.status, 201, "创建 workspace 状态 body=" + response.text.slice(0, 200));
        const workspace = response.json && response.json.workspace;
        assert(workspace && typeof workspace.id === "string", "创建 workspace 响应缺少 id body=" + response.text.slice(0, 200));
        context.workspaceId = workspace.id;
        return "201 id=" + workspace.id + " rootPath=" + String(workspace.rootPath);
    });

    await step("workspace.list", "GET /workspaces 包含新建项", async () => {
        const response = await api("GET", "/workspaces", { token: context.token });
        assertEq(response.status, 200, "列出 workspace 状态 body=" + response.text.slice(0, 200));
        const list = (response.json && response.json.workspaces) || [];
        const found = list.some((item: any) => item.id === context.workspaceId);
        assert(found, "列出的 workspace 不包含新建 id=" + String(context.workspaceId));
        return "count=" + list.length;
    });

    await step("conversation.create", "POST /workspaces/:id/conversations → 201", async () => {
        const response = await api("POST", "/workspaces/" + encodeURIComponent(context.workspaceId) + "/conversations", { token: context.token, body: { title: "fc-conv-" + tag } });
        assertEq(response.status, 201, "创建 conversation 状态 body=" + response.text.slice(0, 200));
        const conversation = response.json && response.json.conversation;
        assert(conversation && typeof conversation.id === "string", "创建 conversation 响应缺少 id body=" + response.text.slice(0, 200));
        context.conversationId = conversation.id;
        return "201 id=" + conversation.id;
    });

    await step("conversation.auto_create", "POST /conversations 自动建 workspace → 201", async () => {
        const response = await api("POST", "/conversations", { token: context.token, body: { title: "fc-auto-" + tag } });
        assertEq(response.status, 201, "自动建 conversation 状态 body=" + response.text.slice(0, 200));
        const conversation = response.json && response.json.conversation;
        assert(conversation && typeof conversation.id === "string", "自动建 conversation 响应缺少 id body=" + response.text.slice(0, 200));
        return "201 id=" + conversation.id + " workspaceId=" + String(conversation.workspaceId);
    });

    await step("conversation.get", "GET /conversations/:id → 200", async () => {
        const response = await api("GET", "/conversations/" + encodeURIComponent(context.conversationId), { token: context.token });
        assertEq(response.status, 200, "获取 conversation 状态 body=" + response.text.slice(0, 200));
        assert(response.json && response.json.conversation && response.json.conversation.id === context.conversationId, "conversation 不匹配 body=" + response.text.slice(0, 200));
        return "200 runs=" + (((response.json.runs || []) as any[]).length);
    });

    // ---------------- Run 生命周期（经 conversation 提交） ----------------
    await step("run.submit.message", "POST /conversations/:id/messages → 202 Run", async () => {
        const response = await api("POST", "/conversations/" + encodeURIComponent(context.conversationId) + "/messages", {
            token: context.token,
            body: { userInput: "请使用 write 工具创建文件 journey.txt，内容为 journey-ok。只做这一步，然后用一句话说明。" },
        });
        assertEq(response.status, 202, "提交消息状态 body=" + response.text.slice(0, 300));
        const run = response.json && response.json.run;
        assert(run && typeof run.id === "string", "消息响应缺少 run.id body=" + response.text.slice(0, 300));
        context.journeyRunId = run.id;
        return "202 runId=" + run.id + " status=" + String(run.status);
    });

    await step("run.lifecycle.complete", "轮询 GET /runs/:id → COMPLETED", async () => {
        const detail = await pollRun(context.journeyRunId, context.token);
        context.journeyDetail = detail;
        assertEq(detail.run.status, "COMPLETED", "journey run 终态（failureReason=" + String(detail.run.failureReason) + "）");
        return "COMPLETED runId=" + detail.run.id;
    });

    await step("run.events.lifecycle", "GET /runs/:id/events 含关键生命周期事件", async () => {
        const events = await getEvents(context.journeyRunId, context.token);
        context.journeyEvents = events;
        const types = events.map((event: any) => event.type);
        const missing: string[] = [];
        for (const wanted of ["RUN_CREATED", "RUN_STARTED", "SANDBOX_ACQUIRED", "RUN_COMPLETED", "RUN_ARTIFACTS_READY"]) {
            if (types.includes(wanted) === false) {
                missing.push(wanted);
            }
        }
        assert(missing.length === 0, "缺少生命周期事件 " + missing.join(",") + "；实际=" + types.join(","));
        const unique = Array.from(new Set(types));
        return "事件数=" + events.length + " types=" + unique.join(",");
    });

    await step("run.output", "GET /runs/:id/output 非空", async () => {
        const response = await api("GET", "/runs/" + encodeURIComponent(context.journeyRunId) + "/output", { token: context.token });
        assertEq(response.status, 200, "GET output 状态 body=" + response.text.slice(0, 200));
        const output = response.json;
        assert(output && Array.isArray(output.chunks), "output 缺少 chunks body=" + response.text.slice(0, 200));
        const finalText = String(output.finalText || "");
        assert(output.chunks.length > 0 || finalText.length > 0, "output 为空");
        return "chunks=" + output.chunks.length + " finalText.len=" + finalText.length;
    });

    await step("run.workspace_diff", "GET /runs/:id/workspace-diff 含新增文件", async () => {
        const diff = await diffPaths(context.journeyRunId, context.token);
        const addedPaths = diff.added.map((item: any) => item.path);
        assert(addedPaths.length > 0, "workspace-diff 无新增文件（原始 diff=" + JSON.stringify(diff) + "）");
        return "added=" + JSON.stringify(addedPaths);
    });

    await step("run.artifacts", "GET /runs/:id/artifacts + 读取内容体", async () => {
        const artifacts = await artifactPaths(context.journeyRunId, context.token);
        assert(artifacts.length > 0, "artifacts 为空");
        const target = artifacts.find((item: any) => item.path === "journey.txt") ?? artifacts[0];
        const response = await api("GET", "/runs/" + encodeURIComponent(context.journeyRunId) + "/artifacts/" + encodeURIComponent(target.path), { token: context.token });
        assertEq(response.status, 200, "读取 artifact 内容状态");
        assert(response.text.length > 0, "artifact 内容为空");
        assert(response.text.includes("journey-ok"), "artifact 内容不含 journey-ok body=" + response.text.slice(0, 120));
        return "artifacts=" + JSON.stringify(artifacts.map((item: any) => item.path)) + " content=" + JSON.stringify(response.text.slice(0, 40));
    });

    await step("run.detail.inline", "GET /runs/:id 内联 decisions/limitations/unknownEffects", async () => {
        const detail = await getRunDetail(context.journeyRunId, context.token);
        assert(Array.isArray(detail.decisions), "decisions 不是数组");
        assert(Array.isArray(detail.limitations), "limitations 不是数组");
        assert(Array.isArray(detail.unknownEffects), "unknownEffects 不是数组");
        return "decisions=" + detail.decisions.length + " limitations=" + detail.limitations.length + " unknownEffects=" + detail.unknownEffects.length;
    });

    for (const subroute of ["decisions", "limitations", "unknown-effects"]) {
        await step("run.subroute." + subroute, "GET /runs/:id/" + subroute + " 独立路由", async () => {
            const response = await api("GET", "/runs/" + encodeURIComponent(context.journeyRunId) + "/" + subroute, { token: context.token });
            if (response.status === 200) {
                return "200 " + response.text.slice(0, 120);
            }
            return { status: "SKIP", detail: "平台未提供独立路由（实测 " + response.status + "），等价数据在 GET /runs/:id 内联返回，由 run.detail.inline 覆盖", evidence: "GET /runs/:id/" + subroute + " -> " + response.status };
        });
    }

    // F-K 观测项：同一 workspace 跨 Run 的文件可见性。
    // 期望：平台文档承诺「工作区是持久文件归属地」，因此上一条消息写的文件应当在下一条消息可见。
    await step("workspace.persistence", "同一 workspace 跨 Run 文件可见（F-K）", async () => {
        const marker = "persist-" + Date.now();
        await submitAndWait(
            context.workspaceId,
            "请使用 bash 工具执行：echo " + marker + " > persistence-marker.txt 。只做这一步。",
            context.token,
        );
        const second = await submitAndWait(
            context.workspaceId,
            "请使用 bash 工具执行：cat persistence-marker.txt 。只做这一步。",
            context.token,
        );
        const serialized = JSON.stringify(second.events);
        if (serialized.includes(marker)) {
            return "跨 Run 可见：第二轮 cat 读到了 " + marker;
        }
        return {
            status: "FAIL",
            detail: "上一条消息创建的文件在下一条消息不可见：guest 每个 Run 从工作区模板新建可写盘，宿主工作区只导出（artifacts/diff）不回灌（F-K）",
            evidence: "第二轮 cat 未见 " + marker + "；见 docs/full-coverage-report.zh-CN.md F-K",
        };
    });

    await step("system.queue", "GET /queue → 200", async () => {
        const response = await api("GET", "/queue", { token: context.token });
        assertEq(response.status, 200, "GET /queue 状态 body=" + response.text.slice(0, 200));
        assert(response.json && Array.isArray(response.json.queue), "/queue 缺少数组 body=" + response.text.slice(0, 200));
        return "queue.length=" + response.json.queue.length;
    });

    await step("system.resources", "GET /resources → 200 HOST_WIDE", async () => {
        const response = await api("GET", "/resources", { token: context.token });
        assertEq(response.status, 200, "GET /resources 状态 body=" + response.text.slice(0, 200));
        assert(response.json && response.json.visibility === "HOST_WIDE", "/resources visibility=" + JSON.stringify(response.json && response.json.visibility));
        return "visibility=" + response.json.visibility + " samples=" + (((response.json.samples || []) as any[]).length);
    });

    // ---------------- 工具矩阵 ----------------
    const toolCases: Array<{ id: string; tool: string; input: string; expectFile?: string }> = [
        { id: "tool.write", tool: "write", input: "使用 write 工具创建文件 tool-write.txt，内容为 hello-from-write。只做这一步。", expectFile: "tool-write.txt" },
        { id: "tool.read", tool: "read", input: "使用 read 工具读取当前工作区中的文件 tool-write.txt，并在回复中给出它的内容。只做这一步。" },
        // F-K：工作区文件不跨 Run 持久（guest 每 Run 从工作区模板新建可写盘），
        // 所以工具用例必须自包含：先在本 Run 内创建文件，再对它执行目标工具。
        { id: "tool.edit", tool: "edit", input: "先使用 bash 工具在当前工作区创建文件 tool-write.txt，内容为 hello-from-write；然后使用 edit 工具把其中的 hello-from-write 改成 hello-from-edit。只做这一步。", expectFile: "tool-write.txt" },
        { id: "tool.grep", tool: "grep", input: "使用 grep 工具在当前工作区搜索字符串 hello-from-edit。只做这一步。" },
        { id: "tool.find", tool: "find", input: "使用 find 工具在当前工作区查找所有 .txt 文件。只做这一步。" },
        { id: "tool.ls", tool: "ls", input: "使用 ls 工具列出当前工作区根目录下的文件。只做这一步。" },
        { id: "tool.bash", tool: "bash", input: "使用 bash 工具执行命令：echo bash-ok > tool-bash.txt。只做这一步。", expectFile: "tool-bash.txt" },
    ];

    for (const testCase of toolCases) {
        await step(testCase.id, "工具 " + testCase.tool + "：TOOL_COMPLETED isError=false", async () => {
            const outcome = await submitAndWait(context.workspaceId, testCase.input, context.token);
            requireToolCompleted(outcome.events, testCase.tool);
            let extra = "";
            if (testCase.expectFile !== undefined) {
                const diff = await diffPaths(outcome.runId, context.token);
                // N24 契约：added / deleted 条目有顶层 path，modified 是
                // { before: {path,...}, after: {path,...} } 包装（见 web/app.js 的 diffPath）。
                const addedPaths = diff.added.map((item: any) => item.path);
                const modifiedPaths = diff.modified.map((item: any) => (item && item.after ? item.after.path : item && item.path));
                const touched = addedPaths.concat(modifiedPaths);
                assert(touched.includes(testCase.expectFile), "workspace-diff 未体现 " + testCase.expectFile + "（added=" + JSON.stringify(addedPaths) + " modified=" + JSON.stringify(modifiedPaths) + "）");
                const artifacts = await artifactPaths(outcome.runId, context.token);
                const hasArtifact = artifacts.some((item: any) => item.path === testCase.expectFile);
                extra = " diff=" + JSON.stringify(touched) + " artifact=" + String(hasArtifact);
            }
            return "runId=" + outcome.runId + " status=" + outcome.status + " " + describeTools(outcome.events) + extra;
        });
    }

    // ---------------- interrupt / resume ----------------
    await step("run.interrupt", "长任务 → POST /runs/:id/interrupt → INTERRUPTED", async () => {
        const submit = await api("POST", "/runs", { token: context.token, body: { workspaceId: context.workspaceId, userInput: "使用 bash 工具执行命令：sleep 90。执行完不要做别的事。" } });
        const runId = runIdOf(submit);
        context.interruptRunId = runId;
        const status = await waitForStatus(runId, ["RUNNING", "WAITING_TOOL"], context.token, 90000);
        const interrupt = await api("POST", "/runs/" + encodeURIComponent(runId) + "/interrupt", { token: context.token });
        assertEq(interrupt.status, 200, "interrupt 状态（run 状态 " + status + "）body=" + interrupt.text.slice(0, 200));
        const afterStatus = interrupt.json && interrupt.json.run && interrupt.json.run.status;
        assertEq(afterStatus, "INTERRUPTED", "interrupt 后状态 body=" + interrupt.text.slice(0, 200));
        return "状态机 " + status + " → INTERRUPTED runId=" + runId;
    });

    await step("run.resume", "POST /runs/:id/resume → 记录真实行为", async () => {
        const runId = context.interruptRunId;
        assert(typeof runId === "string", "interrupt 阶段未产生 runId");
        const detail = await getRunDetail(runId, context.token);
        const checkpointId = detail.run.checkpointId;
        const resume = await api("POST", "/runs/" + encodeURIComponent(runId) + "/resume", { token: context.token, body: {} });
        if (checkpointId === null || checkpointId === undefined) {
            assertEq(resume.status, 409, "无 checkpoint 时 resume 状态 body=" + resume.text.slice(0, 200));
            return "真实行为：run.checkpointId=null，resume=" + resume.status + " body=" + resume.text.slice(0, 120);
        }
        assertEq(resume.status, 202, "resume 状态 body=" + resume.text.slice(0, 200));
        const resumedId = resume.json && resume.json.run && resume.json.run.id;
        assert(typeof resumedId === "string" && resumedId.length > 0, "resume 响应缺少 run.id body=" + resume.text.slice(0, 200));
        const finalDetail = await pollRun(resumedId, context.token);
        return "checkpoint=" + checkpointId + " resumeRun=" + resumedId + " 终态=" + finalDetail.run.status;
    });

    // ---------------- 幂等 ----------------
    await step("run.idempotency", "同 idempotencyKey 两次 → 同 runId 单 Run", async () => {
        const key = "fc-idem-" + tag;
        const userInput = "使用 bash 工具执行：echo idem-ok > idem.txt  # marker=" + key;
        const first = await api("POST", "/runs", { token: context.token, body: { workspaceId: context.workspaceId, userInput, idempotencyKey: key } });
        const second = await api("POST", "/runs", { token: context.token, body: { workspaceId: context.workspaceId, userInput, idempotencyKey: key } });
        assertEq(first.status, 202, "首次提交状态 body=" + first.text.slice(0, 300));
        assertEq(second.status, 202, "二次提交状态 body=" + second.text.slice(0, 300));
        const firstId = first.json.run.id;
        const secondId = second.json.run.id;
        assertEq(secondId, firstId, "两次提交 runId 一致性");
        await pollRun(firstId, context.token);
        const runs = await api("GET", "/runs", { token: context.token });
        const matching = ((runs.json && runs.json.runs) || []).filter((item: any) => item && typeof item.userInput === "string" && item.userInput.includes(key));
        assertEq(matching.length, 1, "同 key 命中 Run 数量");
        return "runId=" + firstId + " 命中 Run 数=" + matching.length;
    });

    // ---------------- backpressure（需 FULLCOVER_BACKPRESSURE=1） ----------------
    await step("run.backpressure", "第 2 个排队提交 → 429 + retry-after", async () => {
        if (flag("FULLCOVER_BACKPRESSURE") === false) {
            return { status: "SKIP", detail: "未设置 FULLCOVER_BACKPRESSURE=1（需要测试 master 配置 HARNESS_MAX_QUEUED_RUNS=1 且 HARNESS_MAX_ACTIVE_RUNS=1）", evidence: "" };
        }
        const blocker = await api("POST", "/runs", { token: context.token, body: { workspaceId: context.workspaceId, userInput: "使用 bash 工具执行命令：sleep 25。只做这一步。" } });
        const blockerId = runIdOf(blocker);
        const blockerStatus = await waitForStatus(blockerId, ["RUNNING", "WAITING_TOOL"], context.token, 90000);
        assert(blockerStatus === "RUNNING" || blockerStatus === "WAITING_TOOL", "blocker 未进入活跃状态：" + blockerStatus);
        const queued = await api("POST", "/runs", { token: context.token, body: { workspaceId: context.workspaceId, userInput: "使用 bash 工具执行：echo q1 > q1.txt" } });
        assertEq(queued.status, 202, "第 1 个排队提交状态 body=" + queued.text.slice(0, 200));
        const queuedId = queued.json.run.id;
        const rejected = await api("POST", "/runs", { token: context.token, body: { workspaceId: context.workspaceId, userInput: "使用 bash 工具执行：echo q2 > q2.txt" } });
        assertEq(rejected.status, 429, "第 2 个排队提交状态 body=" + rejected.text.slice(0, 200));
        assert(typeof rejected.headers["retry-after"] === "string", "429 缺少 retry-after 头 headers=" + JSON.stringify(rejected.headers));
        const blockerDetail = await pollRun(blockerId, context.token);
        await pollRun(queuedId, context.token);
        return "queued=" + queuedId + " 第 2 个=" + rejected.status + " retry-after=" + String(rejected.headers["retry-after"]) + " x-queue-limit=" + String(rejected.headers["x-queue-limit"]) + " blocker=" + blockerDetail.run.status;
    });

    // ---------------- 限流（需 FULLCOVER_RATELIMIT=1） ----------------
    await step("system.ratelimit", "限流：第 3 次请求 → 429 + x-ratelimit-*", async () => {
        if (flag("FULLCOVER_RATELIMIT") === false) {
            return { status: "SKIP", detail: "未设置 FULLCOVER_RATELIMIT=1（需要测试 master 配置 HARNESS_RATE_LIMIT_MAX_PER_IP=2）", evidence: "" };
        }
        const statuses: number[] = [];
        let lastHeaders: Record<string, string> = {};
        for (let index = 0; index < 3; index += 1) {
            const response = await api("GET", "/metrics", { token: apiKey });
            statuses.push(response.status);
            lastHeaders = response.headers;
        }
        assertEq(statuses[2], 429, "第 3 次请求状态 statuses=" + JSON.stringify(statuses));
        const hasRetryAfter = typeof lastHeaders["retry-after"] === "string";
        const hasLimit = typeof lastHeaders["x-ratelimit-limit"] === "string";
        assert(hasRetryAfter || hasLimit, "429 缺少限流头 headers=" + JSON.stringify(lastHeaders));
        return "statuses=" + JSON.stringify(statuses) + " retry-after=" + String(lastHeaders["retry-after"]) + " x-ratelimit-limit=" + String(lastHeaders["x-ratelimit-limit"]) + " x-ratelimit-remaining=" + String(lastHeaders["x-ratelimit-remaining"]);
    });

    // ---------------- MCP（需 FULLCOVER_MCP=1） ----------------
    await step("mcp.echo", "MCP echo：mcp__echo__echo → echo:<text>", async () => {
        if (flag("FULLCOVER_MCP") === false) {
            return { status: "SKIP", detail: "未设置 FULLCOVER_MCP=1（需要测试 master 配置 HARNESS_MCP_SERVERS 指向 tests/mcp/fixtures/echo-mcp-server.ts）", evidence: "" };
        }
        const outcome = await submitAndWait(context.workspaceId, "调用 mcp__echo__echo 工具，参数 text 为 fullcov-ping。只调用这一个工具，不要做别的。", context.token);
        const completed = findToolEvent(outcome.events, "mcp__echo__echo", "TOOL_COMPLETED");
        if (completed === null) {
            throw new Error("未观察到 mcp__echo__echo 的 TOOL_COMPLETED；工具事件：" + describeTools(outcome.events));
        }
        const text = JSON.stringify(completed.result);
        assert(text.includes("echo:") || text.includes("fullcov-ping"), "MCP echo 结果不含预期文本 result=" + text.slice(0, 200));
        return "runId=" + outcome.runId + " result=" + text.slice(0, 160);
    });

    // ---------------- 跨用户隔离 ----------------
    await step("user.cross_isolation", "跨用户访问他人 Run → 全部 404", async () => {
        assert(typeof context.journeyRunId === "string", "journey run 未创建，无法验证跨用户隔离");
        const otherEmail = "fc-userb-" + tag + "@example.com";
        const registered = await api("POST", "/auth/register", { token: null, body: { email: otherEmail, password: "password123", inviteCode } });
        assertEq(registered.status, 201, "第二用户注册状态 body=" + registered.text.slice(0, 200));
        const login = await api("POST", "/auth/login", { token: null, body: { email: otherEmail, password: "password123" } });
        assertEq(login.status, 200, "第二用户登录状态 body=" + login.text.slice(0, 200));
        const otherToken = login.json.token;
        const targetRun = context.journeyRunId;
        const checks: Array<{ label: string; method: string; path: string; body?: unknown }> = [
            { label: "GET run", method: "GET", path: "/runs/" + encodeURIComponent(targetRun) },
            { label: "GET events", method: "GET", path: "/runs/" + encodeURIComponent(targetRun) + "/events" },
            { label: "GET output", method: "GET", path: "/runs/" + encodeURIComponent(targetRun) + "/output" },
            { label: "GET artifacts", method: "GET", path: "/runs/" + encodeURIComponent(targetRun) + "/artifacts" },
            { label: "POST interrupt", method: "POST", path: "/runs/" + encodeURIComponent(targetRun) + "/interrupt" },
            { label: "POST run in other workspace", method: "POST", path: "/runs", body: { workspaceId: context.workspaceId, userInput: "echo cross" } },
        ];
        const observed: string[] = [];
        const wrong: string[] = [];
        for (const check of checks) {
            const response = await api(check.method, check.path, { token: otherToken, body: check.body });
            observed.push(check.label + "=" + response.status);
            if (response.status !== 404) {
                wrong.push(check.label + "=" + response.status + " body=" + response.text.slice(0, 80));
            }
        }
        assert(wrong.length === 0, "跨用户未返回 404：" + wrong.join("; "));
        return observed.join(", ");
    });

    // ---------------- 工具无关 UI 旅程 ----------------
    await step("journey.ui_flow", "UI 旅程：注册→登录→workspace→conversation→消息→轮询→output 非空", async () => {
        const journeyEmail = "fc-journey-" + tag + "@example.com";
        const registered = await api("POST", "/auth/register", { token: null, body: { email: journeyEmail, password: "password123", inviteCode } });
        assertEq(registered.status, 201, "旅程注册状态 body=" + registered.text.slice(0, 200));
        const login = await api("POST", "/auth/login", { token: null, body: { email: journeyEmail, password: "password123" } });
        assertEq(login.status, 200, "旅程登录状态 body=" + login.text.slice(0, 200));
        const token = login.json.token;
        const workspace = await api("POST", "/workspaces", { token, body: { name: "fc-journey-ws-" + tag } });
        assertEq(workspace.status, 201, "旅程 workspace 状态 body=" + workspace.text.slice(0, 200));
        const workspaceId = workspace.json.workspace.id;
        const conversation = await api("POST", "/workspaces/" + encodeURIComponent(workspaceId) + "/conversations", { token, body: { title: "journey" } });
        assertEq(conversation.status, 201, "旅程 conversation 状态 body=" + conversation.text.slice(0, 200));
        const message = await api("POST", "/conversations/" + encodeURIComponent(conversation.json.conversation.id) + "/messages", { token, body: { userInput: "用一句话回答：一加一等于几？不需要使用任何工具。" } });
        assertEq(message.status, 202, "旅程提交消息状态 body=" + message.text.slice(0, 200));
        const runId = message.json.run.id;
        const detail = await pollRun(runId, token);
        const output = await api("GET", "/runs/" + encodeURIComponent(runId) + "/output", { token });
        assertEq(output.status, 200, "旅程 output 状态 body=" + output.text.slice(0, 200));
        const finalText = String((output.json && output.json.finalText) || "");
        const chunks = (output.json && output.json.chunks) || [];
        assert(finalText.length > 0 || chunks.length > 0, "旅程 output 为空");
        return "runId=" + runId + " 终态=" + detail.run.status + " finalText.len=" + finalText.length + " chunks=" + chunks.length;
    });

    // ---------------- 汇总 ----------------
    const passed = results.filter((item) => item.status === "PASS").length;
    const failed = results.filter((item) => item.status === "FAIL");
    const skipped = results.filter((item) => item.status === "SKIP");
    const report = {
        generatedAt: new Date().toISOString(),
        baseUrl,
        tag,
        only: onlyIds,
        totals: { total: results.length, passed, failed: failed.length, skipped: skipped.length },
        results,
    };
    await Bun.write(outPath, JSON.stringify(report, null, 2));
    console.log("");
    console.log("报告已写入 " + outPath);
    console.log("统计：total=" + results.length + " passed=" + passed + " failed=" + failed.length + " skipped=" + skipped.length);
    if (failed.length === 0) {
        console.log("FULL_COVERAGE_SMOKE_OK passed=" + passed + " failed=0");
    } else {
        console.log("FULL_COVERAGE_SMOKE_FAIL failed=" + failed.length + " " + failed.map((item) => item.id).join(","));
    }
    if (skipped.length > 0) {
        console.log("FULL_COVERAGE_SMOKE_SKIP n=" + skipped.length + " " + skipped.map((item) => item.id).join(","));
    }
    process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
