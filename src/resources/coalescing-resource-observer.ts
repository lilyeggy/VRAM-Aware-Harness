/**
 * 观测合并器：包装真实 ResourceObserver，解决调度 drain 扇出造成的
 * 重复采样问题。
 *
 * 背景：drainOnce 按队列长度并行 fan-out N 个 attemptNext，每个都会经
 * ResourceAdmissionService 触发一次 observe()——即 N 次 nvidia-smi
 * 子进程 + vLLM metrics 抓取，且高频乱序抓取会打乱
 * VllmResourceObserver 内部 token 速率计数器的采样间隔，让速率失真。
 *
 * 语义：
 * 1. 并发调用共享同一个 in-flight observe()；
 * 2. 短窗口（默认 250ms）内复用最近一次结果，同一轮 drain 的连续准入
 *    评估看到同一份资源事实——这本来就是「同一时刻」的语义。
 */
import type { ResourceObservation, ResourceObserver } from "./resource-observer.ts";

export interface CoalescingResourceObserverOptions {
    /** 观测结果复用窗口（ms）。 */
    readonly cacheTtlMs?: number;
    /** 时钟注入（测试用）。 */
    readonly now?: () => number;
}

export class CoalescingResourceObserver implements ResourceObserver {
    private readonly cacheTtlMs: number;
    private readonly now: () => number;
    private inFlight: Promise<ResourceObservation> | null = null;
    private cached: { at: number; observation: ResourceObservation } | null = null;

    constructor(
        private readonly inner: ResourceObserver,
        options: CoalescingResourceObserverOptions = {},
    ) {
        this.cacheTtlMs = options.cacheTtlMs ?? 250;
        this.now = options.now ?? Date.now;
        if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs < 0) {
            throw new Error("cacheTtlMs 不能为负");
        }
    }

    observe(): Promise<ResourceObservation> {
        const cached = this.cached;
        if (cached !== null && this.now() - cached.at <= this.cacheTtlMs) {
            return Promise.resolve(cached.observation);
        }

        this.inFlight ??= this.inner.observe()
            .then((observation) => {
                this.cached = { at: this.now(), observation };
                return observation;
            })
            .finally(() => {
                this.inFlight = null;
            });

        return this.inFlight;
    }
}
