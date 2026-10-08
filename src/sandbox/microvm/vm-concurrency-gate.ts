/**
 * 异步信号量（用于快照制作的并发闸门）。
 *
 * ## 为什么需要
 *
 * 多台 VM 若同时首次启动且 kernel/rootfs 相同，它们的 templateHash 也相同，
 * 于是会**并发写同一个快照文件**，且各自 pause/resume 触发 vsock 断连重连。
 * 真机 10 并发实测：两台不同租户（tenant-02 / tenant-04）稳定复现
 * "vsock agent 20s 未就绪"；关闭快照后 10/10 通过 —— 确认是快照路径的
 * 并发竞态，而非并发能力不足。
 *
 * 因此需要按 templateHash 串行化：**同一模板只让一台 VM 制作快照**，其余等待
 * 后复用结果。不同模板仍可并行。
 */
export class Semaphore {
    private permits: number;
    private readonly waiters: (() => void)[] = [];

    constructor(permits: number) {
        // 并发上限至少为 1。
        //
        // 【重要】0 必须被钳到 1，而不是当作"禁止进入"。若 0 真的禁止进入，
        // acquire() 会永久挂起 → runExclusive 永不返回 → VM 创建流程卡死，
        // 且配置错误会以"平台无响应"而非明确报错的方式表现出来。
        // "完全串行"本身就等于并发上限 1，语义上无需区分。
        this.permits = Math.max(1, permits);
    }

    async acquire(): Promise<void> {
        if (this.permits > 0) {
            this.permits -= 1;
            return;
        }
        // 无可用许可：排队等待 release 唤醒
        await new Promise<void>((resolveWaiter) => {
            this.waiters.push(resolveWaiter);
        });
        // 被唤醒即表示已获得许可（许可在 release 时直接移交给该等待者）
    }

    release(): void {
        const next = this.waiters.shift();
        if (next !== undefined) {
            // 许可直接移交给下一个等待者，不再经过 permits 计数
            next();
            return;
        }
        this.permits += 1;
    }

    /**
     * 同步获取许可（不阻塞）。
     * @returns true 表示获得许可；false 表示当前无空闲许可
     */
    tryAcquire(): boolean {
        if (this.permits > 0) {
            this.permits -= 1;
            return true;
        }
        return false;
    }

    /** 在临界区内执行 fn，无论成功失败都释放许可（防许可泄漏死锁） */
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

/** 按 key 分片的多路信号量：不同 key 之间互不阻塞。 */
export class KeyedSemaphore<K> {
    private readonly gates = new Map<K, Semaphore>();
    private readonly limit: number;

    constructor(limit: number) {
        // 同样钳到至少 1：0 会让所有 acquire 永久挂起（死锁）。
        this.limit = Math.max(1, limit);
    }

    private gateFor(key: K): Semaphore {
        let gate = this.gates.get(key);
        if (gate === undefined) {
            gate = new Semaphore(this.limit);
            this.gates.set(key, gate);
        }
        return gate;
    }

    /** 在 key 对应的临界区内执行（同一 key 串行，不同 key 并行） */
    async runExclusive<T>(key: K, fn: () => Promise<T>): Promise<T> {
        return await this.gateFor(key).runExclusive(fn);
    }

    /** 当前已跟踪的 key 数量（测试与运维观测用） */
    get size(): number {
        return this.gates.size;
    }
}
