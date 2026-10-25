import { expect, test } from "bun:test";

import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import type {
    AgentRuntime,
    RuntimeEventHandler,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "../../src/runtime/agent-runtime.ts";
import { RunScheduler } from "../../src/scheduling/run-scheduler.ts";
import { UserRunScheduler } from "../../src/scheduling/user-run-scheduler.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

/**
 * 受控 Runtime：每次 start 都挂起，直到测试显式 release(runId)。
 * 用来制造"批内最慢的 Run 一直不结束"，验证 slot 是否能提前补位。
 */
class ControlledRuntime implements AgentRuntime {
    readonly startedRunIds: string[] = [];
    private readonly releases = new Map<string, () => void>();

    start(request: RuntimeStartRequest): Promise<void> {
        this.startedRunIds.push(request.run.runId);
        return new Promise<void>((resolve) => {
            this.releases.set(request.run.runId, resolve);
        });
    }

    resume(request: RuntimeResumeRequest): Promise<void> {
        return this.start({ run: request.run, input: request.continuationInput });
    }

    async interrupt(): Promise<void> {}

    subscribe(_runId: string, _handler: RuntimeEventHandler): () => void {
        return () => {};
    }

    release(runId: string): void {
        const release = this.releases.get(runId);
        if (release !== undefined) {
            this.releases.delete(runId);
            release();
        }
    }

    hasStarted(runId: string): boolean {
        return this.startedRunIds.includes(runId);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("slot 释放后立即补位，不被批内最慢的 Run 拖住", async () => {
    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new ControlledRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new UserRunScheduler({
        maxActiveRuns: 2,
        maxActiveRunsPerUser: 2,
    });
    const coordinator = new RunScheduler(runService, scheduler);

    const fast = coordinator.submit({
        userId: "user-a",
        harnessSessionId: "session-fast",
        userInput: "快任务",
        workspacePath: "/tmp/ws-fast",
    });
    const slow = coordinator.submit({
        userId: "user-a",
        harnessSessionId: "session-slow",
        userInput: "慢任务",
        workspacePath: "/tmp/ws-slow",
    });
    const waiting = coordinator.submit({
        userId: "user-a",
        harnessSessionId: "session-waiting",
        userInput: "排队任务",
        workspacePath: "/tmp/ws-waiting",
    });

    const drainPromise = coordinator.drain();

    // 两个 slot 都被占住
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (runtime.hasStarted(fast.id) && runtime.hasStarted(slow.id)) break;
        await sleep(2);
    }
    expect(runtime.hasStarted(fast.id)).toBe(true);
    expect(runtime.hasStarted(slow.id)).toBe(true);
    expect(runtime.hasStarted(waiting.id)).toBe(false);

    // 只释放快的那个；慢的仍然占着 slot。
    runtime.release(fast.id);

    let refilled = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
        if (runtime.hasStarted(waiting.id)) {
            refilled = true;
            break;
        }
        await sleep(5);
    }

    expect(refilled).toBe(true);
    // 慢任务仍然在跑，说明补位确实发生在批次结束之前。
    expect(store.get(slow.id)?.status).toBe("RUNNING");

    runtime.release(slow.id);
    runtime.release(waiting.id);
    await drainPromise;
    db.close();
});
