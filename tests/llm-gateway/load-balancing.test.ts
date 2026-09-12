import { describe, expect, it } from "bun:test";

import {
    BackendHealthMonitor,
} from "../../src/llm-gateway/backend-health-monitor.ts";
import {
    LlmGateway,
} from "../../src/llm-gateway/llm-gateway.ts";
import {
    ModelRouter,
    type LlmBackend,
} from "../../src/llm-gateway/model-router.ts";

/** 支柱 2：本地双卡 vLLM（GPU 0 / GPU 1）两个后端实例。 */
const DUAL_GPU: LlmBackend[] = [
    { id: "vllm-gpu0", baseUrl: "http://127.0.0.1:8000/v1", model: "qwen", logicalModel: "qwen" },
    { id: "vllm-gpu1", baseUrl: "http://127.0.0.1:8001/v1", model: "qwen", logicalModel: "qwen" },
];

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

function okResponse(backend: string): Response {
    return new Response(JSON.stringify({ choices: [], backend }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function makeGateway(
    backends: LlmBackend[],
    loadBalancing: "priority" | "round-robin" | "least-active",
    fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
) {
    const router = new ModelRouter(backends, { loadBalancing });
    const gateway = new LlmGateway(router, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { router, gateway };
}

describe("支柱 2：双卡负载均衡", () => {
    it("round-robin：请求在 GPU0/GPU1 间轮询分发", async () => {
        const hits: string[] = [];
        const { router, gateway } = makeGateway(
            DUAL_GPU,
            "round-robin",
            async (url) => {
                hits.push(url.includes("8000") ? "gpu0" : "gpu1");
                return okResponse(hits.at(-1)!);
            },
        );

        for (let i = 0; i < 4; i += 1) {
            const res = await gateway.handleChatCompletions(chatRequest());
            expect(res.status).toBe(200);
        }
        expect(hits).toEqual(["gpu0", "gpu1", "gpu0", "gpu1"]);
        expect(router.stats().loadBalancing).toBe("round-robin");
    });

    it("least-active：优先派发给在途请求最少的卡", () => {
        const router = new ModelRouter(DUAL_GPU, { loadBalancing: "least-active" });
        router.acquire("vllm-gpu0");
        router.acquire("vllm-gpu0");
        router.acquire("vllm-gpu1");

        expect(
            router.candidatesFor("qwen").map((b) => b.id),
        ).toEqual(["vllm-gpu1", "vllm-gpu0"]);

        router.release("vllm-gpu0");
        router.release("vllm-gpu0");
        router.release("vllm-gpu1");
        // 全部释放后恢复配置顺序（稳定排序）。
        expect(
            router.candidatesFor("qwen").map((b) => b.id),
        ).toEqual(["vllm-gpu0", "vllm-gpu1"]);
    });

    it("429/5xx 熔断：GPU0 持续 429 后自动回退 GPU1 且不再打 GPU0", async () => {
        const { router, gateway } = makeGateway(
            DUAL_GPU,
            "round-robin",
            async (url) => {
                if (url.includes("8000")) {
                    return new Response("rate limited", { status: 429 });
                }
                return okResponse("gpu1");
            },
        );

        // 轮询语义下 GPU0 每两轮被打一次，连续 3 次失败后熔断打开。
        for (let i = 0; i < 5; i += 1) {
            const res = await gateway.handleChatCompletions(chatRequest());
            expect(res.status).toBe(200);
        }
        expect(router.backendStates()["vllm-gpu0"]!.circuitOpen).toBe(true);

        // 熔断打开后：请求跳过 GPU0，直接命中 GPU1，不发生回退。
        const res = await gateway.handleChatCompletions(chatRequest());
        expect(res.status).toBe(200);
        const decision = router.recentDecisions(1)[0]!;
        expect(decision.chosenBackendId).toBe("vllm-gpu1");
        expect(decision.fallback).toBe(false);
        expect(decision.attemptedBackendIds).toEqual(["vllm-gpu1"]);
    });

    it("路由决策台账完整记录策略与缓存字段", async () => {
        const { router, gateway } = makeGateway(
            DUAL_GPU,
            "round-robin",
            async () =>
                new Response(JSON.stringify({
                    choices: [],
                    usage: {
                        prompt_tokens: 100,
                        prompt_tokens_details: { cached_tokens: 64 },
                    },
                }), { status: 200, headers: { "content-type": "application/json" } }),
        );
        await gateway.handleChatCompletions(chatRequest());
        const d = router.recentDecisions(1)[0]!;
        expect(d.strategy).toBe("round-robin");
        expect(d.promptTokens).toBe(100);
        expect(d.cachedTokens).toBe(64);
    });

    it("高并发模拟：30 个并发请求在双卡间均衡分发且活跃槽位正确释放", async () => {
        const perBackend = { "vllm-gpu0": 0, "vllm-gpu1": 0 };
        const { router, gateway } = makeGateway(
            DUAL_GPU,
            "least-active",
            async (url) => {
                const id = url.includes("8000") ? "vllm-gpu0" : "vllm-gpu1";
                perBackend[id as keyof typeof perBackend] += 1;
                await new Promise((resolve) => setTimeout(resolve, 5));
                return okResponse(id);
            },
        );

        const results = await Promise.all(
            Array.from({ length: 30 }, () =>
                gateway.handleChatCompletions(chatRequest())),
        );
        expect(results.every((r) => r.status === 200)).toBe(true);
        // least-active 应把 30 个请求近似均分到两张卡上（各 15）。
        expect(perBackend["vllm-gpu0"]).toBe(15);
        expect(perBackend["vllm-gpu1"]).toBe(15);
        // 全部完成后活跃槽位必须归零，不允许泄漏。
        expect(
            Object.values(router.backendStates()).map((s) => s.activeRequests),
        ).toEqual([0, 0]);
    });
});

describe("支柱 2：后端健康探测", () => {
    function fetchByHealth(
        sick: string[],
    ): (url: string) => Promise<Response> {
        return async (url) => {
            if (sick.some((p) => url.startsWith(p))) {
                throw new Error("ECONNREFUSED");
            }
            return new Response("ok", { status: 200 });
        };
    }

    it("探测失败的后端从路由候选中剔除，恢复后重新纳入", async () => {
        const router = new ModelRouter(DUAL_GPU, { loadBalancing: "round-robin" });
        const monitor = new BackendHealthMonitor(router, DUAL_GPU, {
            fetchImpl: fetchByHealth(["http://127.0.0.1:8001"]) as typeof fetch,
        });

        const results = await monitor.probeAll();
        expect(results.map((r) => r.healthy)).toEqual([true, false]);
        expect(
            router.candidatesFor("qwen").map((b) => b.id),
        ).toEqual(["vllm-gpu0"]);
        expect(router.backendStates()["vllm-gpu1"]!.healthy).toBe(false);
        expect(monitor.recentProbes(1)[0]!.backendId).toBeDefined();
    });

    it("全部后端不健康时降级放行（可用性优先），避免全站 503", async () => {
        const router = new ModelRouter(DUAL_GPU, { loadBalancing: "round-robin" });
        const monitor = new BackendHealthMonitor(router, DUAL_GPU, {
            fetchImpl: fetchByHealth([
                "http://127.0.0.1:8000",
                "http://127.0.0.1:8001",
            ]) as typeof fetch,
        });
        await monitor.probeAll();
        // 降级：探测失败不拦截路由，交给熔断/回退兜底。
        expect(router.candidatesFor("qwen")).toHaveLength(2);
    });

    it("start 周期探测，stop 后停止", async () => {
        const router = new ModelRouter(DUAL_GPU, { loadBalancing: "round-robin" });
        let probeCount = 0;
        const monitor = new BackendHealthMonitor(router, DUAL_GPU, {
            probeIntervalMs: 10,
            probeTimeoutMs: 200,
            fetchImpl: (async () => {
                probeCount += 1;
                return new Response("ok", { status: 200 });
            }) as unknown as typeof fetch,
        });
        monitor.start();
        await new Promise((resolve) => setTimeout(resolve, 80));
        monitor.stop();
        const afterStop = probeCount;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(afterStop).toBeGreaterThanOrEqual(2);
        expect(probeCount).toBe(afterStop);
    });
});

/**
 * N26 回归：全后端不可用时，503 必须说清"为什么"。
 *
 * 原先只给一句"暂无可用后端（未配置或全部熔断）"，而两种原因完全不同：
 * ① 该逻辑模型根本没配后端；② 配了但全部在熔断冷却中。真机上
 * "流式断流 + 重试耗尽 → 熔断"正是第 ② 种，却会被误读成"没有配置后端"。
 */
describe("N26：无可用后端时必须给出可诊断原因", () => {
    it("全部后端熔断冷却中 → 消息点明熔断、冷却剩余与连续失败次数", async () => {
        const { router, gateway } = makeGateway(
            DUAL_GPU,
            "round-robin",
            async () => okResponse("never-called"),
        );

        // 触发熔断（阈值内多次失败即可打开）。
        for (let i = 0; i < 20; i += 1) {
            router.recordFailure("vllm-gpu0");
            router.recordFailure("vllm-gpu1");
        }
        expect(router.candidatesFor("qwen")).toHaveLength(0);

        const res = await gateway.handleChatCompletions(chatRequest());
        expect(res.status).toBe(503);
        const body = await res.json() as { error: { message: string } };

        // 必须能区分"熔断"与"没配"，并带上可行动信息。
        expect(body.error.message).toContain("熔断");
        expect(body.error.message).toContain("冷却剩余");
        expect(body.error.message).toContain("连续失败");
        expect(body.error.message).toContain("vllm-gpu0");
        expect(body.error.message).toContain("vllm-gpu1");
        // 不能再说成"未配置"。
        expect(body.error.message).not.toContain("未配置或全部熔断");
    });

    it("逻辑模型没有配置后端 → 404 且与熔断（503）区分开", async () => {
        const { gateway } = makeGateway(
            DUAL_GPU,
            "round-robin",
            async () => okResponse("never-called"),
        );

        const res = await gateway.handleChatCompletions(new Request(
            "http://gw/v1/chat/completions",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model: "从未配置过的模型",
                    messages: [{ role: "user", content: "hi" }],
                }),
            },
        ));
        expect(res.status).toBe(404);
        const body = await res.json() as { error: { message: string; type: string } };
        expect(body.error.type).toBe("model_not_found");
        expect(body.error.message).toContain("未配置该逻辑模型");
        expect(body.error.message).not.toContain("冷却剩余");
    });

    it("describeModelBackends 暴露全部后端及其熔断状态", () => {
        const router = new ModelRouter(DUAL_GPU, { loadBalancing: "round-robin" });
        expect(router.describeModelBackends("qwen").map((b) => b.id))
            .toEqual(["vllm-gpu0", "vllm-gpu1"]);

        for (let i = 0; i < 20; i += 1) router.recordFailure("vllm-gpu0");
        const described = router.describeModelBackends("qwen");
        const gpu0 = described.find((b) => b.id === "vllm-gpu0")!;
        const gpu1 = described.find((b) => b.id === "vllm-gpu1")!;
        expect(gpu0.circuitOpen).toBe(true);
        expect(gpu0.cooldownRemainingMs).toBeGreaterThan(0);
        expect(gpu0.consecutiveFailures).toBe(20);
        expect(gpu1.circuitOpen).toBe(false);
    });
});
