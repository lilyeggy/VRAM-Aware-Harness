import { expect, test } from "bun:test";

import type {
    ResourceObservation,
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";
import {
    FakeResourceObserver,
} from "../fakes/fake-resource-observer.ts";

const normalSnapshot: ResourceSnapshot = {
    snapshotId: "snapshot-normal",
    observedAt: "2026-08-01T10:00:00.000Z",
    sources: ["FAKE"],
    gpuTotalMemoryMiB: 49_140,
    gpuUsedMemoryMiB: 12_000,
    gpuFreeMemoryMiB: 37_140,
    gpuUtilizationPercent: 28,
    runningRequests: 1,
    waitingRequests: 0,
    kvCacheUsagePercent: 22,
    inputTokensPerSecond: 1_200,
    outputTokensPerSecond: 75,
};

const failedObservation: ResourceObservation = {
    ok: false,
    observedAt: "2026-08-01T10:01:00.000Z",
    attemptedSources: ["FAKE"],
    reason: "TIMEOUT",
    message: "模拟资源观测超时",
};

test("observe 返回构造时传入的成功快照", async () => {
    const observer = new FakeResourceObserver({
        ok: true,
        snapshot: normalSnapshot,
    });

    const observation = await observer.observe();

    expect(observation).toEqual({
        ok: true,
        snapshot: normalSnapshot,
    });
    expect(observer.observeCallCount).toBe(1);
});

test("observe 可以返回显式的观测失败", async () => {
    const observer = new FakeResourceObserver(failedObservation);

    const observation = await observer.observe();

    expect(observation).toEqual(failedObservation);
    expect(observer.observeCallCount).toBe(1);
});

test("setObservation 可以在运行期间切换观测结果", async () => {
    const observer = new FakeResourceObserver(failedObservation);

    const firstObservation = await observer.observe();

    observer.setObservation({
        ok: true,
        snapshot: normalSnapshot,
    });

    const secondObservation = await observer.observe();

    expect(firstObservation.ok).toBe(false);
    expect(secondObservation).toEqual({
        ok: true,
        snapshot: normalSnapshot,
    });
    expect(observer.observeCallCount).toBe(2);
});
