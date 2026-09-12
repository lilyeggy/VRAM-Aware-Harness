import { describe, expect, it, test } from "bun:test";

import {
    LlmGateway,
    type LlmCacheSample,
} from "../../src/llm-gateway/llm-gateway.ts";
import {
    ModelRouter,
    type LlmBackend,
} from "../../src/llm-gateway/model-router.ts";

const BACKEND: LlmBackend[] = [
    { id: "vllm-gpu0", baseUrl: "http://gpu0/v1", model: "qwen", logicalModel: "qwen" },
];

const UPSTREAM_SSE = [
    "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}",
    "",
    "data: {\"choices\":[{}],\"usage\":{\"prompt_tokens\":120,\"prompt_tokens_details\":{\"cached_tokens\":96},\"completion_tokens\":8}}",
    "",
    "data: [DONE]",
    "",
].join("\n");

function streamingUpstream(
    seenBody: { value?: Record<string, unknown> },
): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
        seenBody.value = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(UPSTREAM_SSE, {
            status: 200,
            headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
    }) as unknown as typeof fetch;
}

async function postChatCompletions(
    gateway: LlmGateway,
    body: Record<string, unknown>,
): Promise<Response> {
    return gateway.handleChatCompletions(new Request(
        "http://gw/v1/chat/completions",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        },
    ));
}

describe("支柱 2：流式 usage 采集（stream_options 注入 + SSE 旁路扫描）", () => {
    it("客户端未声明 stream_options 时注入 include_usage，末尾 usage chunk 计入缓存台账，且响应字节原样透传", async () => {
        const seenBody: { value?: Record<string, unknown> } = {};
        const samples: LlmCacheSample[] = [];
        const gateway = new LlmGateway(new ModelRouter(BACKEND, { loadBalancing: "priority" }), {
            fetchImpl: streamingUpstream(seenBody),
            cacheSampleSink: (sample) => samples.push(sample),
        });

        const response = await postChatCompletions(gateway, {
            model: "qwen",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        });

        // 转发请求带上了 include_usage 注入。
        expect(seenBody.value?.stream_options).toEqual({ include_usage: true });

        // 响应字节原样透传（内容不被改写）。
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const passthroughText = await response.text();
        expect(passthroughText).toBe(UPSTREAM_SSE);

        // 末尾 usage chunk 被采集为缓存样本（环形缓冲 + 持久化 sink）。
        const metrics = gateway.cacheMetrics();
        expect(metrics.totalRequests).toBe(1);
        expect(metrics.promptTokensTotal).toBe(120);
        expect(metrics.cachedTokensTotal).toBe(96);
        expect(metrics.cacheHitRate).toBeCloseTo(96 / 120);
        expect(samples).toHaveLength(1);
        expect(samples[0]!.backendId).toBe("vllm-gpu0");
        expect(samples[0]!.cachedTokens).toBe(96);
    });

    it("客户端已带 stream_options 时不覆盖", async () => {
        const seenBody: { value?: Record<string, unknown> } = {};
        const gateway = new LlmGateway(new ModelRouter(BACKEND, { loadBalancing: "priority" }), {
            fetchImpl: streamingUpstream(seenBody),
        });

        await postChatCompletions(gateway, {
            model: "qwen",
            stream: true,
            stream_options: { include_usage: false },
            messages: [{ role: "user", content: "hi" }],
        });

        expect(seenBody.value?.stream_options).toEqual({ include_usage: false });
        expect(gateway.cacheMetrics().totalRequests).toBe(0);
    });

    it("streamUsageCapture 关闭时不注入、不采集", async () => {
        const seenBody: { value?: Record<string, unknown> } = {};
        const gateway = new LlmGateway(new ModelRouter(BACKEND, { loadBalancing: "priority" }), {
            fetchImpl: streamingUpstream(seenBody),
            streamUsageCapture: false,
        });

        const response = await postChatCompletions(gateway, {
            model: "qwen",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        });

        expect(seenBody.value?.stream_options).toBeUndefined();
        expect(await response.text()).toBe(UPSTREAM_SSE);
        expect(gateway.cacheMetrics().totalRequests).toBe(0);
    });

    it("无 usage chunk 的普通流不受影响，也不计入台账", async () => {
        const gateway = new LlmGateway(new ModelRouter(BACKEND, { loadBalancing: "priority" }), {
            fetchImpl: (async () => new Response(
                "data: {\"choices\":[{}]}\n\ndata: [DONE]\n\n",
                {
                    status: 200,
                    headers: { "content-type": "text/event-stream; charset=utf-8" },
                },
            )) as unknown as typeof fetch,
        });

        const response = await postChatCompletions(gateway, {
            model: "qwen",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        });

        expect(await response.text()).toContain("[DONE]");
        expect(gateway.cacheMetrics().totalRequests).toBe(0);
    });
});

test("GET /v1/models 经网关返回逻辑模型清单（Pi 启动发现用）", async () => {
    const router = new ModelRouter([
        { id: "b1", baseUrl: "http://127.0.0.1:18000/v1", model: "qwen", logicalModel: "qwen2.5-7b-instruct" },
    ]);
    const gateway = new LlmGateway(router);
    const response = gateway.handleListModels();
    expect(response.status).toBe(200);
    const body = await response.json() as {
        object: string;
        data: Array<{ id: string; object: string; owned_by: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual(["qwen2.5-7b-instruct"]);
    expect(body.data[0]!.owned_by).toBe("harness-llm-gateway");
});

// N17 回归：2026-09-10 G03 真机发现——后端在 finish_reason 之前断流时，
// 网关只看 HTTP 首包状态，不把这次失败记到后端头上，熔断器永不打开，
// 健康备用后端永远不被使用。这里断言断流会累计失败并最终熔断该后端。
test("N17：流在 finish_reason 之前断开必须记为该后端失败并触发熔断", async () => {
    const backends: LlmBackend[] = [
        { id: "vllm-gpu0", baseUrl: "http://gpu0:8000/v1", model: "qwen", logicalModel: "qwen" },
        { id: "vllm-gpu1", baseUrl: "http://gpu1:8000/v1", model: "qwen", logicalModel: "qwen" },
    ];
    const router = new ModelRouter(backends, { loadBalancing: "priority" });
    const gateway = new LlmGateway(router, {
        fetchImpl: (async (url: unknown) => {
            if (String(url).includes("gpu0")) {
                // 已发出部分 token，随后连接被上游掐断：没有 finish_reason，也没有 [DONE]。
                return new Response(new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(
                            "data: {\"choices\":[{\"delta\":{\"content\":\"部分\"}}]}\n\n",
                        ));
                        controller.error(new Error("upstream connection reset"));
                    },
                }), {
                    status: 200,
                    headers: { "content-type": "text/event-stream; charset=utf-8" },
                });
            }
            return new Response(UPSTREAM_SSE, {
                status: 200,
                headers: { "content-type": "text/event-stream; charset=utf-8" },
            });
        }) as unknown as typeof fetch,
    });

    for (let i = 0; i < 4; i += 1) {
        const response = await gateway.handleChatCompletions(new Request(
            "http://gw/v1/chat/completions",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: "qwen", stream: true, messages: [{ role: "user", content: "hi" }] }),
            },
        ));
        // 消费流入以触发"提前结束"检测；断流会让读取抛错，这是预期的。
        await response.text().catch(() => undefined);
    }

    expect(router.backendStates()["vllm-gpu0"]!.circuitOpen).toBe(true);
});
