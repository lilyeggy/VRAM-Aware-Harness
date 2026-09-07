// Run against the service; supply BENCH_TOKEN and BENCH_WORKSPACE without logging credentials.
const base = process.env.BASE_URL ?? "http://127.0.0.1:13000";
const token = process.env.BENCH_TOKEN, workspaceId = process.env.BENCH_WORKSPACE;
if (!token || !workspaceId) throw new Error("BENCH_TOKEN and BENCH_WORKSPACE required");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
async function api(path: string, body?: unknown): Promise<any> {
    const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(15000), ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
    return response.json();
}
const results = [];
const rounds = Number(process.env.ROUNDS ?? "8");
for (const concurrency of [1, 2, 4, 6]) {
  for (let round = 1; round <= rounds; round++) {
    const batch = await Promise.all(Array.from({length: concurrency}, async () => {
        const {run} = await api("/runs", {workspaceId, sessionId: crypto.randomUUID(), userInput: "请只回答：PASS", thinkingLevel: "off"});
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            const current = (await api(`/runs/${run.id}`)).run;
            if (["COMPLETED", "FAILED", "INTERRUPTED"].includes(current.status)) return {concurrency, round, ...(await api(`/runs/${run.id}/observability`))};
            await Bun.sleep(500);
        }
        return {concurrency, runId: run.id, error: "benchmark timeout"};
    }));
    results.push(...batch);
  }
}
console.log(JSON.stringify({experiment: "observability-smoke", generatedAt: new Date().toISOString(), results}, null, 2));
export {};
