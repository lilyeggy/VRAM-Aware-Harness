import { expect, test } from "bun:test";

import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import type { RuntimeStartRequest } from "../../src/runtime/agent-runtime.ts";
import { RunScheduler } from "../../src/scheduling/run-scheduler.ts";
import { TenantRunScheduler } from "../../src/scheduling/tenant-run-scheduler.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";

/**
 * 支柱 3 一级防线：排队 TTL。
 *
 * 第二道资源门禁删除后，排队只可能由宿主层硬约束产生：全局/租户并发上限、
 * 会话锁。这里用「占满唯一 slot 的阻塞 Run」制造真实排队。
 */
class GatedRuntime extends FakeAgentRuntime {
    private readonly releases: Array<() => void> = [];

    override async start(request: RuntimeStartRequest): Promise<void> {
        await new Promise<void>((resolve) => {
            this.releases.push(resolve);
        });
        await super.start(request);
    }

    releaseAll(): void {
        for (const release of this.releases.splice(0)) {
            release();
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunning(store: RunStore, runId: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (store.get(runId)?.status === "RUNNING") {
            return;
        }
        await sleep(2);
    }
    throw new Error(`Run 未进入 RUNNING：${runId}`);
}

test("排队超过 TTL 的 Run 被熔断为 FAILED(QUEUE_TIMEOUT) 并释放队列计数", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new GatedRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const coordinator = new RunScheduler(runService, scheduler, {
        queueTtlMs: 20,
    });

    const blocker = coordinator.submit({
        tenantId: "tenant-block",
        harnessSessionId: "session-block",
        userInput: "占住唯一 slot",
        workspacePath: "/tmp/ws-block",
    });
    const blockerAttempt = coordinator.attemptNext();
    await waitForRunning(store, blocker.id);

    const run = coordinator.submit({
        tenantId: "tenant-a",
        harnessSessionId: "session-a",
        userInput: "长时间等待的任务",
        workspacePath: "/tmp/ws-a",
    });

    await coordinator.drain();
    expect(store.get(run.id)?.status).toBe("QUEUED");
    expect(scheduler.listQueue()).toHaveLength(1);
    expect(scheduler.listQueueBlockers()[0]?.reasonCode).toBe(
        "GLOBAL_CONCURRENCY_LIMIT",
    );

    await sleep(60);
    await coordinator.drain();

    const failed = store.get(run.id);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.failureReason).toBe("QUEUE_TIMEOUT");
    expect(failed?.finishedAt).not.toBeNull();

    const failedEvent = store
        .listEvents(run.id)
        .find((event) => event.type === "RUN_FAILED");
    if (failedEvent === undefined) {
        throw new Error("缺少 RUN_FAILED 事件");
    }
    const payload = failedEvent.payload as { reason: string; waitedMs: number };
    expect(payload.reason).toBe("QUEUE_TIMEOUT");
    expect(payload.waitedMs).toBeGreaterThan(20);

    expect(scheduler.listQueue()).toHaveLength(0);
    // tenant-a 自己的活跃计数必须归零（全局 1 个 slot 仍被 blocker 占着）。
    expect(scheduler.getCapacity("tenant-a").activeTenantRunCount).toBe(0);

    runtime.releaseAll();
    await blockerAttempt;
    db.close();
});

test("未超 TTL 的排队 Run 不受影响", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new GatedRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 1,
        maxActiveRunsPerTenant: 1,
    });
    const coordinator = new RunScheduler(runService, scheduler, {
        queueTtlMs: 60_000,
    });

    const blocker = coordinator.submit({
        tenantId: "tenant-block",
        harnessSessionId: "session-block",
        userInput: "占住唯一 slot",
        workspacePath: "/tmp/ws-block",
    });
    const blockerAttempt = coordinator.attemptNext();
    await waitForRunning(store, blocker.id);

    const queued = coordinator.submit({
        tenantId: "tenant-b",
        harnessSessionId: "session-b",
        userInput: "还在 TTL 内的任务",
        workspacePath: "/tmp/ws-b",
    });
    await coordinator.drain();

    expect(scheduler.listQueue()).toHaveLength(1);
    expect(scheduler.listQueueBlockers()[0]?.runId).toBe(queued.id);
    expect(scheduler.listQueueBlockers()[0]?.reasonCode).toBe(
        "GLOBAL_CONCURRENCY_LIMIT",
    );
    expect(store.get(queued.id)?.status).toBe("QUEUED");

    runtime.releaseAll();
    await blockerAttempt;
    db.close();
});

test("会话锁等待不计入 Queue TTL", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new GatedRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new TenantRunScheduler({
        maxActiveRuns: 4,
        maxActiveRunsPerTenant: 4,
    });
    const coordinator = new RunScheduler(runService, scheduler, {
        queueTtlMs: 20,
    });

    const first = coordinator.submit({
        tenantId: "tenant-a",
        harnessSessionId: "session-shared",
        userInput: "会话里的第一条",
        workspacePath: "/tmp/ws-a",
    });
    const firstAttempt = coordinator.attemptNext();
    await waitForRunning(store, first.id);

    const followUp = coordinator.submit({
        tenantId: "tenant-a",
        harnessSessionId: "session-shared",
        userInput: "同一会话的追问",
        workspacePath: "/tmp/ws-a",
    });

    await sleep(60);
    await coordinator.drain();

    expect(store.get(followUp.id)?.status).toBe("QUEUED");
    expect(scheduler.listQueueBlockers()[0]?.reasonCode).toBe(
        "SESSION_SERIALIZATION",
    );

    runtime.releaseAll();
    await firstAttempt;
    db.close();
});

test("RunService.failQueuedRun 只熔断 QUEUED Run，终态幂等返回 null", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runService = new RunService(store, new FakeAgentRuntime());

    const run = runService.createQueuedRun({
        tenantId: "tenant-c",
        harnessSessionId: "session-c",
        userInput: "直接熔断",
        workspacePath: "/tmp/ws-c",
    });

    const failed = runService.failQueuedRun(run.id, "QUEUE_TIMEOUT");
    expect(failed?.status).toBe("FAILED");
    expect(failed?.failureReason).toBe("QUEUE_TIMEOUT");

    expect(runService.failQueuedRun(run.id, "QUEUE_TIMEOUT")).toBeNull();
    const failedEvents = store
        .listEvents(run.id)
        .filter((event) => event.type === "RUN_FAILED");
    expect(failedEvents).toHaveLength(1);
    db.close();
});
