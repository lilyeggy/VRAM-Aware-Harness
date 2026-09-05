import type {
    ResourceObservation,
    ResourceObserver,
    ResourceSnapshot,
} from "./resource-observer.ts";

export type ResourceSample =
    | { readonly ok: true; readonly sampledAt: string; readonly snapshot: ResourceSnapshot }
    | { readonly ok: false; readonly sampledAt: string; readonly reason: string; readonly message: string };

export interface ResourceMetricsSamplerOptions {
    readonly intervalMs?: number;
    readonly now?: () => Date;
    readonly maxSamples?: number;
}

/**
 * 独立资源时间序列采样器。它复用调度层 ResourceObserver，但不进入 Run
 * 关键路径；采样失败只作为观测事实保存，不阻塞任务执行。
 */
export class ResourceMetricsSampler {
    private readonly intervalMs: number;
    private readonly now: () => Date;
    private readonly maxSamples: number;
    private readonly samples: ResourceSample[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private sampling = false;

    constructor(
        private readonly observer: ResourceObserver,
        options: ResourceMetricsSamplerOptions = {},
    ) {
        this.intervalMs = options.intervalMs ?? 1000;
        this.now = options.now ?? (() => new Date());
        this.maxSamples = options.maxSamples ?? 10_000;
        if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) throw new Error("intervalMs 必须大于 0");
        if (!Number.isInteger(this.maxSamples) || this.maxSamples <= 0) throw new Error("maxSamples 必须是正整数");
    }

    start(): void {
        if (this.timer !== null) return;
        void this.sample();
        this.timer = setInterval(() => void this.sample(), this.intervalMs);
    }

    stop(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
    }

    async sample(): Promise<ResourceSample> {
        if (this.sampling) {
            const skipped = { ok: false as const, sampledAt: this.now().toISOString(), reason: "OVERLAPPED", message: "上一次资源采样尚未完成" };
            this.append(skipped);
            return skipped;
        }
        this.sampling = true;
        try {
            const observed: ResourceObservation = await this.observer.observe();
            const result: ResourceSample = observed.ok
                ? { ok: true, sampledAt: observed.snapshot.observedAt, snapshot: observed.snapshot }
                : { ok: false, sampledAt: observed.observedAt, reason: observed.reason, message: observed.message };
            this.append(result);
            return result;
        } finally {
            this.sampling = false;
        }
    }

    getSamples(): readonly ResourceSample[] { return [...this.samples]; }

    clear(): void { this.samples.length = 0; }

    private append(sample: ResourceSample): void {
        this.samples.push(sample);
        if (this.samples.length > this.maxSamples) this.samples.shift();
    }
}
