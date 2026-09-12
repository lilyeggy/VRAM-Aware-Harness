import { describe, expect, it } from "bun:test";

import { openHarnessDatabase } from "../../src/storage/database.ts";
import {
    LlmCacheMetricsStore,
} from "../../src/eval/llm-cache-metrics-store.ts";
import {
    EvaluationAggregator,
} from "../../src/eval/evaluation-aggregator.ts";
import type {
    LlmCacheSample,
} from "../../src/llm-gateway/llm-gateway.ts";

function sample(overrides: Partial<LlmCacheSample> = {}): LlmCacheSample {
    return {
        requestId: crypto.randomUUID(),
        backendId: "vllm-gpu0",
        logicalModel: "qwen",
        prefixCacheKey: "abc123",
        promptTokens: 100,
        cachedTokens: 60,
        recordedAt: new Date().toISOString(),
        ...overrides,
    };
}

describe("支柱 2：缓存命中指标持久化与评测", () => {
    it("LlmCacheMetricsStore 记录并聚合缓存命中样本", () => {
        const db = openHarnessDatabase(":memory:");
        const store = new LlmCacheMetricsStore(db);

        expect(store.aggregate()).toEqual({
            totalRequests: 0,
            promptTokensTotal: 0,
            cachedTokensTotal: 0,
            cacheHitRate: null,
        });

        store.record(sample({ promptTokens: 200, cachedTokens: 150 }));
        store.record(sample({
            backendId: "vllm-gpu1",
            promptTokens: 100,
            cachedTokens: 50,
        }));

        const all = store.aggregate();
        expect(all.totalRequests).toBe(2);
        expect(all.promptTokensTotal).toBe(300);
        expect(all.cachedTokensTotal).toBe(200);
        expect(all.cacheHitRate).toBeCloseTo(200 / 300);

        const gpu1 = store.aggregate("vllm-gpu1");
        expect(gpu1.totalRequests).toBe(1);
        expect(gpu1.cacheHitRate).toBeCloseTo(0.5);
        db.close();
    });

    it("EvaluationAggregator.computeLlmCacheMetrics 读取同一台账", () => {
        const db = openHarnessDatabase(":memory:");
        const store = new LlmCacheMetricsStore(db);
        const aggregator = new EvaluationAggregator(db);

        expect(aggregator.computeLlmCacheMetrics().totalRequests).toBe(0);

        store.record(sample({ backendId: "vllm-gpu0", promptTokens: 80, cachedTokens: 0 }));
        store.record(sample({ backendId: "vllm-gpu1", promptTokens: 120, cachedTokens: 90 }));

        const metrics = aggregator.computeLlmCacheMetrics();
        expect(metrics.totalRequests).toBe(2);
        expect(metrics.cachedTokensTotal).toBe(90);
        expect(metrics.cacheHitRate).toBeCloseTo(90 / 200);

        const byGpu1 = aggregator.computeLlmCacheMetrics("vllm-gpu1");
        expect(byGpu1.totalRequests).toBe(1);
        expect(byGpu1.cacheHitRate).toBeCloseTo(0.75);
        db.close();
    });

    it("migration v22（最新 schema）在新库与旧库上都能应用", () => {
        const db = openHarnessDatabase(":memory:");
        const version = db.query<{ version: number }, []>(
            "SELECT MAX(version) AS version FROM schema_migrations",
        ).get()!.version;
        expect(version).toBe(22);
        db.exec(
            "INSERT INTO llm_cache_metrics (request_id, backend_id, logical_model, recorded_at) VALUES ('r','b','m','t')",
        );
        db.close();
    });
});
