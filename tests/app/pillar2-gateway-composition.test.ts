import { expect, test } from "bun:test";

import {
    createHarnessApplication,
} from "../../src/app/create-harness-application.ts";
import {
    loadHarnessConfig,
} from "../../src/app/harness-config.ts";
import type {
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import {
    FakeResourceObserver,
} from "../fakes/fake-resource-observer.ts";

const normalSnapshot: ResourceSnapshot = {
    snapshotId: "pillar2-snapshot",
    observedAt: "2026-09-08T14:00:00.000Z",
    sources: ["FAKE"],
    gpuTotalMemoryMiB: 100,
    gpuUsedMemoryMiB: 20,
    gpuFreeMemoryMiB: 80,
    gpuUtilizationPercent: 20,
    runningRequests: 0,
    waitingRequests: 0,
    kvCacheUsagePercent: 20,
    inputTokensPerSecond: 1_000,
    outputTokensPerSecond: 100,
};

const DUAL_BACKENDS = [
    { id: "vllm-gpu0", baseUrl: "http://gpu0/v1", model: "fake-model", logicalModel: "fake-model" },
    { id: "vllm-gpu1", baseUrl: "http://gpu1/v1", model: "fake-model", logicalModel: "fake-model" },
];

test("支柱 2：组合根装配双卡网关、健康探测与缓存台账并放开发并发", async () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "fake-model",
        HARNESS_DATABASE_PATH: ":memory:",
        HARNESS_PUMP_INTERVAL_MS: "60000",
        LLM_BACKENDS: JSON.stringify(DUAL_BACKENDS),
        LLM_GATEWAY_STRATEGY: "round-robin",
        LLM_HEALTH_PROBE_INTERVAL_MS: "10",
    }, "/tmp/harness-project");

    const upstreamHits: string[] = [];
    // 假双卡：两个端口都可用；chat 返回带 cached_tokens 的 usage。
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
        input: Parameters<typeof originalFetch>[0],
    ) => {
        const url = String(input);
        if (url.endsWith("/health")) {
            return new Response("ok", { status: 200 });
        }
        if (url.endsWith("/chat/completions")) {
            upstreamHits.push(url.includes("gpu0") ? "gpu0" : "gpu1");
            return new Response(JSON.stringify({
                choices: [],
                usage: {
                    prompt_tokens: 100,
                    prompt_tokens_details: { cached_tokens: 80 },
                },
            }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return originalFetch(input);
    }) as typeof fetch;

    const composition = await createHarnessApplication(config, {
        runtime: new FakeAgentRuntime(),
        resourceObserver: new FakeResourceObserver({ ok: true, snapshot: normalSnapshot }),
    });

    try {
        expect(composition.llmGateway).toBeDefined();
        expect(composition.llmHealthMonitor).toBeDefined();
        expect(composition.llmCacheMetricsStore).toBeDefined();

        // 并发放开：默认 30 全局 / 10 每租户。
        expect(config.maxActiveRuns).toBe(30);
        expect(config.maxActiveRunsPerTenant).toBe(10);

        // 双卡轮询 + 稳定前缀 + 健康探测回填。
        const chatRequest = (): Request => new Request(
            "http://harness/v1/chat/completions",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model: "fake-model",
                    messages: [
                        { role: "system", content: "S" },
                        { role: "user", content: "u1" },
                    ],
                }),
            },
        );
        const res1 = await composition.llmGateway!.handleChatCompletions(chatRequest());
        const res2 = await composition.llmGateway!.handleChatCompletions(chatRequest());
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(upstreamHits).toEqual(["gpu0", "gpu1"]);

        // 健康探测：启动即探测一轮，两卡都健康。
        await new Promise((resolve) => setTimeout(resolve, 30));
        const states = composition.llmGateway!.router.backendStates();
        expect(states["vllm-gpu0"]!.healthy).toBe(true);
        expect(states["vllm-gpu1"]!.healthy).toBe(true);

        // 缓存命中指标持久化到 SQLite，并可从评测聚合器读取。
        const metrics = composition.llmCacheMetricsStore!.aggregate();
        expect(metrics.totalRequests).toBe(2);
        expect(metrics.cachedTokensTotal).toBe(160);
        const evalMetrics = new (await import(
            "../../src/eval/evaluation-aggregator.ts"
        )).EvaluationAggregator(composition.database);
        expect(evalMetrics.computeLlmCacheMetrics().totalRequests).toBe(2);
        expect(evalMetrics.computeLlmCacheMetrics().cacheHitRate)
            .toBeCloseTo(160 / 200);
    } finally {
        await composition.close();
        globalThis.fetch = originalFetch;
    }
});
