import { expect, test } from "bun:test";

import {
    loadHarnessConfig,
} from "../../src/app/harness-config.ts";

test("loadHarnessConfig 提供本地安全默认值并派生 metrics URL", () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"qwen3.5-4b",
    }, "/tmp/harness-project");

    expect(config).toMatchObject({
        databasePath:"/tmp/harness-project/data/harness.sqlite",
        httpHost:"127.0.0.1",
        httpPort:3000,
        piProvider:"local-vllm",
        piModelId:"qwen3.5-4b",
        piModelsPath:"/tmp/harness-project/.pi/spike/models.json",
        vllmMetricsUrl:"http://127.0.0.1:8000/metrics",
        gpuIds:["0"],
        maxActiveRuns:2,
        maxActiveRunsPerTenant:1,
        pumpIntervalMs:1_000,
        containerUserId:65532,
    });
    expect(config.piTools).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
    ]);
});

test("loadHarnessConfig 解析显式环境变量", () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"qwen3.5-9b",
        VLLM_BASE_URL:"http://vllm.internal:9000/v1/",
        HARNESS_DATABASE_PATH:":memory:",
        HARNESS_HOST:"0.0.0.0",
        HARNESS_PORT:"8080",
        HARNESS_MAX_ACTIVE_RUNS:"4",
        HARNESS_MAX_ACTIVE_RUNS_PER_TENANT:"2",
        HARNESS_PUMP_INTERVAL_MS:"250",
        HARNESS_GPU_IDS:"0, 1",
        PI_TOOLS:"read,grep",
        PI_MODELS_PATH:"config/models.json",
    }, "/tmp/harness-project");

    expect(config).toMatchObject({
        databasePath:":memory:",
        httpHost:"0.0.0.0",
        httpPort:8080,
        maxActiveRuns:4,
        maxActiveRunsPerTenant:2,
        pumpIntervalMs:250,
        gpuIds:["0", "1"],
        piTools:["read", "grep"],
        piModelsPath:"/tmp/harness-project/config/models.json",
        vllmMetricsUrl:"http://vllm.internal:9000/metrics",
    });
});

test("loadHarnessConfig 拒绝缺失模型和非法并发配置", () => {
    expect(() => loadHarnessConfig({})).toThrow(
        "必须设置环境变量 VLLM_MODEL_ID",
    );
    expect(() => loadHarnessConfig({
        VLLM_MODEL_ID:"model",
        HARNESS_MAX_ACTIVE_RUNS:"1",
        HARNESS_MAX_ACTIVE_RUNS_PER_TENANT:"2",
    })).toThrow(
        "HARNESS_MAX_ACTIVE_RUNS_PER_TENANT 不能大于 HARNESS_MAX_ACTIVE_RUNS",
    );
    expect(() => loadHarnessConfig({
        VLLM_MODEL_ID:"model",
        HARNESS_PORT:"70000",
    })).toThrow("HARNESS_PORT 必须小于或等于 65535");
    expect(() => loadHarnessConfig({
        VLLM_MODEL_ID:"model",
        HARNESS_CONTAINER_USER_ID:"0",
    })).toThrow("HARNESS_CONTAINER_USER_ID 必须是正整数");
});
