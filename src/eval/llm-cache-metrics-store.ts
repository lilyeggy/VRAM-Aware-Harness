/**
 * 支柱 2：LLM 缓存命中指标的持久化台账。
 *
 * LlmGateway 每次非流式转发都会产出一份缓存命中样本
 * （prompt_tokens / prompt_tokens_details.cached_tokens / 前缀指纹），
 * 本 store 把样本写入 llm_cache_metrics 表， EvaluationAggregator 据此
 * 计算系统级前缀缓存命中率 —— 让「Prefix Caching 优化有没有生效」成为
 * 可回放的事实，而不是口头结论。
 */

import type { Database } from "bun:sqlite";

import type { LlmCacheSample } from "../llm-gateway/llm-gateway.ts";

export interface LlmCacheMetricsAggregate {
    totalRequests: number;
    promptTokensTotal: number;
    cachedTokensTotal: number;
    /** cached_tokens / prompt_tokens；无样本时为 null。 */
    cacheHitRate: number | null;
}

interface AggregateRow {
    n: number;
    prompt_tokens: number;
    cached_tokens: number;
}

export class LlmCacheMetricsStore {
    constructor(private readonly db: Database) {}

    record(sample: LlmCacheSample): void {
        this.db.query(
            `INSERT INTO llm_cache_metrics
             (request_id, backend_id, logical_model, prefix_cache_key,
              prompt_tokens, cached_tokens, recorded_at)
             VALUES ($requestId, $backendId, $logicalModel, $prefixCacheKey,
                     $promptTokens, $cachedTokens, $recordedAt)`,
        ).run({
            requestId: sample.requestId,
            backendId: sample.backendId,
            logicalModel: sample.logicalModel,
            prefixCacheKey: sample.prefixCacheKey,
            promptTokens: sample.promptTokens,
            cachedTokens: sample.cachedTokens,
            recordedAt: sample.recordedAt,
        });
    }

    /** 聚合全部缓存命中样本（可按后端过滤）。 */
    aggregate(backendId?: string): LlmCacheMetricsAggregate {
        const row = backendId === undefined
            ? this.db
                .query<AggregateRow, []>(
                    `SELECT COUNT(*) AS n,
                            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                            COALESCE(SUM(cached_tokens), 0) AS cached_tokens
                     FROM llm_cache_metrics`,
                )
                .get()
            : this.db
                .query<AggregateRow, { backendId: string }>(
                    `SELECT COUNT(*) AS n,
                            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                            COALESCE(SUM(cached_tokens), 0) AS cached_tokens
                     FROM llm_cache_metrics
                     WHERE backend_id = $backendId`,
                )
                .get({ backendId });

        const totalRequests = row?.n ?? 0;
        const promptTokensTotal = row?.prompt_tokens ?? 0;
        const cachedTokensTotal = row?.cached_tokens ?? 0;
        return {
            totalRequests,
            promptTokensTotal,
            cachedTokensTotal,
            cacheHitRate:
                totalRequests === 0 || promptTokensTotal === 0
                    ? null
                    : cachedTokensTotal / promptTokensTotal,
        };
    }
}
