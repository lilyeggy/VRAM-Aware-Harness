import { describe, expect, it } from "bun:test";

import {
    LlmGateway,
} from "../../src/llm-gateway/llm-gateway.ts";
import {
    computePrefixFingerprint,
    extractCachedTokensFromResponse,
    normalizePromptForPrefixCache,
    stableStringify,
    type ChatMessage,
    type ToolDefinition,
} from "../../src/llm-gateway/prompt-prefix.ts";
import {
    ModelRouter,
    type LlmBackend,
} from "../../src/llm-gateway/model-router.ts";

const BACKEND: LlmBackend[] = [
    { id: "vllm-gpu0", baseUrl: "http://gpu0/v1", model: "qwen", logicalModel: "qwen" },
];

describe("支柱 2：Prompt 稳定前缀规范化", () => {
    const TOOLS_A: ToolDefinition[] = [
        { type: "function", function: { name: "bash", description: "run" } },
        { type: "function", function: { name: "read", description: "read" } },
    ];

    it("system 消息全部提前，工具按名字排序（幂等）", () => {
        const body = {
            model: "qwen",
            messages: [
                { role: "user", content: "先动态上下文" },
                { role: "system", content: "SYSTEM-A" },
                { role: "assistant", content: "history" },
                { role: "system", content: "SYSTEM-B" },
            ],
            tools: TOOLS_A,
        };
        const once = normalizePromptForPrefixCache(body);
        const roles = (once.messages as ChatMessage[]).map((m) => m.role);
        expect(roles).toEqual(["system", "system", "user", "assistant"]);
        expect((once.messages as ChatMessage[]).map((m) => m.content))
            .toEqual(["SYSTEM-A", "SYSTEM-B", "先动态上下文", "history"]);
        const twice = normalizePromptForPrefixCache(once);
        expect(stableStringify(twice)).toBe(stableStringify(once));
    });

    it("tools 乱序不影响转发体：稳定前缀逐字节一致", () => {
        const reordered = [...TOOLS_A].reverse();
        const first = normalizePromptForPrefixCache({
            messages: [{ role: "system", content: "S" }],
            tools: TOOLS_A,
        });
        const second = normalizePromptForPrefixCache({
            messages: [{ role: "system", content: "S" }],
            tools: reordered,
        });
        expect(stableStringify(first.tools)).toBe(stableStringify(second.tools));
    });

    it("前缀指纹：稳定前缀相同 → 指纹相同；动态上下文变化不影响", () => {
        const system = { messages: [{ role: "system", content: "S" }], tools: TOOLS_A };
        const fingerprint = computePrefixFingerprint(system);

        const dynamic = {
            messages: [
                { role: "system", content: "S" },
                { role: "user", content: "第 1 轮问题" },
            ],
            tools: TOOLS_A,
        };
        const dynamic2 = {
            messages: [
                { role: "system", content: "S" },
                { role: "user", content: "第 2 轮问题" },
            ],
            tools: [...TOOLS_A].reverse(),
        };
        expect(computePrefixFingerprint(dynamic)).toBe(fingerprint);
        expect(computePrefixFingerprint(dynamic2)).toBe(fingerprint);

        // System Prompt 变化必须打破缓存指纹。
        const changed = {
            messages: [{ role: "system", content: "S-v2" }],
            tools: TOOLS_A,
        };
        expect(computePrefixFingerprint(changed)).not.toBe(fingerprint);
    });

    it("无 system 且无 tools 时指纹为 null", () => {
        expect(computePrefixFingerprint({
            messages: [{ role: "user", content: "hi" }],
        })).toBeNull();
    });
});

describe("支柱 2：cached_tokens 采集", () => {
    function okWithUsage(cachedTokens: number): Response {
        return new Response(JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: {
                prompt_tokens: 256,
                completion_tokens: 16,
                total_tokens: 272,
                prompt_tokens_details: { cached_tokens: cachedTokens },
            },
        }), { status: 200, headers: { "content-type": "application/json" } });
    }

    it("extractCachedTokensFromResponse 解析 vLLM usage 结构", () => {
        const payload = {
            usage: {
                prompt_tokens: 100,
                prompt_tokens_details: { cached_tokens: 80 },
            },
        };
        expect(extractCachedTokensFromResponse(payload)).toEqual({
            promptTokens: 100,
            cachedTokens: 80,
        });
        expect(extractCachedTokensFromResponse({})).toEqual({
            promptTokens: null,
            cachedTokens: null,
        });
        expect(extractCachedTokensFromResponse({
            usage: { prompt_tokens: 10, cached_tokens: 4 },
        })).toEqual({ promptTokens: 10, cachedTokens: 4 });
    });

    it("网关提取 cached_tokens、记录台账并触发持久化 sink", async () => {
        const persisted: unknown[] = [];
        const router = new ModelRouter(BACKEND, { loadBalancing: "priority" });
        const gateway = new LlmGateway(router, {
            fetchImpl: (async () => okWithUsage(192)) as unknown as typeof fetch,
            cacheSampleSink: (sample) => {
                persisted.push(sample);
            },
        });

        const res = await gateway.handleChatCompletions(new Request(
            "http://gw/v1/chat/completions",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model: "qwen",
                    messages: [
                        { role: "system", content: "SYSTEM" },
                        { role: "user", content: "hi" },
                    ],
                    tools: [
                        { type: "function", function: { name: "read" } },
                        { type: "function", function: { name: "bash" } },
                    ],
                }),
            },
        ));

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            usage: { prompt_tokens_details: { cached_tokens: number } };
        };
        // 响应原样透传，客户端仍能看到 usage。
        expect(body.usage.prompt_tokens_details.cached_tokens).toBe(192);

        const metrics = gateway.cacheMetrics();
        expect(metrics.totalRequests).toBe(1);
        expect(metrics.promptTokensTotal).toBe(256);
        expect(metrics.cachedTokensTotal).toBe(192);
        expect(metrics.cacheHitRate).toBeCloseTo(192 / 256);
        expect(persisted).toHaveLength(1);
        const sample = metrics.recentSamples[0]!;
        expect(sample.backendId).toBe("vllm-gpu0");
        expect(sample.cachedTokens).toBe(192);
        expect(sample.prefixCacheKey).toBe(
            computePrefixFingerprint({
                messages: [{ role: "system", content: "SYSTEM" }],
                tools: [
                    { type: "function", function: { name: "read" } },
                    { type: "function", function: { name: "bash" } },
                ],
            }),
        );

        const decision = router.recentDecisions(1)[0]!;
        expect(decision.cachedTokens).toBe(192);
        expect(decision.promptTokens).toBe(256);
        expect(decision.prefixCacheKey).toBe(sample.prefixCacheKey);
        expect(router.stats().cacheHitRate).toBeCloseTo(192 / 256);
    });

    it("关闭 prefix 优化时不规范化、不采集（保持旧路径）", async () => {
        let seenBody: Record<string, unknown> | undefined;
        const router = new ModelRouter(BACKEND, { loadBalancing: "priority" });
        const gateway = new LlmGateway(router, {
            prefixCacheEnabled: false,
            fetchImpl: (async (_url: string, init: RequestInit) => {
                seenBody = JSON.parse(String(init.body));
                return new Response(JSON.stringify({
                    choices: [],
                    usage: { prompt_tokens: 10 },
                }), { status: 200, headers: { "content-type": "application/json" } });
            }) as unknown as typeof fetch,
        });
        await gateway.handleChatCompletions(new Request(
            "http://gw/v1/chat/completions",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model: "qwen",
                    messages: [
                        { role: "user", content: "u" },
                        { role: "system", content: "s" },
                    ],
                }),
            },
        ));
        // 未规范化：system 仍在 user 后面；无缓存指标。
        expect((seenBody!.messages as ChatMessage[]).map((m) => m.role))
            .toEqual(["user", "system"]);
        expect(gateway.cacheMetrics().totalRequests).toBe(0);
    });

    it("流式响应直接透传 SSE，不做缓存解析", async () => {
        const router = new ModelRouter(BACKEND, { loadBalancing: "priority" });
        const gateway = new LlmGateway(router, {
            fetchImpl: (async () => new Response(
                "data: {\"choices\":[{}]}\n\ndata: [DONE]\n\n",
                {
                    status: 200,
                    headers: {
                        "content-type": "text/event-stream; charset=utf-8",
                    },
                },
            )) as unknown as typeof fetch,
        });
        const res = await gateway.handleChatCompletions(new Request(
            "http://gw/v1/chat/completions",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model: "qwen",
                    stream: true,
                    messages: [{ role: "user", content: "hi" }],
                }),
            },
        ));
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        expect(await res.text()).toContain("[DONE]");
        expect(gateway.cacheMetrics().totalRequests).toBe(0);
    });
});
