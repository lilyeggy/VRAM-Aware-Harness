import { describe, expect, test } from "bun:test";

import { InstanceSlotUnavailableError } from "../../src/instances/harness-instance-store.ts";
import { RunQueueCoordinator } from "../../src/scheduling/run-queue-coordinator.ts";
import { TenantRunScheduler } from "../../src/scheduling/tenant-run-scheduler.ts";
import type { AgentRun } from "../../src/runs/agent-run.ts";

/**
 * N2 回归：控制面 kill -9 后重启对账窗口，实例行 actual_state 尚未就绪时
 * acquireRun 抛 InstanceSlotUnavailableError。协调器必须把它识别为瞬态：
 * Run 重新入队（下一轮 pump 重试）并返回 DEFERRED，而不是把异常抛进
 * pump 的 onError 打满日志。
 */

function makeRun(runId: string): AgentRun {
    return {
        id: runId,
        tenantId: "tenant-a",
        harnessSessionId: "sess-n2",
        status: "QUEUED",
        userInput: "n2 slot test",
        workspacePath: "/tmp/n2-ws",
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
    } as unknown as AgentRun;
}

class NotReadyRunService {
    calls = 0;
    async executeQueuedRun(_runId: string): Promise<AgentRun> {
        this.calls += 1;
        throw new InstanceSlotUnavailableError("default-pi-instance:test");
    }
    recordQueueBlocked(): void {}
}

describe("N2：实例未就绪是瞬态，重新入队而非抛错", () => {
    test("slot 不可用 → DEFERRED + Run 回队列，下轮可再次尝试", async () => {
        const scheduler = new TenantRunScheduler({
            maxActiveRuns: 4,
            maxActiveRunsPerTenant: 2,
        });
        const service = new NotReadyRunService();
        const coordinator = new RunQueueCoordinator(
            service as never,
            scheduler,
            {
                evaluate: async () => ({
                    decision: { action: "EXECUTE", reason: "准入通过" },
                }),
            } as never,
        );

        scheduler.enqueue({
            runId: "run-n2-1",
            tenantId: "tenant-a",
            sessionId: "sess-n2",
        });

        const result = await coordinator.attemptNext();
        expect(result.kind).toBe("DEFERRED");

        // Run 回到内存队列，下一轮 pump 还能拿到它
        const queued = scheduler.listQueue();
        expect(queued).toHaveLength(1);
        expect(queued[0]!.runId).toBe("run-n2-1");
        expect(queued[0]!.reasonCode).toBe("INSTANCE_NOT_READY");
        expect(service.calls).toBe(1);
    });
});

/**
 * N19 回归：INSTANCE_NOT_READY 的重排必须有上限。
 *
 * 该状态本意是"启动对账窗口的瞬态"（N2）。但实例槽位若**结构性**不可用
 * （上次进程执行中被杀 → 实例停在 FAILED + active_run_count=1），无界重排
 * 会变成 INTERRUPTED↔QUEUED 活锁，而且每一轮失败的 RESUME 都真实
 * 创建/销毁一个沙箱（真机实测泄漏 2 个 agent-harness-* 容器）。
 */
describe("N19：INSTANCE_NOT_READY 重排有上限，超过即转人工", () => {
    test("超过上限后不再重新入队，避免活锁与沙箱 churn", async () => {
        const scheduler = new TenantRunScheduler({
            maxActiveRuns: 4,
            maxActiveRunsPerTenant: 2,
        });
        const service = new NotReadyRunService();
        const coordinator = new RunQueueCoordinator(
            service as never,
            scheduler,
            {
                evaluate: async () => ({
                    decision: { action: "EXECUTE", reason: "准入通过" },
                }),
            } as never,
            undefined,
            undefined,
            undefined,
            undefined,
            { maxInstanceNotReadyRetries: 2 },
        );

        scheduler.enqueue({
            runId: "run-n19-1",
            tenantId: "tenant-a",
            sessionId: "sess-n19",
        });

        // 第 1、2 次：瞬态失败，重新入队等下一轮。
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const result = await coordinator.attemptNext();
            expect(result.kind).toBe("DEFERRED");
            expect(scheduler.listQueue()).toHaveLength(1);
        }

        // 第 3 次：超过上限（2），停止重排——Run 不再回到队列。
        const exhausted = await coordinator.attemptNext();
        expect(exhausted.kind).toBe("DEFERRED");
        expect(scheduler.listQueue()).toHaveLength(0);

        // 底层的启动尝试次数必须是 3，证明确实尝试过而不是被提前丢弃。
        expect(service.calls).toBe(3);
    });

    test("默认上限为 5：第 6 次才停止重排", async () => {
        const scheduler = new TenantRunScheduler({
            maxActiveRuns: 4,
            maxActiveRunsPerTenant: 2,
        });
        const service = new NotReadyRunService();
        const coordinator = new RunQueueCoordinator(
            service as never,
            scheduler,
            {
                evaluate: async () => ({
                    decision: { action: "EXECUTE", reason: "准入通过" },
                }),
            } as never,
        );

        scheduler.enqueue({
            runId: "run-n19-2",
            tenantId: "tenant-a",
            sessionId: "sess-n19b",
        });

        for (let attempt = 1; attempt <= 5; attempt += 1) {
            await coordinator.attemptNext();
            expect(scheduler.listQueue()).toHaveLength(1);
        }

        await coordinator.attemptNext();
        expect(scheduler.listQueue()).toHaveLength(0);
        expect(service.calls).toBe(6);
    });
});
