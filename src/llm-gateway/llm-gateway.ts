/**
 * 方向 C：OpenAI 兼容 LLM 网关。
 *
 * 提供 POST /v1/chat/completions：把请求按逻辑模型路由到后端，
 * 主失败（网络错/超时/429/5xx）自动回退到下一个后端，全程记录 RouteDecision。
 * 支持流式（stream:true 时透传上游 SSE 流）。
 *
 * 回退语义（面试可讲）：
 * - 429 / 5xx / 网络错误 / 超时 → 认为是后端问题，回退到下一个后端；
 * - 其余 4xx（如参数/鉴权错误）→ 认为是请求本身问题，回退无意义，直接透传。
 */

import type { LlmBackend, ModelRouter, RouteDecision } from "./model-router.ts";

export interface LlmGatewayOptions {
    /** 单次上游请求超时 ms，默认 60_000。 */
    requestTimeoutMs?: number;
    /** fetch 实现（测试注入假后端）。 */
    fetchImpl?: typeof fetch;
    /** 决策 id 生成（测试注入）。 */
    requestId?: () => string;
    now?: () => number;
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

export class LlmGateway {
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;
    private readonly newRequestId: () => string;
    private readonly now: () => number;

    constructor(
        public readonly router: ModelRouter,
        options: LlmGatewayOptions = {},
    ) {
        this.timeoutMs = options.requestTimeoutMs ?? 60_000;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.newRequestId =
            options.requestId ?? (() => crypto.randomUUID());
        this.now = options.now ?? (() => Date.now());
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
        const logicalModel = typeof body.model === "string" ? body.model : "";
        const candidates = this.router.candidatesFor(logicalModel);
        const attempted: string[] = [];
        const base: Omit<RouteDecision, "status" | "chosenBackendId" | "httpStatus" | "error"> = {
            requestId,
            logicalModel,
            attemptedBackendIds: attempted,
            fallback: false,
            latencyMs: 0,
            decidedAt: new Date(startedAt).toISOString(),
        };

        if (candidates.length === 0) {
            this.router.recordDecision({
                ...base,
                chosenBackendId: null,
                status: "FAILED",
                httpStatus: null,
                latencyMs: this.now() - startedAt,
                error: `逻辑模型 ${logicalModel || "(空)"} 无可用后端（未配置或全部熔断）`,
            });
            return json(503, {
                error: {
                    message: `模型 ${logicalModel || "(空)"} 暂无可用后端`,
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
                // 请求本身问题：不回退，直接透传上游 4xx。
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
            // retryable：记录失败并回退下一个后端
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
    ): Promise<
        | { kind: "success"; response: Response }
        | { kind: "client-error"; response: Response }
        | { kind: "retryable" }
    > {
        const url = `${backend.baseUrl.replace(/\/+$/, "")}/chat/completions`;
        const headers: Record<string, string> = {
            "content-type": "application/json",
        };
        if (backend.apiKey) headers.authorization = `Bearer ${backend.apiKey}`;
        let upstream: Response;
        try {
            upstream = await this.fetchImpl(url, {
                method: "POST",
                headers,
                body: JSON.stringify({ ...body, model: backend.model }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch {
            return { kind: "retryable" }; // 网络错误 / 超时
        }
        if (upstream.ok) {
            // 透传上游响应（含 SSE 流 body）。
            return {
                kind: "success",
                response: new Response(upstream.body, {
                    status: upstream.status,
                    headers: {
                        "content-type":
                            upstream.headers.get("content-type")
                            ?? "application/json; charset=utf-8",
                    },
                }),
            };
        }
        if (upstream.status === 429 || upstream.status >= 500) {
            return { kind: "retryable" };
        }
        return { kind: "client-error", response: upstream };
    }
}
