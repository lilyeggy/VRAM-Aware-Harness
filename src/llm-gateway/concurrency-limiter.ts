/**
 * 模型调用并发限制器（FIFO 信号量）。
 *
 * 背景：Run 级并发和模型调用级并发不是一回事。一个 Run 在等工具/等审批时
 * 不占 GPU；真正稀缺的是"同时有几个模型请求在 provider 里"。
 *
 * 用法：网关在转发前 acquire()，转发结束（或失败）后 release()。超出的请求
 * 在本地排队，而不是把并发压力直接打给推理服务。
 */
export interface ConcurrencyLimiterStats {
    readonly limit: number;
    readonly inflight: number;
    readonly waiting: number;
    readonly acquired: number;
    readonly averageWaitMs: number;
    readonly maxWaitMs: number;
}

export class ConcurrencyLimiter {
    private inflight = 0;
    private readonly waiters: Array<() => void> = [];
    private acquired = 0;
    private totalWaitMs = 0;
    private maxWaitMs = 0;

    constructor(private readonly limit: number) {
        if (Number.isInteger(limit) === false || limit <= 0) {
            throw new Error("并发上限必须为正整数");
        }
    }

    /**
     * 获取一个并发槽；返回幂等的 release 函数。
     * 队列是 FIFO，避免长请求被后来的短请求插队。
     */
    async acquire(): Promise<() => void> {
        const startedAt = performance.now();

        if (this.inflight >= this.limit) {
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
            });
        }

        this.inflight += 1;

        const waitedMs = performance.now() - startedAt;
        this.acquired += 1;
        this.totalWaitMs += waitedMs;
        this.maxWaitMs = Math.max(this.maxWaitMs, waitedMs);

        let released = false;

        return () => {
            if (released) {
                return;
            }

            released = true;
            this.inflight = Math.max(0, this.inflight - 1);

            const next = this.waiters.shift();
            if (next !== undefined) {
                next();
            }
        };
    }

    stats(): ConcurrencyLimiterStats {
        return {
            limit: this.limit,
            inflight: this.inflight,
            waiting: this.waiters.length,
            acquired: this.acquired,
            averageWaitMs: this.acquired === 0
                ? 0
                : Math.round(this.totalWaitMs / this.acquired),
            maxWaitMs: Math.round(this.maxWaitMs),
        };
    }
}
