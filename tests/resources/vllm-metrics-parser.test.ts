import { expect, test } from "bun:test";

import {
    parseVllmMetrics,
} from "../../src/resources/vllm-resource-observer.ts";

test("解析 vLLM 指标并按标签序列聚合", () => {
    const metrics = `
        # HELP vllm:num_requests_running running requests
        # TYPE vllm:num_requests_running gauge
        vllm:num_requests_running{model_name="model-a"} 2
        vllm:num_requests_running{model_name="model-b"} 1
        vllm:num_requests_waiting{model_name="model-a"} 3
        vllm:kv_cache_usage_perc{model_name="model-a"} 0.42
        vllm:kv_cache_usage_perc{model_name="model-b"} 0.75
        vllm:prompt_tokens_total{model_name="model-a"} 1200
        vllm:prompt_tokens_total{model_name="model-b"} 300
        vllm:generation_tokens_total{model_name="model-a"} 400
        vllm:generation_tokens_total{model_name="model-b"} 100
    `;

    expect(parseVllmMetrics(metrics)).toEqual({
        runningRequests: 3,
        waitingRequests: 3,
        kvCacheUsagePercent: 75,
        promptTokensTotal: 1_500,
        generationTokensTotal: 500,
    });
});

test("支持无标签 sample、可选时间戳和部分指标缺失", () => {
    const metrics = `
        unrelated_metric 999
        vllm:num_requests_running 4 1785664800000
        vllm:kv_cache_usage_perc 0.25
        malformed line
    `;

    expect(parseVllmMetrics(metrics)).toEqual({
        runningRequests: 4,
        waitingRequests: null,
        kvCacheUsagePercent: 25,
        promptTokensTotal: null,
        generationTokensTotal: null,
    });
});

test("完全没有目标指标时拒绝把任意文本当成 vLLM Metrics", () => {
    expect(() => {
        parseVllmMetrics(`
            # TYPE process_cpu_seconds_total counter
            process_cpu_seconds_total 12
        `);
    }).toThrow("metrics 中没有可识别的 vLLM 指标");
});

test("拒绝越界 KV 比例和非法请求数量", () => {
    expect(() => {
        parseVllmMetrics(
            "vllm:kv_cache_usage_perc 1.2",
        );
    }).toThrow(
        "vllm:kv_cache_usage_perc 必须位于 0 到 1",
    );

    expect(() => {
        parseVllmMetrics(
            "vllm:num_requests_waiting -1",
        );
    }).toThrow(
        "vllm:num_requests_waiting 必须是非负整数",
    );
});
