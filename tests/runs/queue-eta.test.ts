import { expect, test } from "bun:test";

import { estimateWaitMs } from "../../src/runs/queue-eta.ts";

test("按近期完成速率把队列位置换算成等待时间", () => {
    // 5 分钟完成 60 条 → 5s/条；排第 3 位约等 15s
    expect(estimateWaitMs(3, 60, 300_000)).toBe(15_000);
    expect(estimateWaitMs(1, 60, 300_000)).toBe(5_000);
});

test("没有完成样本或位置非法时返回 null，而不是编一个数", () => {
    expect(estimateWaitMs(3, 0, 300_000)).toBeNull();
    expect(estimateWaitMs(0, 60, 300_000)).toBeNull();
    expect(estimateWaitMs(3, 60, 0)).toBeNull();
});
