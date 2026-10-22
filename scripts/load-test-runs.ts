/** 端到端并发负载：一次提交 N 个 Run（不同会话），统计成功率与墙钟分布。 */
const base = (process.env.HARNESS_BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const invite = process.env.HARNESS_REGISTRATION_INVITE_CODE ?? "";
const total = Number(process.env.LOAD_RUNS ?? 10);

function rand(n: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
function pct(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index] ?? 0;
}
async function call(method: string, path: string, token: string | null, body?: unknown) {
    const response = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: any = null;
    try { json = text.length === 0 ? null : JSON.parse(text); } catch { json = { raw: text }; }
    return { status: response.status, json };
}

const email = `load-${rand(8)}@example.test`;
const password = "Load-pass-1";
const reg = await call("POST", "/auth/register", null, { email, password, inviteCode: invite });
if (reg.status >= 300) { console.log("REGISTER_FAILED", reg.status); process.exit(1); }
const login = await call("POST", "/auth/login", null, { email, password });
const token: string = login.json?.token;
const workspace = await call("POST", "/workspaces", token, { name: `load-${rand(5)}` });
const workspaceId = workspace.json?.workspace?.id ?? workspace.json?.id;

const startedAt = performance.now();
const submitted: Array<{ id: string; at: number }> = [];
for (let index = 0; index < total; index += 1) {
    const run = await call("POST", "/runs", token, {
        workspaceId,
        sessionId: `load-session-${rand(8)}`,
        userInput: "使用 bash 工具执行 echo LOAD-OK，并只回答 LOAD-OK。",
    });
    if (run.status >= 300) { console.log("SUBMIT_FAILED", index, run.status, JSON.stringify(run.json).slice(0, 160)); process.exit(1); }
    submitted.push({ id: run.json.run.id, at: performance.now() });
}
const submitMs = performance.now() - startedAt;

const wallByRun: number[] = [];
const statuses: Record<string, number> = {};
const deadline = Date.now() + 300_000;
const pending = new Map(submitted.map((item) => [item.id, item.at]));
while (pending.size > 0 && Date.now() < deadline) {
    for (const [id, at] of [...pending]) {
        const detail = await call("GET", `/runs/${id}`, token);
        const status = detail.json?.run?.status ?? "?";
        if (["COMPLETED", "FAILED", "INTERRUPTED"].includes(status)) {
            statuses[status] = (statuses[status] ?? 0) + 1;
            wallByRun.push(performance.now() - at);
            pending.delete(id);
        }
    }
    if (pending.size > 0) await Bun.sleep(500);
}

let tokens = 0;
let cost = 0;
let unaccounted = 0;
for (const item of submitted) {
    const trace = await call("GET", `/runs/${item.id}/trace`, token);
    tokens += trace.json?.totals?.totalTokens ?? 0;
    cost += trace.json?.totals?.costTotal ?? 0;
    unaccounted += trace.json?.totals?.unaccountedMs ?? 0;
}

console.log(`RUNS=${total} submitWall=${submitMs.toFixed(0)}ms`);
console.log("STATUS", JSON.stringify(statuses));
console.log(`RUN_WALL p50=${pct(wallByRun, 50).toFixed(0)}ms p95=${pct(wallByRun, 95).toFixed(0)}ms max=${Math.max(...wallByRun).toFixed(0)}ms`);
console.log(`TOKENS total=${tokens} avg=${(tokens / total).toFixed(0)} COST total=$${cost.toFixed(6)}`);
console.log(`UNACCOUNTED avg=${(unaccounted / total).toFixed(0)}ms/run`);
console.log(statuses.COMPLETED === total ? "LOAD_OK" : "LOAD_PARTIAL");
