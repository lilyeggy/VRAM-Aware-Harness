/**
 * 外部模型服务并发容量探针（直接打 opencode-go，不经过 Harness）。
 * 用法：OPENCODE_API_KEY=... bun run model-capacity.ts
 */
const baseUrl = process.env.MODEL_BASE_URL ?? "https://opencode.ai/zen/go/v1";
const model = process.env.MODEL_ID ?? "deepseek-v4.1-flash";
const apiKey = process.env.OPENCODE_API_KEY ?? "";

function pct(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index] ?? 0;
}

interface Result { status: number; latencyMs: number; tokens: number; }

async function oneRequest(): Promise<Result> {
    const startedAt = performance.now();
    try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${apiKey}`,
                // opencode-go 需要会话 id 才能高效路由（缺省会 400）。
                "x-opencode-session": crypto.randomUUID(),
            },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: "只回答 OK" }],
                max_tokens: 16,
                stream: false,
            }),
        });
        const text = await response.text();
        const latencyMs = performance.now() - startedAt;
        let tokens = 0;
        try {
            const json = JSON.parse(text);
            tokens = json?.usage?.total_tokens ?? 0;
        } catch { /* 非 JSON 响应按 0 token 计 */ }
        return { status: response.status, latencyMs, tokens };
    } catch {
        return { status: 0, latencyMs: performance.now() - startedAt, tokens: 0 };
    }
}

async function wave(concurrency: number): Promise<Result[]> {
    const startedAt = performance.now();
    const results = await Promise.all(
        Array.from({ length: concurrency }, () => oneRequest()),
    );
    const wallMs = performance.now() - startedAt;
    const latencies = results.map((result) => result.latencyMs);
    const ok = results.filter((result) => result.status === 200).length;
    const rateLimited = results.filter((result) => result.status === 429).length;
    const other = results.length - ok - rateLimited;
    const tokens = results.reduce((sum, result) => sum + result.tokens, 0);

    console.log(
        `c=${String(concurrency).padStart(2)} | ok=${ok} 429=${rateLimited} other=${other}`
        + ` | wall=${wallMs.toFixed(0)}ms`
        + ` | p50=${pct(latencies, 50).toFixed(0)}ms p95=${pct(latencies, 95).toFixed(0)}ms`
        + ` | ${(tokens / (wallMs / 1000)).toFixed(1)} tok/s`,
    );
    return results;
}

if (apiKey.length === 0) {
    console.log("MISSING OPENCODE_API_KEY");
    process.exit(1);
}

console.log(`base=${baseUrl} model=${model}`);
for (const concurrency of [1, 5, 10, 20]) {
    await wave(concurrency);
    await wave(concurrency);
}
