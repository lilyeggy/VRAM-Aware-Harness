/** 带 tools schema 的流式请求：贴近 agent 首轮 payload。 */
const baseUrl = "https://opencode.ai/zen/go/v1";
const apiKey = process.env.OPENCODE_API_KEY ?? "";
const model = process.env.MODEL_ID ?? "deepseek-v4.1-flash";
const filler = "The quick brown fox jumps over the lazy dog. ".repeat(220);

const tools = ["bash", "read", "write", "edit", "grep", "find", "ls", "todo"].map((name) => ({
    type: "function",
    function: {
        name,
        description: `Tool ${name} for the coding agent.`,
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                content: { type: "string" },
                pattern: { type: "string" },
            },
            required: ["path"],
        },
    },
}));

function pct(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index] ?? 0;
}

async function one(): Promise<{ ttft: number; status: number }> {
    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            "x-opencode-session": crypto.randomUUID(),
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: "system", content: `You are a coding agent. Context: ${filler}` },
                { role: "user", content: "只回答 OK" },
            ],
            tools,
            max_tokens: 32,
            stream: true,
        }),
    });
    if (response.status !== 200 || response.body === null) {
        return { ttft: -1, status: response.status };
    }
    const reader = response.body.getReader();
    let ttft = -1;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttft < 0 && value !== undefined && value.length > 0) {
            ttft = performance.now() - startedAt;
        }
    }
    return { ttft, status: 200 };
}

async function wave(n: number): Promise<void> {
    const results = await Promise.all(Array.from({ length: n }, () => one()));
    const ttfts = results.filter((r) => r.status === 200).map((r) => r.ttft);
    const statusCounts: Record<number, number> = {};
    for (const result of results) statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
    console.log(
        `c=${String(n).padStart(2)} | ok=${ttfts.length}/${n} status=${JSON.stringify(statusCounts)}`
        + ` | ttft p50=${pct(ttfts, 50).toFixed(0)}ms p95=${pct(ttfts, 95).toFixed(0)}ms`,
    );
}

console.log(`model=${model} prompt≈2k + 8 tools streaming`);
for (const n of [1, 2, 3, 4, 6, 8]) {
    await wave(n);
    await wave(n);
    await wave(n);
}
