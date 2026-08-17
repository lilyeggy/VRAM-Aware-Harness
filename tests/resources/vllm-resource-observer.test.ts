import { expect, test } from "bun:test";

import {
    VllmResourceObserver,
} from "../../src/resources/vllm-resource-observer.ts";
import type {
    MetricsFetcher,
    NvidiaSmiRunner,
} from "../../src/resources/vllm-resource-observer.ts";

function metricsText(
    promptTokensTotal:number,
    generationTokensTotal:number,
):string {
    return `
        vllm:num_requests_running{model_name="model-a"} 2
        vllm:num_requests_waiting{model_name="model-a"} 1
        vllm:kv_cache_usage_perc{model_name="model-a"} 0.65
        vllm:prompt_tokens_total{model_name="model-a"} ${promptTokensTotal}
        vllm:generation_tokens_total{model_name="model-a"} ${generationTokensTotal}
    `;
}

function successfulNvidiaRunner(
    onArgs?:(args:readonly string[]) => void,
):NvidiaSmiRunner {
    return async (args) => {
        onArgs?.(args);

        return {
            exitCode:0,
            stdout:[
                "49140, 12000, 37140, 35",
                "49140, 18000, 31140, 70",
            ].join("\n"),
            stderr:"",
        };
    };
}

test("合并 vLLM Metrics 和多个 NVIDIA GPU 的资源事实", async () => {
    let nvidiaArgs:readonly string[] = [];
    const fetcher:MetricsFetcher = async () => new Response(
        metricsText(1_200, 300),
        { status:200 },
    );
    const observer = new VllmResourceObserver(
        {
            metricsUrl:"http://127.0.0.1:8000/metrics",
            timeoutMs:1_000,
            gpuIds:["0", "1"],
        },
        {
            fetcher,
            runNvidiaSmi:successfulNvidiaRunner((args) => {
                nvidiaArgs = args;
            }),
            now:() => new Date("2026-08-02T10:00:00.000Z"),
            createSnapshotId:() => "snapshot-real-1",
        },
    );

    const observation = await observer.observe();

    expect(observation).toEqual({
        ok:true,
        snapshot:{
            snapshotId:"snapshot-real-1",
            observedAt:"2026-08-02T10:00:00.000Z",
            sources:["VLLM_METRICS", "NVIDIA_SMI"],
            gpuTotalMemoryMiB:98_280,
            gpuUsedMemoryMiB:30_000,
            gpuFreeMemoryMiB:68_280,
            gpuUtilizationPercent:70,
            runningRequests:2,
            waitingRequests:1,
            kvCacheUsagePercent:65,
            inputTokensPerSecond:null,
            outputTokensPerSecond:null,
        },
    });
    expect(nvidiaArgs).toContain("--id=0,1");
});

test("第二次观测通过 Counter 差值计算 input/output tokens 每秒", async () => {
    let nowMs = Date.parse("2026-08-02T10:00:00.000Z");
    let promptTokensTotal = 1_000;
    let generationTokensTotal = 500;
    let snapshotSequence = 0;
    const observer = new VllmResourceObserver(
        {
            metricsUrl:"http://vllm/metrics",
            timeoutMs:1_000,
            gpuIds:["0"],
        },
        {
            fetcher:async () => new Response(metricsText(
                promptTokensTotal,
                generationTokensTotal,
            )),
            runNvidiaSmi:successfulNvidiaRunner(),
            now:() => new Date(nowMs),
            createSnapshotId:() => {
                snapshotSequence += 1;
                return `snapshot-${snapshotSequence}`;
            },
        },
    );

    const first = await observer.observe();

    nowMs += 2_000;
    promptTokensTotal += 200;
    generationTokensTotal += 100;

    const second = await observer.observe();

    expect(first.ok && first.snapshot.inputTokensPerSecond).toBeNull();
    expect(first.ok && first.snapshot.outputTokensPerSecond).toBeNull();
    expect(second.ok && second.snapshot.inputTokensPerSecond).toBe(100);
    expect(second.ok && second.snapshot.outputTokensPerSecond).toBe(50);
});

test("vLLM 不可用时保留 NVIDIA 部分 Snapshot", async () => {
    const observer = new VllmResourceObserver(
        {
            metricsUrl:"http://vllm/metrics",
            timeoutMs:1_000,
            gpuIds:["0"],
        },
        {
            fetcher:async () => new Response("unavailable", {
                status:503,
            }),
            runNvidiaSmi:successfulNvidiaRunner(),
            createSnapshotId:() => "snapshot-nvidia-only",
        },
    );

    const observation = await observer.observe();

    expect(observation.ok).toBe(true);
    if (!observation.ok) {
        throw new Error("预期 NVIDIA 降级成功");
    }
    expect(observation.snapshot.sources).toEqual(["NVIDIA_SMI"]);
    expect(observation.snapshot.gpuTotalMemoryMiB).toBe(98_280);
    expect(observation.snapshot.runningRequests).toBeNull();
    expect(observation.snapshot.kvCacheUsagePercent).toBeNull();
});

test("nvidia-smi 不可用时保留 vLLM 部分 Snapshot", async () => {
    const observer = new VllmResourceObserver(
        {
            metricsUrl:"http://vllm/metrics",
            timeoutMs:1_000,
            gpuIds:["0"],
        },
        {
            fetcher:async () => new Response(metricsText(100, 50)),
            runNvidiaSmi:async () => ({
                exitCode:1,
                stdout:"",
                stderr:"NVIDIA driver unavailable",
            }),
            createSnapshotId:() => "snapshot-vllm-only",
        },
    );

    const observation = await observer.observe();

    expect(observation.ok).toBe(true);
    if (!observation.ok) {
        throw new Error("预期 vLLM 降级成功");
    }
    expect(observation.snapshot.sources).toEqual(["VLLM_METRICS"]);
    expect(observation.snapshot.runningRequests).toBe(2);
    expect(observation.snapshot.gpuTotalMemoryMiB).toBeNull();
});

test("两个来源都失败时返回稳定的 Observation Failure", async () => {
    const timeoutError = new Error("metrics timed out");
    timeoutError.name = "TimeoutError";
    const observer = new VllmResourceObserver(
        {
            metricsUrl:"http://vllm/metrics",
            timeoutMs:1_000,
            gpuIds:["0"],
        },
        {
            fetcher:async () => {
                throw timeoutError;
            },
            runNvidiaSmi:async () => ({
                exitCode:1,
                stdout:"",
                stderr:"nvidia-smi unavailable",
            }),
            now:() => new Date("2026-08-02T10:10:00.000Z"),
        },
    );

    const observation = await observer.observe();

    expect(observation.ok).toBe(false);
    if (observation.ok) {
        throw new Error("预期两个来源都失败");
    }
    expect(observation.reason).toBe("TIMEOUT");
    expect(observation.attemptedSources).toEqual([
        "VLLM_METRICS",
        "NVIDIA_SMI",
    ]);
    expect(observation.message).toContain("metrics timed out");
    expect(observation.message).toContain("nvidia-smi unavailable");
});

test("两个来源都返回非法内容时标记 INVALID_RESPONSE", async () => {
    const observer = new VllmResourceObserver(
        {
            metricsUrl:"http://vllm/metrics",
            timeoutMs:1_000,
            gpuIds:["0"],
        },
        {
            fetcher:async () => new Response("not vllm metrics"),
            runNvidiaSmi:async () => ({
                exitCode:0,
                stdout:"N/A, N/A",
                stderr:"",
            }),
        },
    );

    const observation = await observer.observe();

    expect(observation.ok).toBe(false);
    if (observation.ok) {
        throw new Error("预期非法响应失败");
    }
    expect(observation.reason).toBe("INVALID_RESPONSE");
});
