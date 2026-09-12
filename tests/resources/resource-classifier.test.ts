import { expect, test } from "bun:test";

import {
    classifyResource,
} from "../../src/resources/resource-classifier.ts";
import type {
    ResourceThresholds,
} from "../../src/resources/resource-classifier.ts";
import type {
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";

const thresholds: ResourceThresholds = {
    busyGpuMemoryPercent: 70,
    criticalGpuMemoryPercent: 90,
    busyKvCachePercent: 60,
    criticalKvCachePercent: 85,
    busyRunningRequests: 4,
    criticalRunningRequests: 8,
    busyWaitingRequests: 1,
    criticalWaitingRequests: 4,
};

function createSnapshot(
    overrides: Partial<ResourceSnapshot> = {},
): ResourceSnapshot {
    return {
        snapshotId: "snapshot-1",
        observedAt: "2026-08-01T10:00:00.000Z",
        sources: ["FAKE"],
        gpuTotalMemoryMiB: 100,
        gpuUsedMemoryMiB: 20,
        gpuFreeMemoryMiB: 80,
        gpuUtilizationPercent: 25,
        runningRequests: 1,
        waitingRequests: 0,
        kvCacheUsagePercent: 20,
        inputTokensPerSecond: 1_000,
        outputTokensPerSecond: 100,
        ...overrides,
    };
}

test("所有可用指标都低于 busy 阈值时分类为 NORMAL", () => {
    const result = classifyResource(createSnapshot(), thresholds);

    expect(result).toEqual({
        snapshotId: "snapshot-1",
        pressure: "NORMAL",
        reasons: ["WITHIN_THRESHOLDS"],
        gpuMemoryUsagePercent: 20, gpuMemoryPressurePercent: 20,
    });
});

test("指标恰好达到 busy 阈值时收集全部 busy 原因", () => {
    const result = classifyResource(createSnapshot({
        gpuUsedMemoryMiB: 70,
        gpuFreeMemoryMiB: 30,
        kvCacheUsagePercent: 60,
        runningRequests: 4,
        waitingRequests: 1,
    }), thresholds);

    expect(result.pressure).toBe("BUSY");
    expect(result.reasons).toEqual([
        "GPU_MEMORY_BUSY",
        "KV_CACHE_BUSY",
        "RUNNING_REQUESTS_BUSY",
        "WAITING_REQUESTS_BUSY",
    ]);
});

test("任一指标达到 critical 时整体分类为 CRITICAL", () => {
    const result = classifyResource(createSnapshot({
        gpuUsedMemoryMiB: 70,
        kvCacheUsagePercent: 85,
        runningRequests: 4,
    }), thresholds);

    expect(result.pressure).toBe("CRITICAL");
    expect(result.reasons).toEqual([
        "GPU_MEMORY_BUSY",
        "KV_CACHE_CRITICAL",
        "RUNNING_REQUESTS_BUSY",
    ]);
});

test("running 和 waiting requests 分别使用自己的 critical 阈值", () => {
    const result = classifyResource(createSnapshot({
        runningRequests: 8,
        waitingRequests: 4,
    }), thresholds);

    expect(result.pressure).toBe("CRITICAL");
    expect(result.reasons).toEqual([
        "RUNNING_REQUESTS_CRITICAL",
        "WAITING_REQUESTS_CRITICAL",
    ]);
});

test("部分指标缺失时仍使用剩余信号分类", () => {
    const result = classifyResource(createSnapshot({
        gpuTotalMemoryMiB: null,
        gpuUsedMemoryMiB: null,
        gpuFreeMemoryMiB: null,
        runningRequests: null,
        waitingRequests: 2,
        kvCacheUsagePercent: null,
    }), thresholds);

    expect(result.pressure).toBe("BUSY");
    expect(result.reasons).toEqual(["WAITING_REQUESTS_BUSY"]);
    expect(result.gpuMemoryUsagePercent).toBeNull();
});

test("所有压力指标都缺失时分类为 UNKNOWN", () => {
    const result = classifyResource(createSnapshot({
        gpuTotalMemoryMiB: null,
        gpuUsedMemoryMiB: null,
        gpuFreeMemoryMiB: null,
        runningRequests: null,
        waitingRequests: null,
        kvCacheUsagePercent: null,
    }), thresholds);

    expect(result.pressure).toBe("UNKNOWN");
    expect(result.reasons).toEqual(["INSUFFICIENT_DATA"]);
    expect(result.gpuMemoryUsagePercent).toBeNull();
});

test("free 显存缺失时仍可通过 used 和 total 计算使用率", () => {
    const result = classifyResource(createSnapshot({
        gpuTotalMemoryMiB: 100,
        gpuUsedMemoryMiB: 90,
        gpuFreeMemoryMiB: null,
    }), thresholds);

    expect(result.gpuMemoryUsagePercent).toBe(90);
    expect(result.pressure).toBe("CRITICAL");
    expect(result.reasons).toContain("GPU_MEMORY_CRITICAL");
});

test("总显存为零时忽略显存信号并继续使用其他指标", () => {
    const result = classifyResource(createSnapshot({
        gpuTotalMemoryMiB: 0,
        gpuUsedMemoryMiB: 0,
        kvCacheUsagePercent: 60,
    }), thresholds);

    expect(result.gpuMemoryUsagePercent).toBeNull();
    expect(result.pressure).toBe("BUSY");
    expect(result.reasons).toEqual(["KV_CACHE_BUSY"]);
});

// ---------------------------------------------------------------------------
// N5：同机推理服务稳态基线。真机上 vLLM 默认预占 90% 显存，若直接拿
// 「已用比例」做准入，平台只看自己的模型服务就长期判 CRITICAL，把任务
// 无差别排队到 TTL 熔断（13 字符的小任务也被排掉）。
// ---------------------------------------------------------------------------

const baselineThresholds: ResourceThresholds = {
    ...thresholds,
    gpuMemoryBaselinePercent: 90,
};

test("N5：基线之内的显存占用不再算压力（vLLM 预占 90% 是预期稳态）", () => {
    const result = classifyResource(
        createSnapshot({ gpuUsedMemoryMiB: 93, gpuFreeMemoryMiB: 7 }),
        baselineThresholds,
    );

    // 观测事实保留原始已用比例，压力按基线之上的增量度量。
    expect(result.gpuMemoryUsagePercent).toBe(93);
    expect(result.gpuMemoryPressurePercent).toBe(30);
    expect(result.pressure).toBe("NORMAL");
});

test("N5：把基线之上的余量吃干净才判 CRITICAL", () => {
    const result = classifyResource(
        createSnapshot({ gpuUsedMemoryMiB: 99, gpuFreeMemoryMiB: 1 }),
        baselineThresholds,
    );

    expect(result.gpuMemoryUsagePercent).toBe(99);
    expect(result.gpuMemoryPressurePercent).toBe(90);
    expect(result.pressure).toBe("CRITICAL");
    expect(result.reasons).toContain("GPU_MEMORY_CRITICAL");
});

test("N5：未配置基线时退化为按原始比例判定（旧行为，无同机推理服务的部署）", () => {
    const result = classifyResource(
        createSnapshot({ gpuUsedMemoryMiB: 93, gpuFreeMemoryMiB: 7 }),
        thresholds,
    );

    expect(result.gpuMemoryPressurePercent).toBe(93);
    expect(result.pressure).toBe("CRITICAL");
});
