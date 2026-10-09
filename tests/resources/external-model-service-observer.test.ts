import { expect, test } from "bun:test";

import {
    ExternalModelServiceResourceObserver,
    EXTERNAL_MODEL_SERVICE_SOURCE,
} from "../../src/resources/external-model-service-observer.ts";
import {
    classifyResource,
    type ResourceThresholds,
} from "../../src/resources/resource-classifier.ts";

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

test("外部模型服务观察器返回 NORMAL 信号，不伪造 GPU 数据", async () => {
    const observer = new ExternalModelServiceResourceObserver({
        now: () => new Date("2026-10-09T12:00:00.000Z"),
        createSnapshotId: () => "external-snapshot-1",
    });

    const observation = await observer.observe();
    expect(observation.ok).toBe(true);
    if (observation.ok === false) {
        throw new Error("外部模型服务观察器不应失败");
    }

    expect(observation.snapshot).toEqual({
        snapshotId: "external-snapshot-1",
        observedAt: "2026-10-09T12:00:00.000Z",
        sources: [EXTERNAL_MODEL_SERVICE_SOURCE],
        gpuTotalMemoryMiB: null,
        gpuUsedMemoryMiB: null,
        gpuFreeMemoryMiB: null,
        gpuUtilizationPercent: null,
        runningRequests: 0,
        waitingRequests: 0,
        kvCacheUsagePercent: 0,
        inputTokensPerSecond: null,
        outputTokensPerSecond: null,
    });

    const classification = classifyResource(observation.snapshot, thresholds);
    expect(classification.pressure).toBe("NORMAL");
    expect(classification.reasons).toEqual(["WITHIN_THRESHOLDS"]);
});
