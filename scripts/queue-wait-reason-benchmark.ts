/**
 * Real-service diagnostic: prove that a queued Run retains the concrete reason
 * that blocked it. It creates disposable test users/workspaces and never logs
 * credentials or bearer tokens.
 */

const base = process.env.BASE_URL ?? "http://127.0.0.1:13000";
const password = `QueueReason-${crypto.randomUUID()}`;

type Client = { token: string; workspaceId: string };
type ExpectedReason =
    | "GLOBAL_CONCURRENCY_LIMIT"
    | "TENANT_CONCURRENCY_LIMIT"
    | "SESSION_SERIALIZATION";

async function json(response: Response): Promise<any> {
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
}

async function createClient(label: string): Promise<Client> {
    const email = `queue-reason-${label}-${Date.now()}-${crypto.randomUUID()}@benchmark.local`;
    await json(await fetch(`${base}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
    }));
    const login = await json(await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
    }));
    const token = login.token as string;
    const workspace = await call(token, "/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: `queue-reason-${label}` }),
    });
    return { token, workspaceId: workspace.workspace.id as string };
}

async function call(token: string, path: string, init: RequestInit = {}): Promise<any> {
    return json(await fetch(`${base}${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(init.headers ?? {}),
        },
    }));
}

async function submit(client: Client, sessionId: string, marker: string): Promise<string> {
    const submitted = await call(client.token, "/runs", {
        method: "POST",
        body: JSON.stringify({
            workspaceId: client.workspaceId,
            sessionId,
            thinkingLevel: "off",
            // Long enough that concurrently admitted Runs retain their slots
            // while later requests are observed, but harmless to the workspace.
            userInput: `请用中文分十点解释多租户 Agent 调度中的 ${marker}，每点不少于两句话。`,
        }),
    });
    return submitted.run.id as string;
}

async function waitForReason(
    client: Client,
    runId: string,
    expected: ExpectedReason,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const response = await call(client.token, `/runs/${runId}/events`);
        const event = (response.events as Array<any>).find(
            (item) => item.type === "QUEUE_BLOCKED"
                && item.payload?.reasonCode === expected,
        );
        if (event !== undefined) return event.payload as Record<string, unknown>;
        await Bun.sleep(150);
    }
    throw new Error(`Run ${runId} 未在 30 秒内记录 ${expected}`);
}

async function waitForTerminal(client: Client, runIds: readonly string[]): Promise<void> {
    const pending = new Set(runIds);
    const deadline = Date.now() + 120_000;
    while (pending.size > 0 && Date.now() < deadline) {
        await Promise.all([...pending].map(async (runId) => {
            const response = await call(client.token, `/runs/${runId}`);
            if (["COMPLETED", "FAILED", "INTERRUPTED"].includes(response.run.status)) {
                pending.delete(runId);
            }
        }));
        if (pending.size > 0) await Bun.sleep(300);
    }
    if (pending.size > 0) throw new Error(`等待终态超时：${pending.size} 个 Run`);
}

const tenantA = await createClient("a");
const tenantB = await createClient("b");
const results: Array<Record<string, unknown>> = [];

// 4 active slots + 2 queued across two tenants validates global capacity.
const globalRuns = await Promise.all([
    ...Array.from({ length: 3 }, (_, index) => submit(tenantA, crypto.randomUUID(), `全局并发 A-${index}`)),
    ...Array.from({ length: 3 }, (_, index) => submit(tenantB, crypto.randomUUID(), `全局并发 B-${index}`)),
]);
const globalMatch = await Promise.any([
    ...globalRuns.slice(0, 3).map(async (runId) => ({
        runId,
        payload: await waitForReason(tenantA, runId, "GLOBAL_CONCURRENCY_LIMIT"),
    })),
    ...globalRuns.slice(3).map(async (runId) => ({
        runId,
        payload: await waitForReason(tenantB, runId, "GLOBAL_CONCURRENCY_LIMIT"),
    })),
]);
results.push({ scenario: "global", runId: globalMatch.runId, ...globalMatch.payload });

// Wait for the global scenario to drain before isolating the tenant-cap test;
// otherwise a global blocker would be incorrectly attributed to this case.
await Promise.all([
    waitForTerminal(tenantA, globalRuns.slice(0, 3)),
    waitForTerminal(tenantB, globalRuns.slice(3)),
]);
const tenantRuns = await Promise.all(Array.from(
    { length: 4 },
    (_, index) => submit(tenantA, crypto.randomUUID(), `单租户并发 ${index}`),
));
for (const runId of tenantRuns) {
    try {
        results.push({ scenario: "tenant", runId, ...(await waitForReason(tenantA, runId, "TENANT_CONCURRENCY_LIMIT")) });
        break;
    } catch { /* try the next Run */ }
}

await waitForTerminal(tenantA, tenantRuns);
const sharedSessionId = crypto.randomUUID();
await submit(tenantA, sharedSessionId, "同会话先行消息");
const serializedRun = await submit(tenantA, sharedSessionId, "同会话后续消息");
results.push({
    scenario: "session",
    runId: serializedRun,
    ...(await waitForReason(tenantA, serializedRun, "SESSION_SERIALIZATION")),
});

if (results.length !== 3) {
    throw new Error(`只验证到 ${results.length}/3 个排队原因`);
}

console.log(JSON.stringify({
    experiment: "real-queue-wait-reason-split",
    generatedAt: new Date().toISOString(),
    results,
}, null, 2));
