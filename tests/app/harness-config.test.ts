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
        maxActiveRuns:30,
        maxActiveRunsPerTenant:10,
        llmGatewayStrategy:"round-robin",
        llmHealthProbeIntervalMs:10_000,
        llmPrefixCacheEnabled:true,
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

test("Container default profile 默认选择 runsc，并拒绝 runc 降级", () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"model",
        HARNESS_SANDBOX_PROVIDER:"container",
    });
    expect(config.sandboxProfile).toBe("default");
    expect(config.sandboxRuntime).toBe("runsc");
    expect(() => loadHarnessConfig({
        VLLM_MODEL_ID:"model",
        HARNESS_SANDBOX_PROVIDER:"container",
        HARNESS_SANDBOX_RUNTIME:"runc",
    })).toThrow("禁止回退到 runc");
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
    expect(() => loadHarnessConfig({
        VLLM_MODEL_ID:"model",
        LLM_GATEWAY_STRATEGY:"random",
    })).toThrow("LLM_GATEWAY_STRATEGY 只支持");
});

test("支柱 2：VLLM_BASE_URLS 展开为双卡后端，LLM_BACKENDS 显式配置优先", () => {
    const dualCard = loadHarnessConfig({
        VLLM_MODEL_ID:"qwen3.5-4b",
        VLLM_BASE_URLS:"http://127.0.0.1:8000/v1, http://127.0.0.1:8001/v1",
    }, "/tmp/harness-project");

    expect(dualCard.llmBackends).toEqual([
        {
            id:"vllm-gpu0",
            baseUrl:"http://127.0.0.1:8000/v1",
            model:"qwen3.5-4b",
            logicalModel:"qwen3.5-4b",
        },
        {
            id:"vllm-gpu1",
            baseUrl:"http://127.0.0.1:8001/v1",
            model:"qwen3.5-4b",
            logicalModel:"qwen3.5-4b",
        },
    ]);

    const explicit = loadHarnessConfig({
        VLLM_MODEL_ID:"qwen3.5-4b",
        VLLM_BASE_URLS:"http://127.0.0.1:8000/v1",
        LLM_BACKENDS:JSON.stringify([{
            id:"cloud",
            baseUrl:"http://cloud/v1",
            model:"m",
            logicalModel:"qwen3.5-4b",
        }]),
    }, "/tmp/harness-project");
    expect(explicit.llmBackends).toHaveLength(1);
    expect(explicit.llmBackends[0]!.id).toBe("cloud");

    const disabled = loadHarnessConfig(
        { VLLM_MODEL_ID:"qwen3.5-4b" },
        "/tmp/harness-project",
    );
    expect(disabled.llmBackends).toEqual([]);
});

test("N28：Pi 压缩参数默认值按 32768 窗口标定，且可被环境变量覆盖", () => {
    const defaults = loadHarnessConfig({
        VLLM_MODEL_ID:"qwen3.5-4b",
    }, "/tmp/harness-project");

    // 触发点 = 模型窗口 - reserveTokens，必须 > keepRecentTokens，
    // 否则切点退到会话开头、compress 退化成空操作（真机 142 连败的根因）。
    expect(defaults.piCompactionEnabled).toBe(true);
    expect(defaults.piCompactionReserveTokens).toBe(12_288);
    expect(defaults.piCompactionKeepRecentTokens).toBe(8_192);
    expect(defaults.piCompactionReserveTokens)
        .toBeGreaterThan(defaults.piCompactionKeepRecentTokens);

    const explicit = loadHarnessConfig({
        VLLM_MODEL_ID:"qwen3.5-4b",
        PI_COMPACTION_RESERVE_TOKENS:"6000",
        PI_COMPACTION_KEEP_RECENT_TOKENS:"3000",
    }, "/tmp/harness-project");
    expect(explicit.piCompactionReserveTokens).toBe(6_000);
    expect(explicit.piCompactionKeepRecentTokens).toBe(3_000);

    for (const off of ["false", "0"]) {
        const disabled = loadHarnessConfig({
            VLLM_MODEL_ID:"qwen3.5-4b",
            PI_COMPACTION_ENABLED:off,
        }, "/tmp/harness-project");
        expect(disabled.piCompactionEnabled).toBe(false);
    }
});

test("loadHarnessConfig 为 N5/N10/N14 注入适配本项目的默认值", () => {
    const config = loadHarnessConfig({ VLLM_MODEL_ID: "qwen" }, "/tmp/harness-project");

    // N5：同机 vLLM 默认预占 90% 显存，准入按基线之上的增量判定。
    expect(config.resourceThresholds.gpuMemoryBaselinePercent).toBe(90);
    // N10：排队超过 60s 的 Run 插队优先调度。
    expect(config.schedulerAgingMs).toBe(60_000);
    // N14：容器 PID 上限（可下调到 gVisor 内部上限之下）。
    expect(config.containerPidsLimit).toBe(128);
});

test("loadHarnessConfig 允许覆盖 N5/N10/N14 三个新开关", () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "qwen",
        HARNESS_GPU_MEMORY_BASELINE_PERCENT: "0",
        HARNESS_SCHEDULER_AGING_MS: "0",
        HARNESS_CONTAINER_PIDS_LIMIT: "64",
    }, "/tmp/harness-project");

    expect(config.resourceThresholds.gpuMemoryBaselinePercent).toBe(0);
    expect(config.schedulerAgingMs).toBe(0);
    expect(config.containerPidsLimit).toBe(64);
});
