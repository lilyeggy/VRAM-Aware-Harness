import { expect, test } from "bun:test";

import { HarnessApplication } from "../../src/app/harness-application.ts";
import type { PolicyDecisionStore } from "../../src/resources/policy-decision-store.ts";
import type { ResourceObserver } from "../../src/resources/resource-observer.ts";
import type { AgentRun, RunEvent } from "../../src/runs/agent-run.ts";
import type { RunQueueCoordinator } from "../../src/scheduling/run-queue-coordinator.ts";
import type { RunQueuePump } from "../../src/scheduling/run-queue-pump.ts";
import type { TenantRunScheduler } from "../../src/scheduling/tenant-run-scheduler.ts";
import type { RunStore } from "../../src/runs/runstore.ts";
import type { ToolExecution } from "../../src/tools/tool-execution.ts";

const TIMESTAMP = "2026-09-11T00:00:00.000Z";

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id: "run-1",
        tenantId: "tenant-1",
        harnessSessionId: "session-1",
        status: "INTERRUPTED",
        userInput: "清理临时文件",
        workspacePath: "/tmp/ws",
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        startedAt: TIMESTAMP,
        finishedAt: null,
        checkpointId: null,
        failureReason: null,
        ...overrides,
    };
}

function makePrepared(overrides: Partial<ToolExecution> = {}): ToolExecution {
    return {
        id: "tool-exec-1",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: { command: "rm -rf /tmp/scratch" },
        effect: "UNKNOWN_EFFECT",
        status: "PREPARED",
        result: null,
        errorMessage: null,
        createdAt: TIMESTAMP,
        finishedAt: null,
        ...overrides,
    };
}

function makeApp(run: AgentRun, prepared: readonly ToolExecution[]) {
    const store = {
        current: run as AgentRun | null,
        events: [] as RunEvent[],
        updates: [] as AgentRun[],
        get(runId: string) {
            return this.current !== null && this.current.id === runId ? this.current : null;
        },
        getLastEventSequence() {
            return 7;
        },
        update(next: AgentRun, event: RunEvent) {
            this.updates.push(next);
            this.events.push(event);
            this.current = next;
        },
        appendEvent(event: RunEvent) {
            this.events.push(event);
        },
    };
    const failed: ToolExecution[] = [];
    const toolExecutions = {
        listPreparedForRun: (runId: string) =>
            prepared.filter((execution) => execution.runId === runId),
        fail: (execution: ToolExecution) => {
            failed.push(execution);
        },
    };

    const app = new HarnessApplication(
        {} as unknown as RunQueueCoordinator,
        {} as unknown as RunQueuePump,
        store as unknown as RunStore,
        {} as unknown as PolicyDecisionStore,
        {} as unknown as TenantRunScheduler,
        {} as unknown as ResourceObserver,
        { async recover() {} },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        toolExecutions,
    );

    return { app, store, failed };
}

test("N16：确认无副作用 → 作废 PREPARED 执行，Run 仍可恢复", () => {
    const { app, store, failed } = makeApp(makeRun(), [makePrepared()]);

    const result = app.resolveUnknownEffect("run-1", {
        resolution: "NO_EFFECT",
        note: "人工核对：目标目录未创建",
        actor: "tenant-1",
    });

    expect(result.resolvedExecutionIds).toEqual(["tool-exec-1"]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.status).toBe("FAILED");
    expect(failed[0]!.errorMessage).toContain("确认无副作用");
    expect(failed[0]!.finishedAt).not.toBeNull();

    // 状态未变（仍 INTERRUPTED，可继续走既有 /resume），只追加消解事件。
    expect(result.run.status).toBe("INTERRUPTED");
    expect(store.updates).toHaveLength(0);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]!.type).toBe("MANUAL_REVIEW_RESOLVED");
    expect(store.events[0]!.sequence).toBe(8);
});

test("N16：确认副作用已发生 → 作废执行并把 Run 明确终结为 FAILED", () => {
    const { app, store, failed } = makeApp(makeRun(), [makePrepared()]);

    const result = app.resolveUnknownEffect("run-1", {
        resolution: "EFFECT_OCCURRED",
        actor: "tenant-1",
    });

    expect(failed[0]!.errorMessage).toContain("副作用已发生");
    expect(result.run.status).toBe("FAILED");
    expect(result.run.failureReason).toContain("副作用已发生");
    expect(result.run.finishedAt).not.toBeNull();
    expect(store.updates).toHaveLength(1);
    expect(store.events[0]!.type).toBe("RUN_FAILED");
});

test("N16：非 INTERRUPTED 的 Run 拒绝人工消解", () => {
    const { app } = makeApp(makeRun({ status: "RUNNING" }), [makePrepared()]);

    expect(() => app.resolveUnknownEffect("run-1", {
        resolution: "NO_EFFECT",
        actor: "tenant-1",
    })).toThrow("只有 INTERRUPTED");
});

test("N16：没有待核对的不确定副作用时拒绝消解", () => {
    const { app } = makeApp(makeRun(), []);

    expect(() => app.resolveUnknownEffect("run-1", {
        resolution: "NO_EFFECT",
        actor: "tenant-1",
    })).toThrow("没有待人工核对");
});

test("N16：未装配工具执行库时读数为空（不伪装成已装配）", () => {
    const app = new HarnessApplication(
        {} as unknown as RunQueueCoordinator,
        {} as unknown as RunQueuePump,
        {} as unknown as RunStore,
        {} as unknown as PolicyDecisionStore,
        {} as unknown as TenantRunScheduler,
        {} as unknown as ResourceObserver,
        { async recover() {} },
    );

    expect(app.getRunUnknownEffects("run-1")).toEqual([]);
});
