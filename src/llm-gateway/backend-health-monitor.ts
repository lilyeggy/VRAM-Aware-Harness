/**
 * 支柱 2：双卡 vLLM 后端健康探测。
 *
 * 周期性对每个后端执行 GET {baseUrl}{probePath}，把结论回填到 ModelRouter：
 * 探测失败的后端在路由候选中被剔除。
 * 全部后端探测失败时路由器会降级放行（可用性优先），这里不做拦截。
 *
 * 默认探测路径为 "/models"：后端 baseUrl 约定已含 /v1（与
 * /chat/completions 同一拼接方式），拼出 /v1/models（OpenAI 兼容标准端点，
 * 所有 OpenAI 兼容后端——含 vLLM——都实现它）。个别发行版才有 /health，
 * 因此不把 /health 当默认假设。探测路径 404 意味着"配置的探活端点
 * 不存在"，不能等价于"后端不可用"，也不阻断路由（真实可用性以请求成败为准）。
 *
 * 探测台账（recentProbes）与 RouteDecision 台账同一思路：
 * 调度为什么跳过 GPU 1，必须有可回放的证据。
 */

import type { LlmBackend, ModelRouter } from "./model-router.ts";

export interface BackendHealthMonitorOptions {
    /** 健康端点相对路径（拼在 baseUrl 后），默认 "/models" 即 /v1/models。 */
    probePath?: string;
    /** 探测周期 ms，默认 10_000。 */
    probeIntervalMs?: number;
    /** 单次探测超时 ms，默认 2_000。 */
    probeTimeoutMs?: number;
    /** fetch 实现（测试注入）。 */
    fetchImpl?: typeof fetch;
    /** 决策 id 生成（测试注入）。 */
    now?: () => number;
    /** 周期探测出错时的回调（避免 unhandled rejection）。 */
    onProbeError?: (error: unknown) => void;
}

export interface BackendHealthProbeRecord {
    backendId: string;
    healthy: boolean;
    httpStatus: number | null;
    latencyMs: number;
    error: string | null;
    probedAt: string;
}

export class BackendHealthMonitor {
    private readonly probePath: string;
    private readonly probeIntervalMs: number;
    private readonly probeTimeoutMs: number;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;
    private readonly onProbeError: (error: unknown) => void;
    private readonly probes: BackendHealthProbeRecord[] = [];
    private readonly bufferSize = 200;
    private timer: ReturnType<typeof setInterval> | undefined;
    private probing = false;

    constructor(
        private readonly router: ModelRouter,
        private readonly backends: readonly LlmBackend[],
        options: BackendHealthMonitorOptions = {},
    ) {
        this.probePath = options.probePath ?? "/models";
        this.probeIntervalMs = options.probeIntervalMs ?? 10_000;
        this.probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.now = options.now ?? (() => Date.now());
        this.onProbeError = options.onProbeError ?? ((error) => {
            console.error("后端健康探测失败", error);
        });
        if (this.backends.length === 0) {
            throw new Error("BackendHealthMonitor 至少需要一个后端");
        }
    }

    start(): void {
        if (this.timer !== undefined) {
            return;
        }
        this.timer = setInterval(() => {
            void this.probeAll().catch(this.onProbeError);
        }, this.probeIntervalMs);
        // 立即做一轮探测，避免启动后的第一个周期内盲选到已挂后端。
        void this.probeAll().catch(this.onProbeError);
    }

    stop(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** 对所有后端做一轮探测并回填路由器健康状态。 */
    async probeAll(): Promise<BackendHealthProbeRecord[]> {
        if (this.probing) {
            return [];
        }
        this.probing = true;
        try {
            return await Promise.all(
                this.backends.map((backend) => this.probeBackend(backend)),
            );
        } finally {
            this.probing = false;
        }
    }

    private async probeBackend(
        backend: LlmBackend,
    ): Promise<BackendHealthProbeRecord> {
        const startedAt = this.now();
        const url = `${backend.baseUrl.replace(/\/+$/, "")}${this.probePath}`;
        let healthy = false;
        let httpStatus: number | null = null;
        let error: string | null = null;
        try {
            const response = await this.fetchImpl(url, {
                method: "GET",
                signal: AbortSignal.timeout(this.probeTimeoutMs),
            });
            httpStatus = response.status;
            healthy = response.ok;
            if (!healthy) {
                error = `健康探测返回 HTTP ${response.status}`;
            }
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
        }
        const record: BackendHealthProbeRecord = {
            backendId: backend.id,
            healthy,
            httpStatus,
            latencyMs: this.now() - startedAt,
            error,
            probedAt: new Date(this.now()).toISOString(),
        };
        this.router.recordHealthProbe(backend.id, healthy);
        this.probes.push(record);
        if (this.probes.length > this.bufferSize) {
            this.probes.shift();
        }
        return record;
    }

    recentProbes(limit = 50): BackendHealthProbeRecord[] {
        return this.probes.slice(-limit).reverse();
    }
}
