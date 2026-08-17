import { expect, test } from "bun:test";

import type {
    Checkpoint,
} from "../../src/checkpoints/checkpoint.ts";
import type {
    AgentRun,
} from "../../src/runs/agent-run.ts";
import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import type {
    AgentRuntime,
    RuntimeEventHandler,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "../../src/runtime/agent-runtime.ts";
import type {
    PolicyAction,
    PolicyDecision,
    PolicyReasonCode,
} from "../../src/resources/execution-policy.ts";
import type {
    ResourceAdmissionEvaluator,
    ResourceAdmissionRequest,
    ResourceAdmissionResult,
} from "../../src/resources/resource-admission-service.ts";
import {
    RunQueueCoordinator,
    toQueueReasonCode,
} from "../../src/scheduling/run-queue-coordinator.ts";
import {
    TenantRunScheduler,
} from "../../src/scheduling/tenant-run-scheduler.ts";
import {
    openHarnessDatabase,
} from "../../src/storage/database.ts";
import {
    FakeAgentRuntime,
} from "../fakes/fake-agent-runtime.ts";

function createDecision(
    request: ResourceAdmissionRequest,
    action: PolicyAction,
    reasonCode: PolicyReasonCode,
): PolicyDecision {
    return {
        decisionId: `decision-${request.runId}`,
        runId: request.runId,
        action,
        reasonCode,
        resourceSnapshotId: "snapshot-1",
        pressure:
            reasonCode === "RESOURCE_CRITICAL"
                ? "CRITICAL"
                : "NORMAL",
        observationFailureReason: null,
        decidedAt: "2026-08-04T10:00:00.000Z",
    };
}

function createAdmissionResult(
    decision: PolicyDecision,
): ResourceAdmissionResult {
    return {
        observation: {
            ok: true,
            snapshot: {
                snapshotId: "snapshot-1",
                observedAt: "2026-08-04T10:00:00.000Z",
                sources: ["FAKE"],
                gpuTotalMemoryMiB: 100,
                gpuUsedMemoryMiB: 20,
                gpuFreeMemoryMiB: 80,
                gpuUtilizationPercent: 20,
                runningRequests: 0,
                waitingRequests: 0,
                kvCacheUsagePercent: 20,
                inputTokensPerSecond: 1_000,
                outputTokensPerSecond: 100,
            },
        },
        classification: null,
        decision,
    };
}

class BlockingAgentRuntime implements AgentRuntime {
    private readonly handlersByRunId =
        new Map<string, Set<RuntimeEventHandler>>();
    private readonly releaseResolvers: Array<() => void> = [];
    private readonly startWaiters: Array<{
        count: number;
        resolve: () => void;
    }> = [];

    readonly startRequests: RuntimeStartRequest[] = [];
    readonly interruptedRunIds: string[] = [];
    activeStartCount = 0;
    maxActiveStartCount = 0;

    subscribe(
        runId: string,
        handler: RuntimeEventHandler,
    ): () => void {
        let handlers = this.handlersByRunId.get(runId);

        if (handlers === undefined) {
            handlers = new Set<RuntimeEventHandler>();
            this.handlersByRunId.set(runId, handlers);
        }

        handlers.add(handler);

        return () => {
            handlers?.delete(handler);
        };
    }

    async start(request: RuntimeStartRequest): Promise<void> {
        this.startRequests.push(request);
        this.activeStartCount += 1;
        this.maxActiveStartCount = Math.max(
            this.maxActiveStartCount,
            this.activeStartCount,
        );
        this.resolveStartWaiters();

        await new Promise<void>((resolve) => {
            this.releaseResolvers.push(resolve);
        });

        if (this.interruptedRunIds.includes(request.run.runId)) {
            this.emitInterrupted(request.run.runId);
        } else {
            this.emitCompleted(request.run.runId);
        }
        this.activeStartCount -= 1;
    }

    async resume(_request: RuntimeResumeRequest): Promise<void> {}

    async interrupt(runId: string): Promise<void> {
        this.interruptedRunIds.push(runId);
    }

    waitForStartCount(count: number): Promise<void> {
        if (this.startRequests.length >= count) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            this.startWaiters.push({ count, resolve });
        });
    }

    releaseAllStarted(): void {
        const resolvers = this.releaseResolvers.splice(0);

        for (const resolve of resolvers) {
            resolve();
        }
    }

    private resolveStartWaiters(): void {
        for (
            let index = this.startWaiters.length - 1;
            index >= 0;
            index -= 1
        ) {
            const waiter = this.startWaiters[index];

            if (
                waiter !== undefined
                && this.startRequests.length >= waiter.count
            ) {
                this.startWaiters.splice(index, 1);
                waiter.resolve();
            }
        }
    }

    private emitCompleted(runId: string): void {
        const handlers = this.handlersByRunId.get(runId);

        if (handlers === undefined) {
            return;
        }

        for (const handler of handlers) {
            handler({
                type: "agent_completed",
                runId,
                timestamp: new Date().toISOString(),
            });
        }
    }

    private emitInterrupted(runId: string): void {
        const handlers = this.handlersByRunId.get(runId);

        if (handlers === undefined) {
            return;
        }

        for (const handler of handlers) {
            handler({
                type: "agent_interrupted",
                runId,
                timestamp: new Date().toISOString(),
            });
        }
    }
}

class FailFirstStartRuntime extends FakeAgentRuntime {
    override async start(request: RuntimeStartRequest): Promise<void> {
        if (this.startRequests.length === 0) {
            this.startRequests.push(request);
            throw new Error("Fake Runtime 启动失败");
        }

        await super.start(request);
    }
}

test("submit 持久化 QUEUED Run 并入队，但不启动 Runtime", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });
    const admission: ResourceAdmissionEvaluator = {
        async evaluate() {
            throw new Error("submit 不应该执行资源准入");
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const run = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "等待调度后执行",
            workspacePath: "/tmp/workspace-a",
        });

        expect(run.status).toBe("QUEUED");
        expect(store.get(run.id)).toEqual(run);
        expect(runtime.startRequests).toEqual([]);
        expect(scheduler.getCapacity("tenant-a")).toEqual({
            activeRunCount: 0,
            activeTenantRunCount: 0,
        });
        expect(scheduler.listQueue()).toEqual([{
            runId: run.id,
            tenantId: "tenant-a",
            reasonCode: "AWAITING_SCHEDULING",
            enqueuedAt: expect.any(String),
            position: 1,
            tenantPosition: 1,
        }]);
        expect(store.listEvents(run.id).map((event) => event.type))
            .toEqual(["RUN_CREATED"]);
    } finally {
        db.close();
    }
});

test("QUEUE Policy reason 会归一化为队列展示原因", () => {
    const cases = [
        ["GLOBAL_CONCURRENCY_LIMIT", "GLOBAL_CONCURRENCY_LIMIT"],
        ["RESOURCE_BUSY_TENANT_LIMIT", "RESOURCE_BUSY"],
        ["RESOURCE_CRITICAL", "RESOURCE_CRITICAL"],
        ["RESOURCE_UNKNOWN", "RESOURCE_UNKNOWN"],
        ["RESOURCE_OBSERVATION_FAILED", "RESOURCE_OBSERVATION_FAILED"],
    ] as const;

    for (const [policyReason, queueReason] of cases) {
        expect(toQueueReasonCode({
            decisionId: `decision-${policyReason}`,
            runId: "run-1",
            action: "QUEUE",
            reasonCode: policyReason,
            resourceSnapshotId: null,
            pressure: "UNKNOWN",
            observationFailureReason: null,
            decidedAt: "2026-08-04T10:00:00.000Z",
        })).toBe(queueReason);
    }
});

test("START Policy decision 不能转换成排队原因", () => {
    expect(() => toQueueReasonCode({
        decisionId: "decision-start",
        runId: "run-1",
        action: "START",
        reasonCode: "RESOURCE_NORMAL",
        resourceSnapshotId: "snapshot-1",
        pressure: "NORMAL",
        observationFailureReason: null,
        decidedAt: "2026-08-04T10:00:00.000Z",
    })).toThrow(
        "START 决策不能转换成排队原因：RESOURCE_NORMAL",
    );
});

test("attemptNext 在空队列时不调用 Admission", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    let evaluateCallCount = 0;
    const admission: ResourceAdmissionEvaluator = {
        async evaluate() {
            evaluateCallCount += 1;
            throw new Error("空队列不应执行 Admission");
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        expect(await coordinator.attemptNext()).toEqual({
            kind: "EMPTY",
        });
        expect(evaluateCallCount).toBe(0);
        expect(runtime.startRequests).toEqual([]);
    } finally {
        db.close();
    }
});

test("attemptNext 在 CRITICAL 决策后释放 slot 并保留原入队时间", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const requests: ResourceAdmissionRequest[] = [];
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            requests.push(request);
            return createAdmissionResult(createDecision(
                request,
                "QUEUE",
                "RESOURCE_CRITICAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const run = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "资源恢复后执行",
            workspacePath: "/tmp/workspace-a",
        });
        const originalEnqueuedAt =
            scheduler.listQueue()[0]?.enqueuedAt;

        expect(originalEnqueuedAt).toBeDefined();

        const result = await coordinator.attemptNext();

        expect(result.kind).toBe("DEFERRED");
        expect(requests).toEqual([{
            runId: run.id,
            tenantId: "tenant-a",
            activeRunCount: 0,
            activeTenantRunCount: 0,
        }]);
        expect(store.get(run.id)?.status).toBe("QUEUED");
        expect(runtime.startRequests).toEqual([]);
        expect(scheduler.getCapacity("tenant-a")).toEqual({
            activeRunCount: 0,
            activeTenantRunCount: 0,
        });
        expect(scheduler.listQueue()).toEqual([{
            runId: run.id,
            tenantId: "tenant-a",
            reasonCode: "RESOURCE_CRITICAL",
            enqueuedAt: originalEnqueuedAt!,
            position: 1,
            tenantPosition: 1,
        }]);
    } finally {
        db.close();
    }
});

test("attemptNext 在 START 决策后执行 Run 并释放 slot", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            return createAdmissionResult(createDecision(
                request,
                "START",
                "RESOURCE_NORMAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const submittedRun = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "立即执行",
            workspacePath: "/tmp/workspace-a",
        });

        const result = await coordinator.attemptNext();

        expect(result.kind).toBe("EXECUTED");
        if (result.kind === "EXECUTED") {
            expect(result.run.status).toBe("COMPLETED");
            expect(result.run.id).toBe(submittedRun.id);
        }
        expect(runtime.startRequests).toHaveLength(1);
        expect(scheduler.listQueue()).toEqual([]);
        expect(scheduler.getCapacity("tenant-a")).toEqual({
            activeRunCount: 0,
            activeTenantRunCount: 0,
        });
    } finally {
        db.close();
    }
});

test("Admission 抛错时 attemptNext 释放 slot 并恢复等待 Run", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const admission: ResourceAdmissionEvaluator = {
        async evaluate() {
            throw new Error("决策记录器暂时不可用");
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const run = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "等待重试",
            workspacePath: "/tmp/workspace-a",
        });

        await expect(coordinator.attemptNext()).rejects.toThrow(
            "决策记录器暂时不可用",
        );

        expect(store.get(run.id)?.status).toBe("QUEUED");
        expect(runtime.startRequests).toEqual([]);
        expect(scheduler.getCapacity("tenant-a")).toEqual({
            activeRunCount: 0,
            activeTenantRunCount: 0,
        });
        expect(scheduler.listQueue().map((entry) => ({
            runId: entry.runId,
            reasonCode: entry.reasonCode,
        }))).toEqual([{
            runId: run.id,
            reasonCode: "RESOURCE_OBSERVATION_FAILED",
        }]);
    } finally {
        db.close();
    }
});

test("drain 在全部 START 时执行当前队列中的所有 Run", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            return createAdmissionResult(createDecision(
                request,
                "START",
                "RESOURCE_NORMAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const runA = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "执行 A",
            workspacePath: "/tmp/workspace-a",
        });
        const runB = coordinator.submit({
            tenantId: "tenant-b",
            harnessSessionId: "session-b",
            userInput: "执行 B",
            workspacePath: "/tmp/workspace-b",
        });

        const results = await coordinator.drain();

        expect(results.map((result) => result.kind)).toEqual([
            "EXECUTED",
            "EXECUTED",
        ]);
        expect(store.get(runA.id)?.status).toBe("COMPLETED");
        expect(store.get(runB.id)?.status).toBe("COMPLETED");
        expect(runtime.startRequests.map(
            (request) => request.run.runId,
        )).toEqual([runA.id, runB.id]);
        expect(scheduler.listQueue()).toEqual([]);
    } finally {
        db.close();
    }
});

test("drain 在全部 CRITICAL 时每个当前 Run 只检查一次", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });
    let evaluateCallCount = 0;
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            evaluateCallCount += 1;
            return createAdmissionResult(createDecision(
                request,
                "QUEUE",
                "RESOURCE_CRITICAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const runA = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "等待 A",
            workspacePath: "/tmp/workspace-a",
        });
        const runB = coordinator.submit({
            tenantId: "tenant-b",
            harnessSessionId: "session-b",
            userInput: "等待 B",
            workspacePath: "/tmp/workspace-b",
        });

        const results = await coordinator.drain();

        expect(results.map((result) => result.kind)).toEqual([
            "DEFERRED",
            "DEFERRED",
        ]);
        expect(evaluateCallCount).toBe(2);
        expect(runtime.startRequests).toEqual([]);
        expect(scheduler.listQueue().map((entry) => ({
            runId: entry.runId,
            reasonCode: entry.reasonCode,
        }))).toEqual([
            {
                runId: runA.id,
                reasonCode: "RESOURCE_CRITICAL",
            },
            {
                runId: runB.id,
                reasonCode: "RESOURCE_CRITICAL",
            },
        ]);
    } finally {
        db.close();
    }
});

test("drain 中一个 Run DEFERRED 不会阻止后续 Run 执行", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            return createAdmissionResult(
                request.tenantId === "tenant-a"
                    ? createDecision(
                        request,
                        "QUEUE",
                        "RESOURCE_CRITICAL",
                    )
                    : createDecision(
                        request,
                        "START",
                        "RESOURCE_NORMAL",
                    ),
            );
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const runA = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "延后 A",
            workspacePath: "/tmp/workspace-a",
        });
        const runB = coordinator.submit({
            tenantId: "tenant-b",
            harnessSessionId: "session-b",
            userInput: "执行 B",
            workspacePath: "/tmp/workspace-b",
        });

        const results = await coordinator.drain();

        expect(results.map((result) => result.kind)).toEqual([
            "DEFERRED",
            "EXECUTED",
        ]);
        expect(store.get(runA.id)?.status).toBe("QUEUED");
        expect(store.get(runB.id)?.status).toBe("COMPLETED");
        expect(scheduler.listQueue().map((entry) => entry.runId))
            .toEqual([runA.id]);
    } finally {
        db.close();
    }
});

test("drain 的真实并发不会超过 Scheduler 全局 slot", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new BlockingAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerTenant: 1,
    });
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            return createAdmissionResult(createDecision(
                request,
                "START",
                "RESOURCE_NORMAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const runs = ["a", "b", "c"].map((suffix) =>
            coordinator.submit({
                tenantId: `tenant-${suffix}`,
                harnessSessionId: `session-${suffix}`,
                userInput: `执行 ${suffix}`,
                workspacePath: `/tmp/workspace-${suffix}`,
            }));

        const drainPromise = coordinator.drain();

        await runtime.waitForStartCount(2);

        expect(runtime.activeStartCount).toBe(2);
        expect(runtime.maxActiveStartCount).toBe(2);
        expect(runtime.startRequests).toHaveLength(2);
        expect(scheduler.listQueue()).toHaveLength(1);

        runtime.releaseAllStarted();
        await runtime.waitForStartCount(3);

        expect(runtime.maxActiveStartCount).toBe(2);
        expect(runtime.activeStartCount).toBe(1);
        expect(runtime.startRequests[2]?.run.runId).toBe(runs[2]?.id);

        runtime.releaseAllStarted();

        const results = await drainPromise;

        expect(results.map((result) => result.kind)).toEqual([
            "EXECUTED",
            "EXECUTED",
            "EXECUTED",
        ]);
        expect(runtime.maxActiveStartCount).toBe(2);
        expect(scheduler.listQueue()).toEqual([]);
    } finally {
        runtime.releaseAllStarted();
        db.close();
    }
});

test("并发 drain 调用复用同一个推进循环", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new BlockingAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    let evaluateCallCount = 0;
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            evaluateCallCount += 1;
            return createAdmissionResult(createDecision(
                request,
                "START",
                "RESOURCE_NORMAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "只执行一次",
            workspacePath: "/tmp/workspace-a",
        });

        const firstDrain = coordinator.drain();
        await runtime.waitForStartCount(1);

        const secondDrain = coordinator.drain();

        expect(secondDrain).toBe(firstDrain);
        expect(runtime.startRequests).toHaveLength(1);

        runtime.releaseAllStarted();

        const results = await firstDrain;

        expect(results.map((result) => result.kind)).toEqual([
            "EXECUTED",
        ]);
        expect(evaluateCallCount).toBe(1);
        expect(runtime.startRequests).toHaveLength(1);
        expect(scheduler.listQueue()).toEqual([]);
    } finally {
        runtime.releaseAllStarted();
        db.close();
    }
});

test("drain 执行期间的新推进请求会在下一轮处理新 Run", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new BlockingAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            return createAdmissionResult(createDecision(
                request,
                "START",
                "RESOURCE_NORMAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const firstRun = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "先执行",
            workspacePath: "/tmp/workspace-a",
        });

        const firstDrain = coordinator.drain();
        await runtime.waitForStartCount(1);

        const secondRun = coordinator.submit({
            tenantId: "tenant-b",
            harnessSessionId: "session-b",
            userInput: "执行期间提交",
            workspacePath: "/tmp/workspace-b",
        });
        const pendingDrain = coordinator.drain();

        expect(pendingDrain).toBe(firstDrain);
        expect(scheduler.listQueue().map((entry) => entry.runId))
            .toEqual([secondRun.id]);

        runtime.releaseAllStarted();
        await runtime.waitForStartCount(2);

        expect(runtime.startRequests.map(
            (request) => request.run.runId,
        )).toEqual([firstRun.id, secondRun.id]);
        expect(runtime.maxActiveStartCount).toBe(1);

        runtime.releaseAllStarted();

        const results = await firstDrain;

        expect(results.map((result) => result.kind)).toEqual([
            "EXECUTED",
            "EXECUTED",
        ]);
        expect(scheduler.listQueue()).toEqual([]);
    } finally {
        runtime.releaseAllStarted();
        db.close();
    }
});

test("drain 完成后可以启动新的独立推进循环", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            return createAdmissionResult(createDecision(
                request,
                "START",
                "RESOURCE_NORMAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const firstRun = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "第一次 drain",
            workspacePath: "/tmp/workspace-a",
        });
        const firstDrain = coordinator.drain();

        await firstDrain;

        const secondRun = coordinator.submit({
            tenantId: "tenant-b",
            harnessSessionId: "session-b",
            userInput: "第二次 drain",
            workspacePath: "/tmp/workspace-b",
        });
        const secondDrain = coordinator.drain();

        expect(secondDrain).not.toBe(firstDrain);

        await secondDrain;

        expect(store.get(firstRun.id)?.status).toBe("COMPLETED");
        expect(store.get(secondRun.id)?.status).toBe("COMPLETED");
        expect(runtime.startRequests.map(
            (request) => request.run.runId,
        )).toEqual([firstRun.id, secondRun.id]);
    } finally {
        db.close();
    }
});

test("drain 异常结束后会清理 single-flight 状态", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    let evaluateCallCount = 0;
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            evaluateCallCount += 1;

            if (evaluateCallCount === 1) {
                throw new Error("临时准入故障");
            }

            return createAdmissionResult(createDecision(
                request,
                "START",
                "RESOURCE_NORMAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const run = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "准入恢复后继续",
            workspacePath: "/tmp/workspace-a",
        });

        const failedDrain = coordinator.drain();
        await expect(failedDrain).rejects.toThrow("临时准入故障");

        const recoveredDrain = coordinator.drain();

        expect(recoveredDrain).not.toBe(failedDrain);
        expect((await recoveredDrain).map((result) => result.kind))
            .toEqual(["EXECUTED"]);
        expect(store.get(run.id)?.status).toBe("COMPLETED");
        expect(scheduler.listQueue()).toEqual([]);
    } finally {
        db.close();
    }
});

test("Runtime 启动失败不会泄漏 slot，且 drain 继续推进后续 Run", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FailFirstStartRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            return createAdmissionResult(createDecision(
                request,
                "START",
                "RESOURCE_NORMAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const failedRun = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "启动时失败",
            workspacePath: "/tmp/workspace-a",
        });
        const followingRun = coordinator.submit({
            tenantId: "tenant-b",
            harnessSessionId: "session-b",
            userInput: "仍然应当执行",
            workspacePath: "/tmp/workspace-b",
        });

        await expect(coordinator.drain()).rejects.toThrow();

        expect(store.get(failedRun.id)?.status).toBe("INTERRUPTED");
        expect(store.get(followingRun.id)?.status).toBe("COMPLETED");
        expect(runtime.startRequests.map(
            (request) => request.run.runId,
        )).toEqual([failedRun.id, followingRun.id]);
        expect(scheduler.getCapacity("tenant-a")).toEqual({
            activeRunCount: 0,
            activeTenantRunCount: 0,
        });
        expect(scheduler.listQueue()).toEqual([]);
    } finally {
        db.close();
    }
});

test("全局并发为 1 时 Tenant B 不会排在 Tenant A 的全部 Run 之后", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            return createAdmissionResult(createDecision(
                request,
                "START",
                "RESOURCE_NORMAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );

    try {
        const runA1 = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a1",
            userInput: "执行 A1",
            workspacePath: "/tmp/workspace-a",
        });
        const runA2 = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a2",
            userInput: "执行 A2",
            workspacePath: "/tmp/workspace-a",
        });
        const runA3 = coordinator.submit({
            tenantId: "tenant-a",
            harnessSessionId: "session-a3",
            userInput: "执行 A3",
            workspacePath: "/tmp/workspace-a",
        });
        const runB1 = coordinator.submit({
            tenantId: "tenant-b",
            harnessSessionId: "session-b1",
            userInput: "执行 B1",
            workspacePath: "/tmp/workspace-b",
        });

        await coordinator.drain();

        expect(runtime.startRequests.map(
            (request) => request.run.runId,
        )).toEqual([
            runA1.id,
            runB1.id,
            runA2.id,
            runA3.id,
        ]);
        expect(scheduler.listQueue()).toEqual([]);
    } finally {
        db.close();
    }
});

test("恢复 Run 在资源拒绝后保留恢复参数，资源正常后占用 slot 执行", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    let action: PolicyAction = "QUEUE";
    const admission: ResourceAdmissionEvaluator = {
        async evaluate(request) {
            return createAdmissionResult(createDecision(
                request,
                action,
                action === "QUEUE"
                    ? "RESOURCE_CRITICAL"
                    : "RESOURCE_NORMAL",
            ));
        },
    };
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
    );
    const timestamp = new Date().toISOString();
    const checkpoint: Checkpoint = {
        id: "checkpoint-recovery-queue",
        runId: "run-recovery-queue",
        toolExecutionId: "tool-recovery-queue",
        runtimeSessionRef: "/tmp/recovery-session.jsonl",
        lastEventSequence: 1,
        createdAt: timestamp,
    };
    const interruptedRun: AgentRun = {
        id: checkpoint.runId,
        tenantId: "tenant-recovery",
        harnessSessionId: "session-recovery",
        status: "INTERRUPTED",
        userInput: "从安全边界恢复",
        workspacePath: "/tmp/workspace-recovery",
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        finishedAt: null,
        checkpointId: checkpoint.id,
        failureReason: null,
    };

    try {
        store.create(interruptedRun, {
            eventId: "event-recovery-interrupted",
            runId: interruptedRun.id,
            sequence: 1,
            type: "RUN_INTERRUPTED",
            timestamp,
            payloadVersion: 1,
            payload: { reason: "PROCESS_RESTART" },
        });

        const queuedRun = coordinator.submitResume({
            runId: interruptedRun.id,
            checkpoint,
            continuationInput: "继续完成恢复任务",
        });

        expect(queuedRun.status).toBe("QUEUED");
        expect(runtime.resumeRequests).toEqual([]);

        const deferred = await coordinator.attemptNext();

        expect(deferred.kind).toBe("DEFERRED");
        expect(runtime.resumeRequests).toEqual([]);
        expect(scheduler.listQueue()).toEqual([
            expect.objectContaining({
                runId: interruptedRun.id,
                reasonCode: "RESOURCE_CRITICAL",
            }),
        ]);
        expect(scheduler.getCapacity(interruptedRun.tenantId)).toEqual({
            activeRunCount: 0,
            activeTenantRunCount: 0,
        });

        action = "START";
        const executed = await coordinator.attemptNext();

        expect(executed.kind).toBe("EXECUTED");
        expect(store.get(interruptedRun.id)?.status).toBe("COMPLETED");
        expect(runtime.startRequests).toEqual([]);
        expect(runtime.resumeRequests).toEqual([{
            run: {
                runId: interruptedRun.id,
                tenantId: interruptedRun.tenantId,
                harnessSessionId: interruptedRun.harnessSessionId,
                workspacePath: interruptedRun.workspacePath,
            },
            checkpoint: {
                checkpointId: checkpoint.id,
                runtimeSessionRef: checkpoint.runtimeSessionRef,
                lastEventSequence: checkpoint.lastEventSequence,
            },
            continuationInput: "继续完成恢复任务",
        }]);
        expect(store.listEvents(interruptedRun.id).map(
            (event) => event.type,
        )).toEqual([
            "RUN_INTERRUPTED",
            "RUN_QUEUED",
            "RUN_RESUMED",
            "RUN_COMPLETED",
        ]);
        expect(scheduler.getCapacity(interruptedRun.tenantId)).toEqual({
            activeRunCount: 0,
            activeTenantRunCount: 0,
        });
        expect(scheduler.listQueue()).toEqual([]);
    } finally {
        db.close();
    }
});

test("interrupt 移除排队 Run，使后续 drain 不会启动它", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const scheduler = new TenantRunScheduler({
        maxActiveRuns:1,
        maxActiveRunsPerTenant:1,
    });
    const coordinator = new RunQueueCoordinator(
        new RunService(store, runtime),
        scheduler,
        {
            async evaluate() {
                throw new Error("被中断的排队 Run 不应进入资源准入");
            },
        },
    );

    try {
        const run = coordinator.submit({
            tenantId:"tenant-interrupt",
            harnessSessionId:"session-interrupt",
            userInput:"取消这个排队任务",
            workspacePath:"/tmp/workspace-interrupt",
        });

        const interruptedRun = await coordinator.interrupt(run.id);

        expect(interruptedRun.status).toBe("INTERRUPTED");
        expect(scheduler.listQueue()).toEqual([]);
        expect(await coordinator.drain()).toEqual([]);
        expect(runtime.startRequests).toEqual([]);
        expect(runtime.interruptedRunIds).toEqual([]);
    } finally {
        db.close();
    }
});

test("运行中 interrupt 不提前释放 slot，Runtime 退出后才允许后续 Run", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new BlockingAgentRuntime();
    const scheduler = new TenantRunScheduler({
        maxActiveRuns:1,
        maxActiveRunsPerTenant:1,
    });
    const coordinator = new RunQueueCoordinator(
        new RunService(store, runtime),
        scheduler,
        {
            async evaluate(request) {
                return createAdmissionResult(createDecision(
                    request,
                    "START",
                    "RESOURCE_NORMAL",
                ));
            },
        },
    );

    try {
        const firstRun = coordinator.submit({
            tenantId:"tenant-a",
            harnessSessionId:"session-a",
            userInput:"运行后中断",
            workspacePath:"/tmp/workspace-a",
        });
        const secondRun = coordinator.submit({
            tenantId:"tenant-b",
            harnessSessionId:"session-b",
            userInput:"等待前一个 Runtime 退出",
            workspacePath:"/tmp/workspace-b",
        });

        const firstAttempt = coordinator.attemptNext();
        await runtime.waitForStartCount(1);
        await coordinator.interrupt(firstRun.id);

        expect(store.get(firstRun.id)?.status).toBe("INTERRUPTED");
        expect(scheduler.getCapacity(firstRun.tenantId).activeRunCount)
            .toBe(1);
        expect(await coordinator.attemptNext()).toEqual({ kind:"EMPTY" });

        runtime.releaseAllStarted();
        await firstAttempt;

        const secondAttempt = coordinator.attemptNext();
        await runtime.waitForStartCount(2);
        expect(runtime.startRequests.at(-1)?.run.runId).toBe(secondRun.id);
        runtime.releaseAllStarted();
        await secondAttempt;

        expect(scheduler.getCapacity(firstRun.tenantId).activeRunCount)
            .toBe(0);
    } finally {
        db.close();
    }
});
