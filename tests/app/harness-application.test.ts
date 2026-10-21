import { expect, test } from "bun:test";

import type {
    Checkpoint,
} from "../../src/checkpoints/checkpoint.ts";
import {
    HarnessApplication,
    type StartupRecoveryCoordinator,
} from "../../src/app/harness-application.ts";
import { RunService } from "../../src/runs/run-service.ts";
import type {
    AgentRun,
} from "../../src/runs/agent-run.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import {
    RunScheduler,
} from "../../src/scheduling/run-scheduler.ts";
import {
    TenantRunScheduler,
} from "../../src/scheduling/tenant-run-scheduler.ts";
import {
    openHarnessDatabase,
} from "../../src/storage/database.ts";
import {
    FakeAgentRuntime,
} from "../fakes/fake-agent-runtime.ts";

function createDeferred(): {
    promise: Promise<void>;
    resolve: () => void;
} {
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });

    return {
        promise,
        resolve: resolvePromise,
    };
}

function createApplication(
    startupRecovery: StartupRecoveryCoordinator,
    lifecycleEvents: string[] = [],
) {
    const db = openHarnessDatabase(":memory:");
    const runStore = new RunStore(db);
    const runtime = new FakeAgentRuntime();
    const runService = new RunService(runStore, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const coordinator = new RunScheduler(
        runService,
        scheduler,
    );
    const queuePump = {
        start() {
            lifecycleEvents.push("pump:drain");
            void coordinator.drain();
        },
        stop() {},
        async stopAndDrain() {},
        async tick() {
            lifecycleEvents.push("pump:drain");
            await coordinator.drain();
        },
    };
    const application = new HarnessApplication(
        coordinator,
        queuePump,
        runStore,
        scheduler,
        startupRecovery,
    );

    return {
        application,
        db,
        queuePump,
        runStore,
        runtime,
        scheduler,
    };
}

test("start 在恢复完成后才启动 QueuePump", async () => {
    const lifecycleEvents: string[] = [];
    const recoveryBarrier = createDeferred();
    const startupRecovery: StartupRecoveryCoordinator = {
        async recover() {
            lifecycleEvents.push("recovery:start");
            await recoveryBarrier.promise;
            lifecycleEvents.push("recovery:end");
        },
    };
    const { application, db } = createApplication(
        startupRecovery,
        lifecycleEvents,
    );

    try {
        const startPromise = application.start();

        expect(application.isStarted()).toBe(false);
        expect(lifecycleEvents).toEqual(["recovery:start"]);

        recoveryBarrier.resolve();
        await startPromise;

        expect(application.isStarted()).toBe(true);
        expect(lifecycleEvents).toEqual([
            "recovery:start",
            "recovery:end",
            "pump:drain",
        ]);
    } finally {
        await application.stop();
        db.close();
    }
});

test("并发 start 调用复用同一个恢复流程", async () => {
    let recoverCallCount = 0;
    const recoveryBarrier = createDeferred();
    const startupRecovery: StartupRecoveryCoordinator = {
        async recover() {
            recoverCallCount += 1;
            await recoveryBarrier.promise;
        },
    };
    const { application, db } = createApplication(startupRecovery);

    try {
        const firstStart = application.start();
        const secondStart = application.start();

        expect(secondStart).toBe(firstStart);
        expect(recoverCallCount).toBe(1);

        recoveryBarrier.resolve();
        await firstStart;

        await application.start();
        expect(recoverCallCount).toBe(1);
    } finally {
        await application.stop();
        db.close();
    }
});

test("恢复失败时不启动 Pump，并允许再次启动", async () => {
    const lifecycleEvents: string[] = [];
    let recoverCallCount = 0;
    const startupRecovery: StartupRecoveryCoordinator = {
        async recover() {
            recoverCallCount += 1;

            if (recoverCallCount === 1) {
                throw new Error("恢复初始化失败");
            }
        },
    };
    const { application, db } = createApplication(
        startupRecovery,
        lifecycleEvents,
    );

    try {
        await expect(application.start()).rejects.toThrow(
            "恢复初始化失败",
        );

        expect(application.isStarted()).toBe(false);
        expect(lifecycleEvents).toEqual([]);

        await application.start();

        expect(application.isStarted()).toBe(true);
        expect(recoverCallCount).toBe(2);
        expect(lifecycleEvents).toEqual(["pump:drain"]);
    } finally {
        await application.stop();
        db.close();
    }
});

test("stop 幂等停止 Pump，停止后可以重新启动", async () => {
    let recoverCallCount = 0;
    const startupRecovery: StartupRecoveryCoordinator = {
        async recover() {
            recoverCallCount += 1;
        },
    };
    const lifecycleEvents: string[] = [];
    const { application, db } = createApplication(
        startupRecovery,
        lifecycleEvents,
    );

    try {
        await application.start();
        await application.stop();
        await application.stop();

        expect(application.isStarted()).toBe(false);

        await application.start();

        expect(application.isStarted()).toBe(true);
        expect(recoverCallCount).toBe(2);
        expect(lifecycleEvents).toEqual([
            "pump:drain",
            "pump:drain",
        ]);
    } finally {
        await application.stop();
        db.close();
    }
});

test("submitRun 只在应用启动后接收任务，并立即触发调度", async () => {
    const lifecycleEvents: string[] = [];
    const { application, db, queuePump, runtime } = createApplication(
        { async recover() {} },
        lifecycleEvents,
    );
    const input = {
        tenantId: "tenant-a",
        harnessSessionId: "session-a",
        userInput: "完成 Day7 演示任务",
        workspacePath: "/workspace/demo",
    };

    try {
        expect(() => application.submitRun(input)).toThrow(
            "HarnessApplication尚未启动",
        );

        await application.start();
        const drainsBeforeSubmit = lifecycleEvents.length;
        const submittedRun = application.submitRun(input);

        expect(submittedRun.status).toBe("QUEUED");
        expect(lifecycleEvents.length).toBe(drainsBeforeSubmit + 1);

        await queuePump.tick();

        expect(application.getRun(submittedRun.id)?.status).toBe(
            "COMPLETED",
        );
        expect(runtime.startRequests).toHaveLength(1);
        expect(runtime.startRequests[0]?.run.runId).toBe(submittedRun.id);
    } finally {
        await application.stop();
        db.close();
    }
});

test("应用门面统一查询 Run、事件、队列与容量", async () => {
    const { application, db, queuePump, runtime } = createApplication(
        { async recover() {} },
    );

    try {
        await application.start();
        const run = application.submitRun({
            tenantId: "tenant-b",
            harnessSessionId: "session-b",
            userInput: "查询门面",
            workspacePath: "/workspace/demo",
        });

        await queuePump.tick();

        expect(runtime.startRequests).toHaveLength(1);
        expect(application.getRun(run.id)?.status).toBe("COMPLETED");
        expect(application.getRunEvents(run.id).map((event) => event.type))
            .toContain("RUN_CREATED");
        expect(application.getQueue()).toEqual([]);
        expect(application.getTenantCapacity("tenant-b")).toEqual({
            activeRunCount: 0,
            activeTenantRunCount: 0,
        });
        expect(application.getRun("missing-run")).toBeNull();
        expect(application.getRunEvents("missing-run")).toEqual([]);
    } finally {
        await application.stop();
        db.close();
    }
});

test("resumeRun 将中断任务提交到统一调度链并立即推进", async () => {
    const lifecycleEvents: string[] = [];
    const { application, db, queuePump, runStore, runtime } =
        createApplication(
            { async recover() {} },
            lifecycleEvents,
        );
    const timestamp = new Date().toISOString();
    const checkpoint: Checkpoint = {
        id: "checkpoint-app-resume",
        runId: "run-app-resume",
        toolExecutionId: "tool-app-resume",
        runtimeSessionRef: "/tmp/app-resume.jsonl",
        lastEventSequence: 1,
        createdAt: timestamp,
    };
    const interruptedRun: AgentRun = {
        id: checkpoint.runId,
        tenantId: "tenant-resume",
        harnessSessionId: "session-resume",
        status: "INTERRUPTED",
        userInput: "恢复应用层任务",
        workspacePath: "/workspace/resume",
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        finishedAt: null,
        checkpointId: checkpoint.id,
        failureReason: null,
    };

    try {
        runStore.create(interruptedRun, {
            eventId: "event-app-resume-interrupted",
            runId: interruptedRun.id,
            sequence: 1,
            type: "RUN_INTERRUPTED",
            timestamp,
            payloadVersion: 1,
            payload: { reason: "PROCESS_RESTART" },
        });

        expect(() => application.resumeRun({
            runId: interruptedRun.id,
            checkpoint,
            continuationInput: "继续执行",
        })).toThrow("HarnessApplication尚未启动");

        await application.start();
        const drainsBeforeResume = lifecycleEvents.length;
        const queuedRun = application.resumeRun({
            runId: interruptedRun.id,
            checkpoint,
            continuationInput: "继续执行",
        });

        expect(queuedRun.status).toBe("QUEUED");
        expect(lifecycleEvents.length).toBe(drainsBeforeResume + 1);

        await queuePump.tick();

        expect(application.getRun(interruptedRun.id)?.status).toBe(
            "COMPLETED",
        );
        expect(runtime.startRequests).toEqual([]);
        expect(runtime.resumeRequests).toHaveLength(1);
        expect(runtime.resumeRequests[0]?.checkpoint.checkpointId).toBe(
            checkpoint.id,
        );
    } finally {
        await application.stop();
        db.close();
    }
});
