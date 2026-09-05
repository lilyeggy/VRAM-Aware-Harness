import { expect, test } from "bun:test";
import { ResourceMetricsSampler } from "../../src/resources/resource-metrics-sampler.ts";
import type { ResourceObservation } from "../../src/resources/resource-observer.ts";

const snapshot = (id: string) => ({
    snapshotId: id, observedAt: `2026-09-05T00:00:0${id}Z`, sources: ["FAKE" as const],
    gpuTotalMemoryMiB: 100, gpuUsedMemoryMiB: 40, gpuFreeMemoryMiB: 60,
    gpuUtilizationPercent: 50, runningRequests: 2, waitingRequests: 1,
    kvCacheUsagePercent: 0.4, inputTokensPerSecond: null, outputTokensPerSecond: null,
});

test("sampler records timestamped GPU/KV snapshots and bounds history", async () => {
    const observations: ResourceObservation[] = [
        { ok: true, snapshot: snapshot("1") }, { ok: true, snapshot: snapshot("2") },
    ];
    const observer = { observe: async () => observations.shift()! };
    const sampler = new ResourceMetricsSampler(observer, { maxSamples: 1 });
    await sampler.sample(); await sampler.sample();
    expect(sampler.getSamples()).toHaveLength(1);
    expect(sampler.getSamples()[0]?.ok).toBe(true);
    const sample = sampler.getSamples()[0];
    expect(sample?.ok ? sample.snapshot.kvCacheUsagePercent : null).toBe(0.4);
});

test("sampling failure is recorded and does not throw", async () => {
    const observer = { observe: async (): Promise<ResourceObservation> => ({
        ok: false, observedAt: "2026-09-05T00:00:00Z", attemptedSources: ["VLLM_METRICS"], reason: "TIMEOUT", message: "timeout",
    }) };
    const sampler = new ResourceMetricsSampler(observer);
    const result = await sampler.sample();
    expect(result).toEqual({ ok: false, sampledAt: "2026-09-05T00:00:00Z", reason: "TIMEOUT", message: "timeout" });
});
