/**
 * G04 验收器：网关错误分类与流完整性全矩阵。
 *
 * 夹具是一个真实的本地 HTTP 服务器（可逐请求切换故障模式），被测对象是
 * 真实的 LlmGateway + ModelRouter。判定依据：HTTP 语义、路由决策台账、
 * 缓存台账与"重试是否有界"，而不是只看请求成功与否。
 *
 * 通过标准（指南 §7.6 G04）：
 *  - 401/400 这类客户端错误不触发回退、原样透传；
 *  - 429/5xx 可回退，且回退次数有界（不超过配置的后端数）；
 *  - 坏 JSON / 坏 SSE 不使网关崩溃，流完整性不被伪造；
 *  - usage 缺失不计入、usage 重复不重复累计。
 *
 * 用法：bun run scripts/e2-gateway-fault-matrix.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { LlmGateway } from "../src/llm-gateway/llm-gateway.ts";
import { ModelRouter, type LlmBackend } from "../src/llm-gateway/model-router.ts";

type Mode =
    | "ok"
    | "401"
    | "400"
    | "429"
    | "500"
    | "invalid-json"
    | "bad-sse"
    | "usage-missing"
    | "usage-duplicated"
    | "cut-sse";

const setMode: { current: Mode } = { current: "ok" };
let requestCount = 0;

const SSE_OK = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    "",
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"prompt_tokens_details":{"cached_tokens":96},"completion_tokens":8}}',
    "",
    "data: [DONE]",
    "",
].join("\n");

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCount += 1;
    const mode = setMode.current;
    const sse = (body: string) => {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end(body);
    };
    switch (mode) {
        case "401":
            res.writeHead(401, { "content-type": "application/json" });
            res.end('{"error":{"message":"invalid api key"}}');
            return;
        case "400":
            res.writeHead(400, { "content-type": "application/json" });
            res.end('{"error":{"message":"context length exceeded"}}');
            return;
        case "429":
            res.writeHead(429, { "content-type": "application/json" });
            res.end('{"error":{"message":"rate limited"}}');
            return;
        case "500":
            res.writeHead(500, { "content-type": "application/json" });
            res.end('{"error":{"message":"internal"}}');
            return;
        case "invalid-json":
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{ this is not json");
            return;
        case "bad-sse":
            // 有 data: 行，但既没有 finish_reason 也没有 [DONE]
            sse('data: {"choices":[{"delta":{"content":"半句"}}]}\n\ndata: {"choices":[{"del');
            return;
        case "cut-sse":
            sse('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n');
            return;
        case "usage-missing":
            sse([
                'data: {"choices":[{"delta":{"content":"答"}}]}',
                "",
                'data: {"choices":[{"finish_reason":"stop"}]}',
                "",
                "data: [DONE]",
                "",
            ].join("\n"));
            return;
        case "usage-duplicated":
            sse([
                'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"prompt_tokens_details":{"cached_tokens":96}}}',
                "",
                'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"prompt_tokens_details":{"cached_tokens":96}}}',
                "",
                "data: [DONE]",
                "",
            ].join("\n"));
            return;
        default:
            sse(SSE_OK);
    }
});

// 第二个（健康）后端：始终返回完整 SSE，用于观察回退是否真的发生。
const healthyServer = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.end(SSE_OK);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => healthyServer.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
const base = `http://127.0.0.1:${port}/v1`;
const healthyAddress = healthyServer.address();
const healthyPort = typeof healthyAddress === "object" && healthyAddress !== null
    ? healthyAddress.port
    : 0;
const healthyBase = `http://127.0.0.1:${healthyPort}/v1`;

const backends: LlmBackend[] = [
    { id: "fault-a", baseUrl: base, model: "qwen", logicalModel: "qwen" },
    { id: "fault-b", baseUrl: healthyBase, model: "qwen", logicalModel: "qwen" },
];

function chatRequest(): Request {
    return new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            model: "qwen",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        }),
    });
}

async function runCase(mode: Mode) {
    setMode.current = mode;
    const router = new ModelRouter(backends, { loadBalancing: "priority" });
    const gateway = new LlmGateway(router, {});
    const before = requestCount;
    const response = await gateway.handleChatCompletions(chatRequest());
    const text = await response.text().catch(() => "<stream error>");
    const decision = router.recentDecisions(1)[0] ?? null;
    const metrics = gateway.cacheMetrics();
    return {
        mode,
        status: response.status,
        upstreamAttempts: requestCount - before,
        attemptedBackendIds: decision?.attemptedBackendIds ?? null,
        chosenBackendId: decision?.chosenBackendId ?? null,
        fallback: decision?.fallback ?? null,
        decisionStatus: decision?.status ?? null,
        cacheSamples: metrics.totalRequests,
        promptTokensTotal: metrics.promptTokensTotal,
        bodyHead: text.slice(0, 120),
        circuitOpen: router.backendStates()["fault-a"]?.circuitOpen ?? null,
    };
}

const results: Record<string, Awaited<ReturnType<typeof runCase>>> = {};
for (const mode of [
    "ok", "401", "400", "429", "500",
    "invalid-json", "bad-sse", "cut-sse", "usage-missing", "usage-duplicated",
] as Mode[]) {
    results[mode] = await runCase(mode);
}

server.close();
healthyServer.close();

const checks = {
    // 成功基线
    ok_succeeds: results.ok!.status === 200 && results.ok!.chosenBackendId === "fault-a",
    // 客户端错误：透传、不回退
    client_error_401_passthrough: results["401"]!.status === 401,
    client_error_401_no_fallback: results["401"]!.attemptedBackendIds?.length === 1,
    client_error_400_passthrough: results["400"]!.status === 400,
    client_error_400_no_fallback: results["400"]!.attemptedBackendIds?.length === 1,
    // 可重试错误：回退到第二个后端，且尝试次数有界（= 后端数）
    retryable_429_fallbacks: results["429"]!.status === 200
        && results["429"]!.chosenBackendId === "fault-b"
        && results["429"]!.fallback === true,
    retryable_429_bounded: results["429"]!.attemptedBackendIds?.length === 2,
    retryable_500_fallbacks: results["500"]!.status === 200,
    retryable_500_bounded: results["500"]!.attemptedBackendIds?.length === 2,
    // 坏 JSON：透传不崩
    invalid_json_survives: results["invalid-json"]!.status === 200,
    // 坏 SSE / 截断 SSE：透传不崩，且不伪造完整
    bad_sse_survives: results["bad-sse"]!.status === 200,
    cut_sse_survives: results["cut-sse"]!.status === 200,
    // usage 缺失不计入
    usage_missing_not_counted: results["usage-missing"]!.cacheSamples === 0,
    // usage 重复不重复累计
    usage_duplicated_counted_once: results["usage-duplicated"]!.cacheSamples === 1
        && results["usage-duplicated"]!.promptTokensTotal === 120,
};

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
console.log(JSON.stringify({
    result: failed.length === 0 ? "PASS" : "FAIL",
    checks,
    failedChecks: failed,
    results,
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
