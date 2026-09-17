/**
 * 最小 LLM 网关。
 *
 * 保留能力：
 * - OpenAI 兼容 POST /v1/chat/completions 转发；
 * - 逻辑模型 -> 多后端路由；
 * - 健康探测/熔断/失败回退；
 * - 上下文预算压缩。
 *
 * 已删除：prefix cache、stream usage 采集、工具参数修复、缓存指标台账。
 */

import type {
    LlmBackend,
    ModelRouter,
    RouteDecision,
} from "./model-router.ts";
import {
    compactConversation,
    estimateToolsTokens,
    type ChatMessage,
    type CompactionOutcome,
} from "./context-budget.ts";

export interface LlmGatewayOptions {
    requestTimeoutMs?: number;
    contextBudgetTokens?: number;
    fetchImpl?: typeof fetch;
    requestId?: () => string;
    now?: () => number;
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

type UpstreamOutcome =
    | { kind: "success"; response: Response }
    | { kind: "client-error"; response: Response }
    | { kind: "retryable" };

export class LlmGateway {
    private readonly timeoutMs: number;
    private readonly contextBudgetTokens: number;
    private readonly fetchImpl: typeof fetch;
    private readonly newRequestId: () => string;
    private readonly now: () => number;
    private lastCompaction: CompactionOutcome | null = null;

    constructor(
        public readonly router: ModelRouter,
        options: LlmGatewayOptions = {},
    ) {
        this.timeoutMs = options.requestTimeoutMs ?? 60_000;
        this.contextBudgetTokens = options.contextBudgetTokens ?? 0;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.newRequestId =
            options.requestId ?? (() => crypto.randomUUID());
        this.now = options.now ?? (() => Date.now());
    }

    lastCompactionStats(): CompactionOutcome | null {
        return this.lastCompaction;
    }

    handleListModels(): Response {
        return json(200, {
            object: "list",
            data: this.router.logicalModels().map((id) => ({
                id,
                object: "model",
                created: Math.floor(this.now() / 1000),
                owned_by: "harness-llm-gateway",
            })),
        });
    }

    async handleChatCompletions(request: Request): Promise<Response> {
        const requestId = this.newRequestId();
        const startedAt = this.now();
        let body: Record<string, unknown>;
        try {
            body = (await request.json()) as Record<string, unknown>;
        } catch {
            return json(400, {
                error: { message: "请求体不是合法 JSON", type: "invalid_request" },
            });
        }

        if (this.contextBudgetTokens > 0 && Array.isArray(body.messages)) {
            const compaction = compactConversation(
                body.messages as ChatMessage[],
                estimateToolsTokens(body.tools),
                { budgetTokens: this.contextBudgetTokens },
            );
            if (compaction.compacted) {
                body.messages = compaction.messages;
                this.lastCompaction = compaction;
                console.warn(
                    `[llm-gateway] N28 上下文压缩：丢弃 ${compaction.droppedTurns} 轮`
                    + `（${compaction.droppedMessages} 条历史消息），估计 token `
                    + `${compaction.estimatedTokensBefore} → ${compaction.estimatedTokensAfter}`
                    + `（预算 ${this.contextBudgetTokens}，requestId=${requestId}）`,
                );
            }
        }

        const logicalModel = typeof body.model === "string" ? body.model : "";
        const candidates = this.router.candidatesFor(logicalModel);
        const attempted: string[] = [];
        const base: Omit<
            RouteDecision,
            "status" | "chosenBackendId" | "httpStatus" | "error"
        > = {
            requestId,
            logicalModel,
            attemptedBackendIds: attempted,
            fallback: false,
            latencyMs: 0,
            decidedAt: new Date(startedAt).toISOString(),
            strategy: this.router.loadBalancing,
        };

        if (candidates.length === 0) {
            const described = this.router.describeModelBackends(logicalModel);
            if (described.length === 0) {
                const known = this.router.logicalModels();
                const reason = `逻辑模型 ${logicalModel || "(空)"} 没有配置任何后端`;
                this.router.recordDecision({
                    ...base,
                    chosenBackendId: null,
                    status: "FAILED",
                    httpStatus: 404,
                    latencyMs: this.now() - startedAt,
                    error: reason,
                });
                return json(404, {
                    error: {
                        message: `模型 ${logicalModel || "(空)"} 不存在：网关未配置该逻辑模型。`
                            + `可用模型：${known.length > 0 ? known.join(", ") : "(无)"}`,
                        type: "model_not_found",
                    },
                });
            }
            const reason = `逻辑模型 ${logicalModel} 的 ${described.length} 个后端全部不可用：`
                + described.map((backend) =>
                    `${backend.id}`
                    + `(熔断${backend.circuitOpen ? "中" : "否"}`
                    + `，冷却剩余 ${backend.cooldownRemainingMs}ms`
                    + `，连续失败 ${backend.consecutiveFailures} 次)`,
                ).join("；");
            this.router.recordDecision({
                ...base,
                chosenBackendId: null,
                status: "FAILED",
                httpStatus: 503,
                latencyMs: this.now() - startedAt,
                error: reason,
            });
            return json(503, {
                error: {
                    message: `模型 ${logicalModel} 暂无可用后端。${reason}`,
                    type: "no_available_backend",
                },
            });
        }

        for (const backend of candidates) {
            attempted.push(backend.id);
            const outcome = await this.tryBackend(backend, body);
            if (outcome.kind === "success") {
                this.router.recordSuccess(backend.id);
                this.router.recordDecision({
                    ...base,
                    chosenBackendId: backend.id,
                    status: "SUCCESS",
                    httpStatus: outcome.response.status,
                    fallback: attempted.length > 1,
                    latencyMs: this.now() - startedAt,
                    error: null,
                });
                return outcome.response;
            }
            if (outcome.kind === "client-error") {
                this.router.recordDecision({
                    ...base,
                    chosenBackendId: backend.id,
                    status: "FAILED",
                    httpStatus: outcome.response.status,
                    fallback: attempted.length > 1,
                    latencyMs: this.now() - startedAt,
                    error: `上游返回客户端错误 ${outcome.response.status}`,
                });
                return outcome.response;
            }
            this.router.recordFailure(backend.id);
        }

        this.router.recordDecision({
            ...base,
            chosenBackendId: null,
            status: "FAILED",
            httpStatus: null,
            latencyMs: this.now() - startedAt,
            error: `全部后端失败：${attempted.join(", ")}`,
        });
        return json(502, {
            error: {
                message: `模型 ${logicalModel} 的所有后端均不可用（已尝试：${attempted.join(", ")}）`,
                type: "all_backends_failed",
            },
        });
    }

    private async tryBackend(
        backend: LlmBackend,
        body: Record<string, unknown>,
    ): Promise<UpstreamOutcome> {
        const url = `${backend.baseUrl.replace(/\/+$/, "")}/chat/completions`;
        const headers: Record<string, string> = {
            "content-type": "application/json",
        };
        if (backend.apiKey) headers.authorization = `Bearer ${backend.apiKey}`;

        this.router.acquire(backend.id);
        let upstream: Response;
        try {
            upstream = await this.fetchImpl(url, {
                method: "POST",
                headers,
                body: JSON.stringify({ ...body, model: backend.model }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch {
            return { kind: "retryable" };
        } finally {
            this.router.release(backend.id);
        }

        if (upstream.ok) {
            return { kind: "success", response: upstream };
        }
        if (upstream.status === 429 || upstream.status >= 500) {
            return { kind: "retryable" };
        }
        return { kind: "client-error", response: upstream };
    }
}
