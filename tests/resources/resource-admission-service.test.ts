import { expect, test } from "bun:test";

import {
    ResourceAdmissionService,
} from "../../src/resources/resource-admission-service.ts";
import {
    DeterministicExecutionPolicy,
} from "../../src/resources/execution-policy.ts";
import type {
    ExecutionPolicy,
} from "../../src/resources/execution-policy.ts";
import type {
    ResourceThresholds,
} from "../../src/resources/resource-classifier.ts";
import type {
    ResourceObservation,
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";
import {
    FakeResourceObserver,
} from "../fakes/fake-resource-observer.ts";
import {
    FakePolicyDecisionRecorder,
} from "../fakes/fake-policy-decision-recorder.ts";

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
        observedAt: "2026-08-02T10:00:00.000Z",
        sources: ["FAKE"],
        gpuTotalMemoryMiB: 100,
        gpuUsedMemoryMiB: 20,
        gpuFreeMemoryMiB: 80,
        gpuUtilizationPercent: 20,
        runningRequests: 1,
        waitingRequests: 0,
        kvCacheUsagePercent: 20,
        inputTokensPerSecond: 1_000,
        outputTokensPerSecond: 100,
        ...overrides,
    };
}

function createService(
    observation: ResourceObservation,
): {
    observer: FakeResourceObserver;
    recorder: FakePolicyDecisionRecorder;
    service: ResourceAdmissionService;
} {
    const observer = new FakeResourceObserver(observation);
    const recorder = new FakePolicyDecisionRecorder();
    const policy = new DeterministicExecutionPolicy({
        maxActiveRuns: 2,
    });

    return {
        observer,
        recorder,
        service: new ResourceAdmissionService(
            observer,
            thresholds,
            policy,
            recorder,
        ),
    };
}

test("成功观测会依次完成分类和准入决策", async () => {
    const { observer, recorder, service } = createService({
        ok: true,
        snapshot: createSnapshot(),
    });

    const result = await service.evaluate({
        runId: "run-1",
        tenantId: "tenant-1",
        activeRunCount: 0,
        activeTenantRunCount: 0,
    });

    expect(observer.observeCallCount).toBe(1);
    expect(result.observation.ok).toBe(true);
    expect(result.classification?.pressure).toBe("NORMAL");
    expect(result.decision.action).toBe("START");
    expect(result.decision.reasonCode).toBe("RESOURCE_NORMAL");
    expect(result.decision.resourceSnapshotId).toBe("snapshot-1");
    expect(result.decision.observationFailureReason).toBeNull();
    expect(recorder.records).toEqual([{
        decision: result.decision,
        snapshot: result.observation.ok
            ? result.observation.snapshot
            : null,
    }]);
});

test("CRITICAL 快照会经过 Policy 让新 Run 排队", async () => {
    const { service } = createService({
        ok: true,
        snapshot: createSnapshot({
            gpuUsedMemoryMiB: 95,
            gpuFreeMemoryMiB: 5,
        }),
    });

    const result = await service.evaluate({
        runId: "run-critical",
        tenantId: "tenant-1",
        activeRunCount: 0,
        activeTenantRunCount: 0,
    });

    expect(result.classification?.pressure).toBe("CRITICAL");
    expect(result.decision.action).toBe("QUEUE");
    expect(result.decision.reasonCode).toBe("RESOURCE_CRITICAL");
});

test("观测失败会跳过分类和 Policy 并采用 fail-closed", async () => {
    const observation: ResourceObservation = {
        ok: false,
        observedAt: "2026-08-02T10:01:00.000Z",
        attemptedSources: ["VLLM_METRICS", "NVIDIA_SMI"],
        reason: "TIMEOUT",
        message: "资源观测超时",
    };
    const observer = new FakeResourceObserver(observation);
    const policy: ExecutionPolicy = {
        decide() {
            throw new Error("观测失败时不应该调用 Policy");
        },
    };
    const recorder = new FakePolicyDecisionRecorder();
    const service = new ResourceAdmissionService(
        observer,
        thresholds,
        policy,
        recorder,
    );

    const result = await service.evaluate({
        runId: "run-timeout",
        tenantId: "tenant-1",
        activeRunCount: 0,
        activeTenantRunCount: 0,
    });

    expect(result.observation).toEqual(observation);
    expect(result.classification).toBeNull();
    expect(result.decision.action).toBe("QUEUE");
    expect(result.decision.reasonCode).toBe(
        "RESOURCE_OBSERVATION_FAILED",
    );
    expect(result.decision.resourceSnapshotId).toBeNull();
    expect(result.decision.pressure).toBe("UNKNOWN");
    expect(result.decision.observationFailureReason).toBe("TIMEOUT");
    expect(recorder.records).toEqual([{
        decision: result.decision,
        snapshot: null,
    }]);
});

test("成功但没有可用指标时由分类器产生 RESOURCE_UNKNOWN", async () => {
    const { service } = createService({
        ok: true,
        snapshot: createSnapshot({
            gpuTotalMemoryMiB: null,
            gpuUsedMemoryMiB: null,
            gpuFreeMemoryMiB: null,
            runningRequests: null,
            waitingRequests: null,
            kvCacheUsagePercent: null,
        }),
    });

    const result = await service.evaluate({
        runId: "run-unknown",
        tenantId: "tenant-1",
        activeRunCount: 0,
        activeTenantRunCount: 0,
    });

    expect(result.classification?.pressure).toBe("UNKNOWN");
    expect(result.decision.action).toBe("QUEUE");
    expect(result.decision.reasonCode).toBe("RESOURCE_UNKNOWN");
    expect(result.decision.resourceSnapshotId).toBe("snapshot-1");
    expect(result.decision.observationFailureReason).toBeNull();
});
