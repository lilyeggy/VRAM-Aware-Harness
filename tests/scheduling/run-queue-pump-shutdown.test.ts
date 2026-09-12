import { expect, test } from "bun:test";

import { RunQueuePump } from "../../src/scheduling/run-queue-pump.ts";

/**
 * N20 回归：关闭时必须等在飞的 drain 落地。
 *
 * 根因：`stop()` 只清定时器（原注释也写明"不会强制中断当前已经开始的 drain"），
 * 而关闭顺序是 `application.stop()` → … → `database.close()`。于是一次在飞的
 * drain 会继续推进 Run、走到工作区快照写库，而此时 SQLite 已经关闭 →
 * `RangeError: Cannot use a closed database`（真机同实例日志 20 次）。
 *
 * 这里用"drain 期间访问一个被标记为已关闭的资源"来等价复现：只要关闭时
 * 没有等它落地，就会在关库之后仍被访问。
 */

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("N20：stopAndDrain 必须等在飞的 drain 结束才返回", async () => {
    let drained = false;
    let closed = false;
    const pump = new RunQueuePump({
        drain: async () => {
            await sleep(40);
            // 等价于"工作区快照写库"：关库之后不得再被触达。
            if (closed) {
                throw new Error("Cannot use a closed database");
            }
            drained = true;
            return [];
        },
    }, { intervalMs: 10 });

    const inFlight = pump.tick();
    // 模拟关闭流程：先停表并等待在飞 tick，再关库。
    await pump.stopAndDrain();
    closed = true;
    await inFlight;

    expect(drained).toBe(true);
    expect(closed).toBe(true);
});

test("N20：stopAndDrain 之后定时器不再触发新的 drain", async () => {
    let drains = 0;
    const pump = new RunQueuePump({
        drain: async () => {
            drains += 1;
            return [];
        },
    }, { intervalMs: 5 });

    pump.start();
    await sleep(30);
    const afterStart = drains;
    expect(afterStart).toBeGreaterThan(0);

    await pump.stopAndDrain();
    await sleep(40);
    // 停表之后不应再有新的 tick 进来（允许等于停表瞬间那一拍的计数）。
    expect(drains).toBeLessThanOrEqual(afterStart + 1);
});

test("N20：没有在飞 tick 时 stopAndDrain 立即返回（幂等、不阻塞）", async () => {
    const pump = new RunQueuePump({
        drain: async () => [],
    }, { intervalMs: 100 });

    const startedAt = Date.now();
    await pump.stopAndDrain();
    await pump.stopAndDrain();
    expect(Date.now() - startedAt).toBeLessThan(50);
});
