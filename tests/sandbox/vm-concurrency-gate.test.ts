import { describe, it, expect } from "bun:test";
import { Semaphore, KeyedSemaphore } from "../../src/sandbox/microvm/vm-concurrency-gate";

/**
 * 快照制作并发闸门的回归测试（P0）。
 *
 * ## 背景
 *
 * 多台 VM 同时首次启动且 kernel/rootfs 相同 → templateHash 相同 → 会**并发写
 * 同一个快照文件**，且各自 pause/resume 触发 vsock 断连重连。真机 10 并发下
 * 稳定复现"vsock agent 20s 未就绪"（两次分别 tenant-02 / tenant-04）；关闭
 * 快照后 10/10 通过，确认是快照路径的并发竞态。
 *
 * 这些用例确保闸门真的做到：同一模板串行、不同模板并行、许可不泄漏。
 */

describe("Semaphore: 串行化与许可管理", () => {
    it("并发上限为 1 时，任务严格串行执行（任意时刻至多 1 个在跑）", async () => {
        const gate = new Semaphore(1);
        let active = 0;
        let maxActive = 0;
        const order: number[] = [];

        await Promise.all(Array.from({ length: 10 }, (_, i) => gate.runExclusive(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, Math.random() * 5));
            order.push(i);
            active -= 1;
        })));

        expect(maxActive).toBe(1);
        expect(order.length).toBe(10);
    });

    it("并发上限为 N 时，峰值并发恰好不超过 N", async () => {
        const gate = new Semaphore(3);
        let active = 0;
        let maxActive = 0;

        await Promise.all(Array.from({ length: 20 }, () => gate.runExclusive(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, Math.random() * 8));
            active -= 1;
        })));

        expect(maxActive).toBeLessThanOrEqual(3);
        // 确实用上了并发（不是退化成串行 1）
        expect(maxActive).toBeGreaterThan(1);
    });

    it("临界区抛错时仍释放许可（否则会死锁后续所有等待者）", async () => {
        const gate = new Semaphore(1);
        await expect(gate.runExclusive(async () => {
            throw new Error("boom");
        })).rejects.toThrow("boom");

        // 关键：许可必须已归还，否则这里会永久挂起
        let acquired = false;
        await Promise.race([
            gate.runExclusive(async () => { acquired = true; }),
            new Promise((r) => setTimeout(r, 500)),
        ]);
        expect(acquired).toBe(true);
    });

    it("10 个等待者在前一个失败后仍全部获得许可（无许可泄漏）", async () => {
        const gate = new Semaphore(1);
        const done: number[] = [];

        const tasks = Array.from({ length: 10 }, (_, i) => gate.runExclusive(async () => {
            if (i === 0) throw new Error("first fails");
            done.push(i);
        }).catch(() => undefined));

        await Promise.all(tasks);
        expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("tryAcquire 非阻塞：拿不到许可时返回 false 而不排队", () => {
        const gate = new Semaphore(1);
        expect(gate.tryAcquire()).toBe(true);
        expect(gate.tryAcquire()).toBe(false);
        gate.release();
        expect(gate.tryAcquire()).toBe(true);
    });

    it("并发上限 0/负数被钳为 1（完全串行且不死锁）", async () => {
        // 关键回归：若 0 被当作"禁止进入"，acquire 会永久挂起、创建流程卡死。
        for (const limit of [0, -1]) {
            const gate = new Semaphore(limit);
            let active = 0;
            let maxActive = 0;
            const done: number[] = [];
            await Promise.all(Array.from({ length: 5 }, (_, i) => gate.runExclusive(async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((r) => setTimeout(r, 3));
                done.push(i);
                active -= 1;
            })));
            expect(maxActive).toBe(1);
            expect(done.length).toBe(5);
        }
    });

    it("KeyedSemaphore 同样把 limit<1 钳为 1，不死锁", async () => {
        const gate = new KeyedSemaphore<string>(0);
        let ran = 0;
        await Promise.all(Array.from({ length: 4 }, () =>
            gate.runExclusive("k", async () => { ran += 1; })));
        expect(ran).toBe(4);
    });
});

describe("KeyedSemaphore: 按模板隔离", () => {
    it("同一 key 串行（快照制作不会并发写同一文件）", async () => {
        const gate = new KeyedSemaphore<string>(1);
        let active = 0;
        let maxActive = 0;

        await Promise.all(Array.from({ length: 8 }, () =>
            gate.runExclusive("template-A", async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((r) => setTimeout(r, Math.random() * 5));
                active -= 1;
            })));

        expect(maxActive).toBe(1);
    });

    it("不同 key 互不阻塞（不同镜像模板可并行制作快照）", async () => {
        const gate = new KeyedSemaphore<string>(1);
        let active = 0;
        let maxActive = 0;

        await Promise.all(["tpl-A", "tpl-B", "tpl-C"].map((k) =>
            gate.runExclusive(k, async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((r) => setTimeout(r, 20));
                active -= 1;
            })));

        // 三个不同模板可同时进行
        expect(maxActive).toBeGreaterThan(1);
    });

    it("模拟真实场景：10 台 VM 同模板只允许 1 台真正制作快照", async () => {
        const gate = new KeyedSemaphore<string>(1);
        let actuallyCreated = 0;
        let snapshotReady = false;

        await Promise.all(Array.from({ length: 10 }, () =>
            gate.runExclusive("same-template", async () => {
                // 复查：已有快照则跳过（这正是驱动里的逻辑）
                if (snapshotReady) return;
                await new Promise((r) => setTimeout(r, 10));
                snapshotReady = true;
                actuallyCreated += 1;
            })));

        // 只有一台真的做了快照，其余 9 台复用 —— 无并发写同一文件
        expect(actuallyCreated).toBe(1);
    });

    it("key 的闸门相互独立，一处失败不影响其他 key", async () => {
        const gate = new KeyedSemaphore<string>(1);
        const ok: string[] = [];

        await Promise.all([
            gate.runExclusive("bad", async () => { throw new Error("bad key"); }).catch(() => undefined),
            gate.runExclusive("good", async () => { ok.push("done"); }),
        ]);

        expect(ok).toEqual(["done"]);
    });

    it("size 反映已跟踪的 key 数（运维观测用）", () => {
        const gate = new KeyedSemaphore<string>(1);
        expect(gate.size).toBe(0);
        void gate.runExclusive("k1", async () => undefined);
        expect(gate.size).toBe(1);
    });
});
