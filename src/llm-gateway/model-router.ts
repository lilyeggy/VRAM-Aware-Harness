/**
 * 方向 C：LLM 网关的模型路由器。
 *
 * 职责：按逻辑模型选择后端（主备顺序 / 双卡负载均衡）+ 熔断 + 健康探测状态
 * + 记录每次路由决策。
 *
 * 设计要点（面试可讲）：
 * - 主备回退：candidatesFor 返回熔断过滤后的有序后端，网关依序尝试；
 * - 熔断：某后端连续失败达到阈值 → 打开熔断，冷却期内跳过，避免反复打挂掉的后端；
 * - 负载均衡（支柱 2）：同一逻辑模型可挂多个本地 vLLM 实例（GPU 0 / GPU 1），
 *   支持 priority（配置顺序）、round-robin（轮询）、least-active（最少活跃连接）；
 * - 健康探测：BackendHealthMonitor 周期性探测 /health，探测失败的后端从候选中
 *   剔除；全部不健康时降级放行（可用性优先于调度完美）；
 * - 可解释：每次选择/回退都落一条 RouteDecision（选谁、试了谁、是否回退、延迟、
 *   成败、缓存命中），与系统既有的 policy_decisions「决策台账」同一思路。
 */

export interface LlmBackend {
    /** 后端唯一标识（如 "vllm-gpu0" / "vllm-gpu1" / "opencode-cloud"）。 */
    id: string;
    /** OpenAI 兼容 baseUrl（不含 /chat/completions）。 */
    baseUrl: string;
    /** 后端鉴权 key（可选）。 */
    apiKey?: string;
    /** 该后端真实模型名（转发时替换请求里的逻辑模型名）。 */
    model: string;
    /** 所属逻辑模型（请求 model 字段按它路由）。 */
    logicalModel: string;
}

/** 后端选择策略：配置优先级顺序 / 轮询 / 最少活跃连接。 */
export type LoadBalancingStrategy = "priority" | "round-robin" | "least-active";

export interface RouteDecision {
    requestId: string;
    logicalModel: string;
    /** 最终选中的后端；全部失败为 null。 */
    chosenBackendId: string | null;
    /** 依次尝试过的后端 id。 */
    attemptedBackendIds: string[];
    /** 是否发生了回退（尝试了不止一个后端）。 */
    fallback: boolean;
    status: "SUCCESS" | "FAILED";
    /** 上游 HTTP 状态（若有响应）。 */
    httpStatus: number | null;
    latencyMs: number;
    error: string | null;
    decidedAt: string;
    /** 本次选择使用的负载均衡策略。 */
    strategy?: LoadBalancingStrategy;
    /** 稳定前缀指纹（System Prompt + 工具定义），用于观测前缀缓存复用。 */
    prefixCacheKey?: string | null;
    /** 上游 prompt_tokens（非流式响应可提取）。 */
    promptTokens?: number | null;
    /** 上游 prompt_tokens_details.cached_tokens（非流式响应可提取）。 */
    cachedTokens?: number | null;
}

interface BackendState {
    consecutiveFailures: number;
    /** 熔断打开截止时刻（epoch ms）；0 表示熔断关闭。 */
    circuitOpenUntil: number;
    /** 正在上游执行中的请求数（least-active 与观测用）。 */
    activeRequests: number;
    /** 健康探测结论；从未探测视为健康。 */
    healthy: boolean;
    /** 最近一次健康探测时刻（epoch ms）；0 表示从未探测。 */
    lastProbeAtMs: number;
}

export interface ModelRouterOptions {
    /** 连续失败多少次触发熔断，默认 3。 */
    circuitBreakerThreshold?: number;
    /** 熔断冷却时长 ms，默认 30_000。 */
    circuitCooldownMs?: number;
    /** 决策环形缓冲容量，默认 200。 */
    decisionBufferSize?: number;
    /** 后端选择策略，默认 priority（保持主备顺序语义）。 */
    loadBalancing?: LoadBalancingStrategy;
    /** 时钟（测试注入）。 */
    now?: () => number;
}

export class ModelRouter {
    private readonly backendsByModel = new Map<string, LlmBackend[]>();
    private readonly states = new Map<string, BackendState>();
    private readonly decisions: RouteDecision[] = [];
    private readonly threshold: number;
    private readonly cooldownMs: number;
    private readonly bufferSize: number;
    private readonly strategy: LoadBalancingStrategy;
    private readonly now: () => number;
    /** 每个逻辑模型一个轮询游标（round-robin 用）。 */
    private readonly roundRobinCursor = new Map<string, number>();

    constructor(backends: LlmBackend[], options: ModelRouterOptions = {}) {
        this.threshold = options.circuitBreakerThreshold ?? 3;
        this.cooldownMs = options.circuitCooldownMs ?? 30_000;
        this.bufferSize = options.decisionBufferSize ?? 200;
        this.strategy = options.loadBalancing ?? "priority";
        this.now = options.now ?? (() => Date.now());
        for (const backend of backends) {
            const list = this.backendsByModel.get(backend.logicalModel) ?? [];
            list.push(backend);
            this.backendsByModel.set(backend.logicalModel, list);
            this.states.set(backend.id, {
                consecutiveFailures: 0,
                circuitOpenUntil: 0,
                activeRequests: 0,
                healthy: true,
                lastProbeAtMs: 0,
            });
        }
    }

    get loadBalancing(): LoadBalancingStrategy {
        return this.strategy;
    }

    /** 网关托管的逻辑模型清单（OpenAI GET /v1/models 视角）。 */
    logicalModels(): string[] {
        return [...this.backendsByModel.keys()];
    }

    /**
     * 返回某逻辑模型当前可用的后端（剔除熔断打开中与健康探测失败的），
     * 并按负载均衡策略排序。
     * 熔断在冷却期结束后自动半开（允许再次尝试）。
     * 健康探测全部失败时降级放行（忽略探测结论，可用性优先）。
     */
    candidatesFor(logicalModel: string): LlmBackend[] {
        const list = this.backendsByModel.get(logicalModel) ?? [];
        const now = this.now();
        const circuitOk: LlmBackend[] = [];
        const healthy: LlmBackend[] = [];
        for (const backend of list) {
            const state = this.states.get(backend.id);
            if (state !== undefined && state.circuitOpenUntil !== 0) {
                if (now < state.circuitOpenUntil) {
                    continue;
                }
                // 冷却结束：半开，允许一次尝试
                state.circuitOpenUntil = 0;
            }
            circuitOk.push(backend);
            if (state === undefined || state.healthy) {
                healthy.push(backend);
            }
        }
        const candidates = healthy.length > 0 ? healthy : circuitOk;
        return this.orderByStrategy(logicalModel, candidates);
    }

    private orderByStrategy(
        logicalModel: string,
        candidates: readonly LlmBackend[],
    ): LlmBackend[] {
        if (candidates.length <= 1 || this.strategy === "priority") {
            return [...candidates];
        }
        if (this.strategy === "round-robin") {
            const cursor = this.roundRobinCursor.get(logicalModel) ?? 0;
            this.roundRobinCursor.set(logicalModel, cursor + 1);
            const offset = cursor % candidates.length;
            return [
                ...candidates.slice(offset),
                ...candidates.slice(0, offset),
            ];
        }
        // least-active：按在途请求数升序；相同活跃数保持配置顺序（稳定排序）。
        return [...candidates].sort((a, b) => {
            const diff =
                (this.states.get(a.id)?.activeRequests ?? 0)
                - (this.states.get(b.id)?.activeRequests ?? 0);
            return diff;
        });
    }

    /** 请求发往该后端前调用：占用一个在途槽位（观测 + least-active）。 */
    acquire(backendId: string): void {
        const state = this.states.get(backendId);
        if (state) {
            state.activeRequests += 1;
        }
    }

    /** 上游请求结束（无论成败）后调用：释放在途槽位。 */
    release(backendId: string): void {
        const state = this.states.get(backendId);
        if (state && state.activeRequests > 0) {
            state.activeRequests -= 1;
        }
    }

    /** 健康探测结论回填（由 BackendHealthMonitor 调用）。 */
    recordHealthProbe(backendId: string, healthy: boolean): void {
        const state = this.states.get(backendId);
        if (state) {
            state.healthy = healthy;
            state.lastProbeAtMs = this.now();
        }
    }

    recordSuccess(backendId: string): void {
        const state = this.states.get(backendId);
        if (state) {
            state.consecutiveFailures = 0;
            state.circuitOpenUntil = 0;
        }
    }

    recordFailure(backendId: string): void {
        const state = this.states.get(backendId);
        if (!state) return;
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= this.threshold) {
            state.circuitOpenUntil = this.now() + this.cooldownMs;
        }
    }

    recordDecision(decision: RouteDecision): void {
        this.decisions.push(decision);
        if (this.decisions.length > this.bufferSize) {
            this.decisions.shift();
        }
    }

    recentDecisions(limit = 50): RouteDecision[] {
        return this.decisions.slice(-limit).reverse();
    }

    /** 熔断/健康/活跃连接状态快照（观测用）。 */
    backendStates(): Record<
        string,
        {
            consecutiveFailures: number;
            circuitOpen: boolean;
            activeRequests: number;
            healthy: boolean;
            lastProbeAtMs: number;
        }
    > {
        const now = this.now();
        const out: Record<
            string,
            {
                consecutiveFailures: number;
                circuitOpen: boolean;
                activeRequests: number;
                healthy: boolean;
                lastProbeAtMs: number;
            }
        > = {};
        for (const [id, s] of this.states) {
            out[id] = {
                consecutiveFailures: s.consecutiveFailures,
                circuitOpen: s.circuitOpenUntil > now,
                activeRequests: s.activeRequests,
                healthy: s.healthy,
                lastProbeAtMs: s.lastProbeAtMs,
            };
        }
        return out;
    }

    /** 聚合统计（观测用）。 */
    stats() {
        const d = this.decisions;
        const total = d.length;
        const success = d.filter((x) => x.status === "SUCCESS").length;
        const fallback = d.filter((x) => x.fallback).length;
        const withUsage = d.filter(
            (x) => typeof x.promptTokens === "number",
        );
        const cachedSum = withUsage.reduce(
            (acc, x) => acc + (x.cachedTokens ?? 0),
            0,
        );
        const promptSum = withUsage.reduce(
            (acc, x) => acc + (x.promptTokens ?? 0),
            0,
        );
        return {
            loadBalancing: this.strategy,
            totalRequests: total,
            successCount: success,
            failureCount: total - success,
            successRate: total === 0 ? null : success / total,
            fallbackCount: fallback,
            fallbackRate: total === 0 ? null : fallback / total,
            cacheHitRate:
                promptSum === 0 ? null : cachedSum / promptSum,
            backendStates: this.backendStates(),
        };
    }
}
