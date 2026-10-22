import { expect, test } from "bun:test";

import { ConcurrencyLimiter } from "../../src/llm-gateway/concurrency-limiter.ts";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("并发上限：同时在跑的 acquire 不超过 limit，其余排队后全部完成", async () => {
    const limiter = new ConcurrencyLimiter(3);
    let inflight = 0;
    let peak = 0;
    let completed = 0;

    const jobs = Array.from({ length: 9 }, async () => {
        const release = await limiter.acquire();
        inflight += 1;
        peak = Math.max(peak, inflight);
        await sleep(5);
        inflight -= 1;
        completed += 1;
        release();
    });

    await Promise.all(jobs);

    expect(peak).toBeLessThanOrEqual(3);
    expect(completed).toBe(9);

    const stats = limiter.stats();
    expect(stats.acquired).toBe(9);
    expect(stats.inflight).toBe(0);
    expect(stats.waiting).toBe(0);
});

test("release 幂等：重复释放不会放大并发", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();

    expect(limiter.stats().inflight).toBe(1);
    release();
    release();
    expect(limiter.stats().inflight).toBe(0);

    const second = await limiter.acquire();
    expect(limiter.stats().inflight).toBe(1);
    second();
});

test("排队是 FIFO：先到先得", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];

    const first = await limiter.acquire();

    const queued = [1, 2, 3].map(async (index) => {
        const release = await limiter.acquire();
        order.push(index);
        release();
    });

    await sleep(1);
    first();
    await Promise.all(queued);

    expect(order).toEqual([1, 2, 3]);
});
