/**
 * 方向 C：LLM 网关的模型路由器。
 *
 * 职责：按逻辑模型选择后端（主备顺序）+ 熔断 + 记录每次路由决策。
 *
 * 设计要点（面试可讲）：
 * - 主备回退：candidatesFor 返回熔断过滤后的有序后端，网关依序尝试；
 * - 熔断：某后端连续失败达到阈值 → 打开熔断，冷却期内跳过，避免反复打挂掉的后端；
 * - 可解释：每次选择/回退都落一条 RouteDecision（选谁、试了谁、是否回退、延迟、成败），
 *   与系统既有的 policy_decisions「决策台账」同一思路。
 */

export interface LlmBackend {
    /** 后端唯一标识（如 "vllm-local" / "opencode-cloud"）。 */
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
}

interface BackendState {
    consecutiveFailures: number;
    /** 熔断打开截止时刻（epoch ms）；0 表示熔断关闭。 */
    circuitOpenUntil: number;
}

export interface ModelRouterOptions {
    /** 连续失败多少次触发熔断，默认 3。 */
    circuitBreakerThreshold?: number;
    /** 熔断冷却时长 ms，默认 30_000。 */
    circuitCooldownMs?: number;
    /** 决策环形缓冲容量，默认 200。 */
    decisionBufferSize?: number;
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
    private readonly now: () => number;

    constructor(backends: LlmBackend[], options: ModelRouterOptions = {}) {
        this.threshold = options.circuitBreakerThreshold ?? 3;
        this.cooldownMs = options.circuitCooldownMs ?? 30_000;
        this.bufferSize = options.decisionBufferSize ?? 200;
        this.now = options.now ?? (() => Date.now());
        for (const backend of backends) {
            const list = this.backendsByModel.get(backend.logicalModel) ?? [];
            list.push(backend);
            this.backendsByModel.set(backend.logicalModel, list);
            this.states.set(backend.id, {
                consecutiveFailures: 0,
                circuitOpenUntil: 0,
            });
        }
    }

    /**
     * 返回某逻辑模型当前可用的后端（保持配置优先级顺序，剔除熔断打开中的）。
     * 熔断在冷却期结束后自动半开（允许再次尝试）。
     */
    candidatesFor(logicalModel: string): LlmBackend[] {
        const list = this.backendsByModel.get(logicalModel) ?? [];
        const now = this.now();
        return list.filter((b) => {
            const state = this.states.get(b.id);
            if (!state) return true;
            if (state.circuitOpenUntil === 0) return true;
            if (now >= state.circuitOpenUntil) {
                // 冷却结束：半开，允许一次尝试
                state.circuitOpenUntil = 0;
                return true;
            }
            return false;
        });
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

    /** 熔断状态快照（观测用）。 */
    backendStates(): Record<
        string,
        { consecutiveFailures: number; circuitOpen: boolean }
    > {
        const now = this.now();
        const out: Record<
            string,
            { consecutiveFailures: number; circuitOpen: boolean }
        > = {};
        for (const [id, s] of this.states) {
            out[id] = {
                consecutiveFailures: s.consecutiveFailures,
                circuitOpen: s.circuitOpenUntil > now,
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
        return {
            totalRequests: total,
            successCount: success,
            failureCount: total - success,
            successRate: total === 0 ? null : success / total,
            fallbackCount: fallback,
            fallbackRate: total === 0 ? null : fallback / total,
            backendStates: this.backendStates(),
        };
    }
}
