import { expect, test } from "bun:test";

import { LlmGateway } from "../../src/llm-gateway/llm-gateway.ts";
import { ModelRouter, type LlmBackend } from "../../src/llm-gateway/model-router.ts";

const BACKENDS: LlmBackend[] = [
    {
        id: "vllm-local",
        baseUrl: "http://primary/v1",
        model: "real-model",
        logicalModel: "qwen",
    },
];

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatRequest(): Request {
    return new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            model: "qwen",
            messages: [{ role: "user", content: "hi" }],
        }),
    });
}

test("网关按 LLM 并发上限排队，不会把全部请求同时打给上游", async () => {
    let inflight = 0;
    let peak = 0;
    let upstreamCalls = 0;

    const fetchImpl = async (): Promise<Response> => {
        upstreamCalls += 1;
        inflight += 1;
        peak = Math.max(peak, inflight);
        await sleep(5);
        inflight -= 1;
        return new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    const gateway = new LlmGateway(new ModelRouter(BACKENDS), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        maxConcurrentRequests: 2,
    });

    const responses = await Promise.all(
        Array.from({ length: 10 }, () => gateway.handleChatCompletions(chatRequest())),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(upstreamCalls).toBe(10);
    expect(peak).toBeLessThanOrEqual(2);

    const stats = gateway.capacityStats();
    expect(stats).not.toBeNull();
    expect(stats?.limit).toBe(2);
    expect(stats?.acquired).toBe(10);
    expect(stats?.inflight).toBe(0);
    expect(stats?.waiting).toBe(0);
});

test("未配置并发上限时不排队（保持旧行为）", async () => {
    let inflight = 0;
    let peak = 0;

    const fetchImpl = async (): Promise<Response> => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await sleep(2);
        inflight -= 1;
        return new Response("{}", { status: 200 });
    };

    const gateway = new LlmGateway(new ModelRouter(BACKENDS), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all(
        Array.from({ length: 6 }, () => gateway.handleChatCompletions(chatRequest())),
    );

    expect(peak).toBeGreaterThan(2);
    expect(gateway.capacityStats()).toBeNull();
});
