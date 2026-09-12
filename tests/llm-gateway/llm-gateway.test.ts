import { describe, expect, it } from "bun:test";

import { LlmGateway } from "../../src/llm-gateway/llm-gateway.ts";
import { ModelRouter, type LlmBackend } from "../../src/llm-gateway/model-router.ts";

const BACKENDS: LlmBackend[] = [
    { id: "vllm-local", baseUrl: "http://primary/v1", model: "real-model", logicalModel: "qwen" },
    { id: "opencode-cloud", baseUrl: "http://backup/v1", model: "real-model", logicalModel: "qwen" },
];

function makeGateway(
    fetchImpl: (url: string) => Promise<Response>,
    routerOptions = {},
) {
    const router = new ModelRouter(BACKENDS, routerOptions);
    const gateway = new LlmGateway(router, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        requestId: (() => { let n = 0; return () => `req-${++n}`; })(),
    });
    return { router, gateway };
}

function chatRequest(model = "qwen"): Request {
    return new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
}

function okResponse(note: string): Response {
    return new Response(JSON.stringify({ choices: [], note }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

describe("ModelRouter 熔断", () => {
    it("连续失败达阈值后熔断并剔除，冷却后半开恢复", () => {
        let now = 1000;
        const router = new ModelRouter(BACKENDS, {
            circuitBreakerThreshold: 2,
            circuitCooldownMs: 30_000,
            now: () => now,
        });
        expect(router.candidatesFor("qwen").map((b) => b.id)).toEqual([
            "vllm-local", "opencode-cloud",
        ]);
        router.recordFailure("vllm-local");
        expect(router.candidatesFor("qwen").map((b) => b.id)).toContain("vllm-local");
        router.recordFailure("vllm-local"); // 达阈值 → 熔断
        expect(router.candidatesFor("qwen").map((b) => b.id)).toEqual(["opencode-cloud"]);
        expect(router.backendStates()["vllm-local"]!.circuitOpen).toBe(true);
        now += 31_000; // 冷却结束 → 半开
        expect(router.candidatesFor("qwen").map((b) => b.id)).toContain("vllm-local");
    });

    it("recordSuccess 复位失败计数与熔断", () => {
        const router = new ModelRouter(BACKENDS, { circuitBreakerThreshold: 2 });
        router.recordFailure("vllm-local");
        router.recordSuccess("vllm-local");
        router.recordFailure("vllm-local");
        expect(router.backendStates()["vllm-local"]!.circuitOpen).toBe(false);
    });
});

describe("LlmGateway 路由与回退", () => {
    it("主后端成功：选中主、不回退、model 被替换为后端真实模型", async () => {
        let seenModel: string | undefined;
        const { router, gateway } = makeGateway(async (url) => {
            expect(url).toBe("http://primary/v1/chat/completions");
            return okResponse("primary");
        });
        // 包装捕获 model
        const gw = new LlmGateway(new ModelRouter(BACKENDS), {
            fetchImpl: (async (_u: string, init: RequestInit) => {
                seenModel = JSON.parse(String(init.body)).model;
                return okResponse("primary");
            }) as unknown as typeof fetch,
        });
        const res = await gw.handleChatCompletions(chatRequest());
        expect(res.status).toBe(200);
        expect(seenModel).toBe("real-model");
        void router;
    });

    it("主 5xx → 回退备成功，决策标记 fallback 且记录尝试序列", async () => {
        const { router, gateway } = makeGateway(async (url) =>
            url.includes("primary")
                ? new Response("err", { status: 500 })
                : okResponse("backup"),
        );
        const res = await gateway.handleChatCompletions(chatRequest());
        expect(res.status).toBe(200);
        const d = router.recentDecisions(1)[0]!;
        expect(d.chosenBackendId).toBe("opencode-cloud");
        expect(d.fallback).toBe(true);
        expect(d.attemptedBackendIds).toEqual(["vllm-local", "opencode-cloud"]);
        expect(d.status).toBe("SUCCESS");
    });

    it("主网络错误（fetch 抛错）→ 回退备", async () => {
        const { gateway } = makeGateway(async (url) => {
            if (url.includes("primary")) throw new Error("ECONNREFUSED");
            return okResponse("backup");
        });
        const res = await gateway.handleChatCompletions(chatRequest());
        expect(res.status).toBe(200);
    });

    it("全部后端失败 → 502，决策 chosen=null", async () => {
        const { router, gateway } = makeGateway(async () => {
            throw new Error("down");
        });
        const res = await gateway.handleChatCompletions(chatRequest());
        expect(res.status).toBe(502);
        const d = router.recentDecisions(1)[0]!;
        expect(d.chosenBackendId).toBeNull();
        expect(d.status).toBe("FAILED");
    });

    it("4xx（非 429）视为请求问题：不回退、直接透传", async () => {
        let calls = 0;
        const { router, gateway } = makeGateway(async (url) => {
            calls++;
            return url.includes("primary")
                ? new Response(JSON.stringify({ error: "bad request" }), { status: 400 })
                : okResponse("backup");
        });
        const res = await gateway.handleChatCompletions(chatRequest());
        expect(res.status).toBe(400);
        expect(calls).toBe(1); // 没有回退到备
        expect(router.recentDecisions(1)[0]!.attemptedBackendIds).toEqual(["vllm-local"]);
    });

    it("主熔断后请求直接走备（跳过主）", async () => {
        const router = new ModelRouter(BACKENDS, { circuitBreakerThreshold: 1 });
        router.recordFailure("vllm-local"); // 阈值 1 → 立即熔断
        const gateway = new LlmGateway(router, {
            fetchImpl: (async (url: string) => {
                if (url.includes("primary")) throw new Error("不该再调主");
                return okResponse("backup");
            }) as unknown as typeof fetch,
        });
        const res = await gateway.handleChatCompletions(chatRequest());
        expect(res.status).toBe(200);
        expect(router.recentDecisions(1)[0]!.attemptedBackendIds).toEqual(["opencode-cloud"]);
    });

    it("未知逻辑模型 → 404 模型不存在（不再伪装成服务不可用）", async () => {
        const { gateway } = makeGateway(async () => okResponse("x"));
        const res = await gateway.handleChatCompletions(chatRequest("nonexistent"));
        expect(res.status).toBe(404);
        const body = await res.json() as { error: { type: string } };
        expect(body.error.type).toBe("model_not_found");
    });

    it("stats 聚合成功率与回退率", async () => {
        const { router, gateway } = makeGateway(async (url) =>
            url.includes("primary")
                ? new Response("e", { status: 500 })
                : okResponse("b"),
        );
        await gateway.handleChatCompletions(chatRequest());
        const s = router.stats();
        expect(s.totalRequests).toBe(1);
        expect(s.successCount).toBe(1);
        expect(s.fallbackCount).toBe(1);
    });
});
