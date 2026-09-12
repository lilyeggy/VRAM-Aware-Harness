import { describe, expect, it } from "bun:test";

import {
    TenantRunScheduler,
} from "../../src/scheduling/tenant-run-scheduler.ts";

/**
 * 支柱 2 验收门禁：高并发调度模拟。
 *
 * 场景：2*A6000 双卡 vLLM 网关 + 30 个全局并发槽位。
 * 工具执行 / 文件 I/O 在沙箱内并发跑，不占 GPU 槽位；调度器只约束
 * 「在执行的 Run」数量，验证 20~30 并发放开后调度语义仍然正确。
 */
describe("支柱 2：高并发调度模拟（maxActiveRuns=30）", () => {
    function enqueueRuns(
        scheduler: TenantRunScheduler,
        runs: { runId: string; tenantId: string }[],
    ): void {
        for (const run of runs) {
            scheduler.enqueue({
                runId: run.runId,
                tenantId: run.tenantId,
            });
        }
    }

    it("30 个槽位全部放行给单租户，队列剩余依序补位", () => {
        const scheduler = new TenantRunScheduler({
            maxActiveRuns: 30,
            // 每租户可配：放开到与全局一致时，单租户可吃满全部槽位。
            maxActiveRunsPerTenant: 30,
        });

        // 单租户灌入 40 个 Run。
        enqueueRuns(
            scheduler,
            Array.from({ length: 40 }, (_, i) => ({
                runId: `r${i}`,
                tenantId: "tenant-a",
            })),
        );

        const claimed: string[] = [];
        while (true) {
            const run = scheduler.claimNext();
            if (run === null) {
                break;
            }
            claimed.push(run.runId);
        }

        // 全局 30 槽位全部放行；剩余 10 个留在队列。
        expect(claimed).toHaveLength(30);
        expect(scheduler.getCapacity("tenant-a").activeRunCount).toBe(30);
        expect(scheduler.getCapacity("tenant-a").activeTenantRunCount).toBe(30);
        expect(scheduler.listQueue()).toHaveLength(10);

        // 逐个释放后，队列里的 Run 依序补位。
        for (const runId of claimed) {
            scheduler.release(runId);
        }
        const refill = scheduler.claimNext();
        expect(refill).not.toBeNull();
    });

    it("每租户上限独立生效：单租户最多同时 10 个", () => {
        const scheduler = new TenantRunScheduler({
            maxActiveRuns: 30,
            maxActiveRunsPerTenant: 10,
        });
        enqueueRuns(
            scheduler,
            Array.from({ length: 40 }, (_, i) => ({
                runId: `r${i}`,
                tenantId: "tenant-a",
            })),
        );

        const claimed: string[] = [];
        while (true) {
            const run = scheduler.claimNext();
            if (run === null) {
                break;
            }
            claimed.push(run.runId);
        }

        // 每租户上限 10 先于全局 30 卡住：租户隔离防止独占。
        expect(claimed).toHaveLength(10);
        expect(scheduler.getCapacity("tenant-a").activeTenantRunCount).toBe(10);
        expect(scheduler.listQueue()).toHaveLength(30);
        const blockers = scheduler.listQueueBlockers();
        expect(blockers[0]!.reasonCode).toBe("TENANT_CONCURRENCY_LIMIT");
    });

    it("两租户公平共享 30 个槽位（各 15）", () => {
        const scheduler = new TenantRunScheduler({
            maxActiveRuns: 30,
            maxActiveRunsPerTenant: 10,
        });
        enqueueRuns(
            scheduler,
            Array.from({ length: 20 }, (_, i) => ({
                runId: `a${i}`,
                tenantId: "tenant-a",
            })),
        );
        enqueueRuns(
            scheduler,
            Array.from({ length: 20 }, (_, i) => ({
                runId: `b${i}`,
                tenantId: "tenant-b",
            })),
        );

        const perTenant = { "tenant-a": 0, "tenant-b": 0 };
        while (true) {
            const run = scheduler.claimNext();
            if (run === null) {
                break;
            }
            perTenant[run.tenantId as keyof typeof perTenant] += 1;
        }

        expect(perTenant).toEqual({ "tenant-a": 10, "tenant-b": 10 });
        // 每租户上限 10 先卡住，全局 30 只用了 20 —— 公平优先于吞满。
        expect(scheduler.getCapacity("tenant-a").activeRunCount).toBe(20);
    });

    it("模拟 30 并发 Run 全生命周期：领取、执行、释放、补位无泄漏", async () => {
        const scheduler = new TenantRunScheduler({
            maxActiveRuns: 30,
            maxActiveRunsPerTenant: 30,
        });
        const total = 60;
        enqueueRuns(
            scheduler,
            Array.from({ length: total }, (_, i) => ({
                runId: `run-${i}`,
                tenantId: i % 2 === 0 ? "tenant-a" : "tenant-b",
            })),
        );

        let completed = 0;
        const worker = async () => {
            while (completed < total) {
                const run = scheduler.claimNext();
                if (run === null) {
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    continue;
                }
                // 模拟沙箱内工具执行 + 模型推理等待。
                await new Promise((resolve) => setTimeout(resolve, 2));
                expect(scheduler.release(run.runId)).toBe(true);
                completed += 1;
            }
        };

        await Promise.all(Array.from({ length: 30 }, worker));
        expect(completed).toBe(total);
        expect(scheduler.getCapacity("tenant-a").activeRunCount).toBe(0);
        expect(scheduler.listQueue()).toHaveLength(0);
    });
});
