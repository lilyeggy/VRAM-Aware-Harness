/**
 * 方向 C / 支柱 2：OpenAI 兼容 LLM 网关。
 *
 * 提供 POST /v1/chat/completions：把请求按逻辑模型路由到后端，
 * 主失败（网络错/超时/429/5xx）自动回退到下一个后端，全程记录 RouteDecision。
 * 支持流式（stream:true 时透传上游 SSE 流）。
 *
 * 支柱 2（算力利用率与计算/I/O 解耦）扩展：
 * - 转发前把 Prompt 规范化为稳定前缀结构（System Prompt -> 稳定工具定义 ->
 *   动态上下文），最大化 vLLM Automatic Prefix Caching 命中率，并记录前缀指纹；
 * - 非流式响应提取 usage.prompt_tokens_details.cached_tokens，
 *   写入网关缓存台账并可外接持久化 sink（SQLite 落库由 composition 提供）；
 * - 路由期间在后端上占一个「活跃连接」槽位，供 least-active 负载均衡与观测。
 *
 * 回退语义（面试可讲）：
 * - 429 / 5xx / 网络错误 / 超时 → 认为是后端问题，回退到下一个后端；
 * - 其余 4xx（如参数/鉴权错误）→ 认为是请求本身问题，回退无意义，直接透传。
 */

import type { LlmBackend, ModelRouter, RouteDecision } from "./model-router.ts";
import {
    computePrefixFingerprint,
    extractCachedTokensFromResponse,
    normalizePromptForPrefixCache,
} from "./prompt-prefix.ts";

/** 单次请求的缓存命中样本（供持久化 sink 消费）。 */
export interface LlmCacheSample {
    requestId: string;
    backendId: string;
    logicalModel: string;
    prefixCacheKey: string | null;
    promptTokens: number | null;
    cachedTokens: number | null;
    recordedAt: string;
}

export type LlmCacheSampleSink = (sample: LlmCacheSample) => void;

export interface LlmGatewayOptions {
    /** 单次上游请求超时 ms，默认 60_000。 */
    requestTimeoutMs?: number;
    /** 是否启用稳定前缀规范化（Prefix Caching 优化），默认 true。 */
    prefixCacheEnabled?: boolean;
    /**
     * 流式请求是否注入 stream_options.include_usage 并在 SSE 透传时采集
     * 末尾 usage chunk（缓存命中率观测的流式路径），默认 true。
     */
    streamUsageCapture?: boolean;
    /** 缓存命中样本外接持久化 sink（SQLite 落库）。 */
    cacheSampleSink?: LlmCacheSampleSink;
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

interface UpstreamOutcome {
    kind: "success";
    response: Response;
    promptTokens: number | null;
    cachedTokens: number | null;
    /**
     * N17：流式响应"首包成功"不等于这一轮成功。此标记表示成败交给
     * 流包装器在流真正结束时裁决（看到 finish_reason/[DONE] 记成功，
     * 提前断开记失败），避免立刻 recordSuccess 把断流失败冲掉。
     */
    deferOutcomeToStream?: boolean;
}

type TryBackendOutcome =
    | UpstreamOutcome
    | { kind: "client-error"; response: Response }
    | { kind: "retryable" };

export class LlmGateway {
    private readonly timeoutMs: number;
    private readonly prefixCacheEnabled: boolean;
    private readonly streamUsageCapture: boolean;
    private readonly cacheSampleSink: LlmCacheSampleSink | undefined;
    private readonly fetchImpl: typeof fetch;
    private readonly newRequestId: () => string;
    private readonly now: () => number;
    /** 缓存命中样本环形缓冲（观测用）。 */
    private readonly cacheSamples: LlmCacheSample[] = [];
    private readonly cacheBufferSize = 200;
    private cacheSampleCount = 0;
    private cachePromptTokensTotal = 0;
    private cacheCachedTokensTotal = 0;

    constructor(
        public readonly router: ModelRouter,
        options: LlmGatewayOptions = {},
    ) {
        this.timeoutMs = options.requestTimeoutMs ?? 60_000;
        this.prefixCacheEnabled = options.prefixCacheEnabled ?? true;
        this.streamUsageCapture = options.streamUsageCapture ?? true;
        this.cacheSampleSink = options.cacheSampleSink;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.newRequestId =
            options.requestId ?? (() => crypto.randomUUID());
        this.now = options.now ?? (() => Date.now());
    }

    /**
     * A6000 真机发现：Pi 的 ModelRuntime 启动时先调 GET /v1/models 做模型发现，
     * 网关缺该路由导致 Pi 直接 404、任务 RUN_FAILED。
     * 网关返回自身托管的逻辑模型清单（OpenAI 列表格式），Pi 据此确认模型可用。
     */
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
        // Prefix Caching：把 Prompt 规范化为稳定前缀结构，并计算前缀指纹。
        const outboundBody = this.prefixCacheEnabled
            ? normalizePromptForPrefixCache(body)
            : body;
        // 流式 usage 采集：vLLM 只在 stream_options.include_usage 时才会在
        // SSE 末尾附带 usage chunk。客户端未显式声明时由网关注入，转发时
        // 逐行扫描末尾 usage 并计入缓存台账（对响应字节零改动）。
        if (
            this.streamUsageCapture
            && outboundBody.stream === true
            && outboundBody.stream_options === undefined
        ) {
            outboundBody.stream_options = { include_usage: true };
        }
        const prefixCacheKey = this.prefixCacheEnabled
            ? computePrefixFingerprint(outboundBody)
            : null;
        const logicalModel = typeof outboundBody.model === "string"
            ? outboundBody.model
            : "";
        const candidates = this.router.candidatesFor(logicalModel);
        const attempted: string[] = [];
        const base: Omit<RouteDecision, "status" | "chosenBackendId" | "httpStatus" | "error"> = {
            requestId,
            logicalModel,
            attemptedBackendIds: attempted,
            fallback: false,
            latencyMs: 0,
            decidedAt: new Date(startedAt).toISOString(),
            strategy: this.router.loadBalancing,
            prefixCacheKey,
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
            const outcome = await this.tryBackend(backend, outboundBody, {
                requestId,
                logicalModel,
                prefixCacheKey,
            });
            if (outcome.kind === "success") {
                if (outcome.deferOutcomeToStream !== true) {
                    this.router.recordSuccess(backend.id);
                }
                this.router.recordDecision({
                    ...base,
                    chosenBackendId: backend.id,
                    status: "SUCCESS",
                    httpStatus: outcome.response.status,
                    fallback: attempted.length > 1,
                    latencyMs: this.now() - startedAt,
                    error: null,
                    promptTokens: outcome.promptTokens,
                    cachedTokens: outcome.cachedTokens,
                });
                if (outcome.promptTokens !== null) {
                    this.recordCacheSample({
                        requestId,
                        backendId: backend.id,
                        logicalModel,
                        prefixCacheKey,
                        promptTokens: outcome.promptTokens,
                        cachedTokens: outcome.cachedTokens,
                        recordedAt: new Date(this.now()).toISOString(),
                    });
                }
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

    /** 网关缓存命中指标快照（观测用；持久化走 cacheSampleSink）。 */
    cacheMetrics(): {
        totalRequests: number;
        promptTokensTotal: number;
        cachedTokensTotal: number;
        cacheHitRate: number | null;
        recentSamples: LlmCacheSample[];
    } {
        return {
            totalRequests: this.cacheSampleCount,
            promptTokensTotal: this.cachePromptTokensTotal,
            cachedTokensTotal: this.cacheCachedTokensTotal,
            cacheHitRate:
                this.cachePromptTokensTotal === 0
                    ? null
                    : this.cacheCachedTokensTotal / this.cachePromptTokensTotal,
            recentSamples: this.cacheSamples.slice(-50).reverse(),
        };
    }

    private recordCacheSample(sample: LlmCacheSample): void {
        this.cacheSamples.push(sample);
        if (this.cacheSamples.length > this.cacheBufferSize) {
            this.cacheSamples.shift();
        }
        this.cacheSampleCount += 1;
        this.cachePromptTokensTotal += sample.promptTokens ?? 0;
        this.cacheCachedTokensTotal += sample.cachedTokens ?? 0;
        try {
            this.cacheSampleSink?.(sample);
        } catch (error) {
            console.error("缓存命中样本持久化失败", error);
        }
    }

    /**
     * SSE 透传 + usage 采集：响应字节原样转发，同时逐行扫描
     * `data:` 行，在（include_usage 注入后出现的）末尾 usage chunk
     * 上记录一次缓存命中样本。非 JSON 行与 [DONE] 静默跳过。
     */
    /**
     * 字节原样透传，旁路观察每个 chunk；只有"上游异常结束"才回调
     * `onIncomplete`——下游主动取消（客户端断开）不算后端失败。
     */
    private passthroughStream(
        source: ReadableStream<Uint8Array>,
        onChunk: (chunk: Uint8Array) => void,
        onIncomplete: () => void,
    ): ReadableStream<Uint8Array> {
        const reader = source.getReader();
        let cancelled = false;
        return new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        if (!cancelled) onIncomplete();
                        controller.close();
                        return;
                    }
                    onChunk(value);
                    controller.enqueue(value);
                } catch (error) {
                    if (!cancelled) onIncomplete();
                    controller.error(error);
                }
            },
            cancel(reason) {
                cancelled = true;
                return reader.cancel(reason);
            },
        },
        // highWaterMark: 0 —— 保持与旧 TransformStream 相同的"按需拉取"语义：
        // 下游不读就不预读上游，也不提前记台账。
        { highWaterMark: 0 });
    }

    private wrapUpstreamStream(
        upstream: Response,
        backendId: string,
        context: { requestId: string; logicalModel: string; prefixCacheKey: string | null },
        sampleUsage: boolean,
    ): Response {
        const decoder = new TextDecoder();
        let buffer = "";
        let sampled = false;
        let finished = false;
        // N17：只有看到 finish_reason 或 [DONE] 才算这一轮被完整交付。
        // 否则流一旦提前结束（上游断流/超时），必须记到该后端头上——
        // 旧实现只看 HTTP 首包状态，断流不算失败，导致熔断器永不打开、
        // 健康的备用后端永远不被使用，每次重试都再撞同一个坏后端。
        const inspectLine = (line: string): void => {
            if (finished || !line.startsWith("data:")) return;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
                finished = true;
                return;
            }
            if (payload.length === 0) return;
            try {
                const parsed = JSON.parse(payload) as {
                    choices?: Array<{ finish_reason?: string | null }>;
                } & Record<string, unknown>;
                if ((parsed.choices ?? []).some(
                    (choice) => choice.finish_reason !== null
                        && choice.finish_reason !== undefined,
                )) {
                    finished = true;
                }
                if (!sampled) {
                    const usage = extractCachedTokensFromResponse(parsed);
                    if (usage.promptTokens !== null) {
                        sampled = true;
                        if (sampleUsage) {
                            this.recordCacheSample({
                                requestId: context.requestId,
                                backendId,
                                logicalModel: context.logicalModel,
                                prefixCacheKey: context.prefixCacheKey,
                                promptTokens: usage.promptTokens,
                                cachedTokens: usage.cachedTokens,
                                recordedAt: new Date(this.now()).toISOString(),
                            });
                        }
                    }
                }
            } catch {
                // 非 JSON 的 SSE 行（注释/心跳）按原样透传，不计入。
            }
        };
        const body = upstream.body === null
            ? null
            : this.passthroughStream(
                upstream.body,
                (chunk: Uint8Array) => {
                    buffer += decoder.decode(chunk, { stream: true });
                    let newlineIndex: number;
                    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
                        const line = buffer.slice(0, newlineIndex).trim();
                        buffer = buffer.slice(newlineIndex + 1);
                        inspectLine(line);
                    }
                },
                () => {
                    // N17：流真正结束才裁决这一轮成败。
                    if (finished) this.router.recordSuccess(backendId);
                    else this.router.recordFailure(backendId);
                },
            );
        return new Response(
            body,
            {
                status: upstream.status,
                headers: {
                    "content-type":
                        upstream.headers.get("content-type")
                        || "text/event-stream; charset=utf-8",
                },
            },
        );
    }

    private async tryBackend(
        backend: LlmBackend,
        body: Record<string, unknown>,
        context: { requestId: string; logicalModel: string; prefixCacheKey: string | null },
    ): Promise<TryBackendOutcome> {
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
            return { kind: "retryable" }; // 网络错误 / 超时
        } finally {
            this.router.release(backend.id);
        }
        if (upstream.ok) {
            // 非流式 JSON：提取 cached_tokens 后原样透传；SSE 流直接透传。
            const contentType =
                upstream.headers.get("content-type") ?? "";
            if (
                this.prefixCacheEnabled
                && contentType.includes("application/json")
            ) {
                const text = await upstream.text();
                let usage = { promptTokens: null, cachedTokens: null } as {
                    promptTokens: number | null;
                    cachedTokens: number | null;
                };
                try {
                    usage = extractCachedTokensFromResponse(JSON.parse(text));
                } catch {
                    // 上游返回非 JSON 体时按原样透传，不做缓存统计。
                }
                return {
                    kind: "success",
                    promptTokens: usage.promptTokens,
                    cachedTokens: usage.cachedTokens,
                    response: new Response(text, {
                        status: upstream.status,
                        headers: {
                            "content-type":
                                contentType || "application/json; charset=utf-8",
                        },
                    }),
                };
            }
            return {
                kind: "success",
                promptTokens: null,
                cachedTokens: null,
                // N17：流式一律走包装器，把"这一轮是否成功"推迟到流结束再裁决。
                deferOutcomeToStream: true,
                response: this.wrapUpstreamStream(
                    upstream,
                    backend.id,
                    context,
                    this.streamUsageCapture,
                ),
            };
        }
        if (upstream.status === 429 || upstream.status >= 500) {
            return { kind: "retryable" };
        }
        return { kind: "client-error", response: upstream };
    }
}
