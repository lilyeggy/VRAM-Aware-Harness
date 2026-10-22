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

test("ETA 准确度：窗口预热后，预测与实际等待的平均误差 < 25%", () => {
    // 单槽、固定服务时间 100ms，队列按 50ms 间隔到达（持续过载）。
    const serviceMs = 100;
    const arrivalEveryMs = 50;
    const windowMs = 15 * 60_000;
    const horizonMs = 45 * 60_000;

    // 已完成请求的完成时刻（严格递增）
    const finishTimes: number[] = [];
    let nextFreeAt = 0;
    const errors: number[] = [];

    function lowerBound(target: number): number {
        let low = 0;
        let high = finishTimes.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if ((finishTimes[mid] ?? 0) < target) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    for (let arrivalAt = 0; arrivalAt < horizonMs; arrivalAt += arrivalEveryMs) {
        const startAt = Math.max(arrivalAt, nextFreeAt);
        const finishAt = startAt + serviceMs;
        nextFreeAt = finishAt;

        // 已到达且未完成的数量（含当前请求）
        const unfinished = finishTimes.length - lowerBound(arrivalAt + 1);
        const position = unfinished + 1;

        // 15 分钟窗口内完成的请求数
        const completedInWindow = lowerBound(arrivalAt + 1)
            - lowerBound(arrivalAt - windowMs);

        const predicted = estimateWaitMs(position, completedInWindow, windowMs);
        const actual = finishAt - arrivalAt;

        // 窗口预热后才评估，避免冷启动样本污染
        if (arrivalAt >= windowMs && predicted !== null && actual > serviceMs * 3) {
            errors.push(Math.abs(predicted - actual) / actual);
        }

        finishTimes.push(finishAt);
    }

    expect(errors.length).toBeGreaterThan(50);
    const meanError = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    expect(meanError).toBeLessThan(0.25);
});
