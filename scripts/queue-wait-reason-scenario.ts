/** One isolated real-service scenario. Configure the scheduler outside this
 * script, then prove the expected persisted blocker via the public HTTP API. */
const base = process.env.BASE_URL ?? "http://127.0.0.1:13000";
const scenario = process.env.QUEUE_SCENARIO as "global" | "tenant" | "session";
const expected = {
    global: "GLOBAL_CONCURRENCY_LIMIT",
    tenant: "TENANT_CONCURRENCY_LIMIT",
    session: "SESSION_SERIALIZATION",
}[scenario];
if (expected === undefined) throw new Error("QUEUE_SCENARIO must be global, tenant, or session");

type Client = { token: string; workspaceId: string };
async function json(response: Response): Promise<any> {
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
}
async function call(token: string, path: string, init: RequestInit = {}): Promise<any> {
    return json(await fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    }));
}
async function createClient(label: string): Promise<Client> {
    const email = `queue-${scenario}-${label}-${Date.now()}-${crypto.randomUUID()}@benchmark.local`;
    const password = `Queue-${crypto.randomUUID()}`;
    await json(await fetch(`${base}/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }));
    const login = await json(await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }));
    const workspace = await call(login.token, "/workspaces", { method: "POST", body: JSON.stringify({ name: `queue-${scenario}-${label}` }) });
    return { token: login.token, workspaceId: workspace.workspace.id };
}
async function submit(client: Client, sessionId: string, label: string): Promise<string> {
    const response = await call(client.token, "/runs", { method: "POST", body: JSON.stringify({
        workspaceId: client.workspaceId, sessionId, thinkingLevel: "off",
        userInput: `请用中文写一段约五百字的说明，解释 Agent 调度中的${label}。`,
    }) });
    return response.run.id;
}
async function waitFor(client: Client, runId: string, predicate: (run: any, events: any[]) => boolean, timeoutMs = 30_000): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const [detail, history] = await Promise.all([call(client.token, `/runs/${runId}`), call(client.token, `/runs/${runId}/events`)]);
        if (predicate(detail.run, history.events)) return history.events;
        await Bun.sleep(100);
    }
    throw new Error(`Run ${runId} 未在 30 秒内达到目标状态`);
}

const first = await createClient("first");
const second = scenario === "global" ? await createClient("second") : first;
const sharedSession = scenario === "session" ? crypto.randomUUID() : undefined;
const activeRunId = await submit(first, sharedSession ?? crypto.randomUUID(), `${scenario} 的前序任务`);
// The production Pump interval can be up to one minute. SubmitRun requests an
// immediate tick, but this diagnostic tolerates a delayed tick so it does not
// mistake scheduler latency for a missing queue reason.
await waitFor(first, activeRunId, (run) => run.status === "RUNNING", 90_000);
const waitingRunId = await submit(second, sharedSession ?? crypto.randomUUID(), `${scenario} 的后续任务`);
const events = await waitFor(second, waitingRunId, (_run, history) => history.some(
    (event) => event.type === "QUEUE_BLOCKED" && event.payload?.reasonCode === expected,
));
const blocker = events.find((event) => event.type === "QUEUE_BLOCKED" && event.payload?.reasonCode === expected);

console.log(JSON.stringify({ experiment: "real-queue-wait-reason", scenario, expected, activeRunId, waitingRunId, blocker }, null, 2));
