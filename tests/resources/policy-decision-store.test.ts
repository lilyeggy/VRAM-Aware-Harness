import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import type {
    PolicyDecision,
} from "../../src/resources/execution-policy.ts";
import {
    PolicyDecisionStore,
} from "../../src/resources/policy-decision-store.ts";
import type {
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";
import type {
    AgentRun,
    RunEvent,
} from "../../src/runs/agent-run.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import {
    openHarnessDatabase,
} from "../../src/storage/database.ts";

const createdAt = "2026-08-02T10:00:00.000Z";

function seedRun(db: Database, runId = "run-1"): void {
    const run: AgentRun = {
        id: runId,
        tenantId: "tenant-1",
        harnessSessionId: "session-1",
        status: "QUEUED",
        userInput: "分析项目",
        workspacePath: "/tmp/workspace",
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        finishedAt: null,
        checkpointId: null,
        failureReason: null,
    };
    const event: RunEvent = {
        eventId: `event-${runId}-1`,
        runId,
        sequence: 1,
        type: "RUN_CREATED",
        timestamp: createdAt,
        payloadVersion: 1,
        payload: {},
    };

    new RunStore(db).create(run, event);
}

function createSnapshot(
    snapshotId = "snapshot-1",
): ResourceSnapshot {
    return {
        snapshotId,
        observedAt: createdAt,
        sources: ["VLLM_METRICS", "NVIDIA_SMI"],
        gpuTotalMemoryMiB: 49_140,
        gpuUsedMemoryMiB: 12_000,
        gpuFreeMemoryMiB: 37_140,
        gpuUtilizationPercent: 35,
        runningRequests: 1,
        waitingRequests: 0,
        kvCacheUsagePercent: 22,
        inputTokensPerSecond: 1_200,
        outputTokensPerSecond: 90,
    };
}

function createDecision(
    overrides: Partial<PolicyDecision> = {},
): PolicyDecision {
    return {
        decisionId: "decision-1",
        runId: "run-1",
        action: "START",
        reasonCode: "RESOURCE_NORMAL",
        resourceSnapshotId: "snapshot-1",
        pressure: "NORMAL",
        observationFailureReason: null,
        decidedAt: createdAt,
        ...overrides,
    };
}

test("save 原子保存资源快照和策略决策", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new PolicyDecisionStore(db);

    try {
        seedRun(db);
        const snapshot = createSnapshot();
        const decision = createDecision();

        store.save(decision, snapshot);

        expect(store.get(decision.decisionId)).toEqual(decision);
        expect(store.getSnapshot(snapshot.snapshotId)).toEqual(
            snapshot,
        );
        expect(store.listForRun(decision.runId)).toEqual([
            decision,
        ]);
    } finally {
        db.close();
    }
});

test("同一个 Snapshot 可以支持一个 Run 的多次追加式决策", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new PolicyDecisionStore(db);

    try {
        seedRun(db);
        const snapshot = createSnapshot();
        const queued = createDecision({
            decisionId: "decision-queue",
            action: "QUEUE",
            reasonCode: "GLOBAL_CONCURRENCY_LIMIT",
            decidedAt: "2026-08-02T10:00:01.000Z",
        });
        const started = createDecision({
            decisionId: "decision-start",
            decidedAt: "2026-08-02T10:00:02.000Z",
        });

        store.save(started, snapshot);
        store.save(queued, snapshot);

        expect(store.listForRun("run-1")).toEqual([
            queued,
            started,
        ]);
    } finally {
        db.close();
    }
});

test("观测失败决策不伪造 Snapshot，并保留失败原因", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new PolicyDecisionStore(db);

    try {
        seedRun(db);
        const decision = createDecision({
            decisionId: "decision-timeout",
            action: "QUEUE",
            reasonCode: "RESOURCE_OBSERVATION_FAILED",
            resourceSnapshotId: null,
            pressure: "UNKNOWN",
            observationFailureReason: "TIMEOUT",
        });

        store.save(decision, null);

        expect(store.get(decision.decisionId)).toEqual(decision);
        expect(store.listForRun(decision.runId)).toEqual([
            decision,
        ]);
    } finally {
        db.close();
    }
});

test("Decision 和 Snapshot 证据不一致时拒绝保存", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new PolicyDecisionStore(db);

    try {
        seedRun(db);
        const decision = createDecision({
            resourceSnapshotId: "snapshot-other",
        });

        expect(() => {
            store.save(decision, createSnapshot());
        }).toThrow(
            "成功观测决策必须引用与 Decision 匹配的 Snapshot",
        );
        expect(store.get(decision.decisionId)).toBeNull();
        expect(store.getSnapshot("snapshot-1")).toBeNull();
    } finally {
        db.close();
    }
});

test("相同 Snapshot ID 对应不同内容时拒绝改写历史证据", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new PolicyDecisionStore(db);

    try {
        seedRun(db);
        const snapshot = createSnapshot();
        store.save(createDecision(), snapshot);

        const changedSnapshot: ResourceSnapshot = {
            ...snapshot,
            gpuUsedMemoryMiB: 30_000,
        };

        expect(() => {
            store.save(createDecision({
                decisionId: "decision-2",
            }), changedSnapshot);
        }).toThrow(
            "ResourceSnapshot ID 对应不同内容：snapshot-1",
        );
        expect(store.get("decision-2")).toBeNull();
        expect(store.getSnapshot("snapshot-1")).toEqual(snapshot);
    } finally {
        db.close();
    }
});

test("Decision 写入失败时回滚同一事务中新插入的 Snapshot", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new PolicyDecisionStore(db);

    try {
        seedRun(db);
        const firstSnapshot = createSnapshot("snapshot-1");
        const decision = createDecision();
        store.save(decision, firstSnapshot);

        const secondSnapshot = createSnapshot("snapshot-2");

        expect(() => {
            store.save(
                {
                    ...decision,
                    resourceSnapshotId: "snapshot-2",
                },
                secondSnapshot,
            );
        }).toThrow();

        expect(store.getSnapshot("snapshot-2")).toBeNull();
        expect(store.get(decision.decisionId)).toEqual(decision);
    } finally {
        db.close();
    }
});
