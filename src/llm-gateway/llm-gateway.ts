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
    type ChatMessage,
} from "./prompt-prefix.ts";
import {
    compactConversation,
    estimateToolsTokens,
    type CompactionOutcome,
} from "./context-budget.ts";
import {
    buildToolCallRepairChunk,
    ToolCallArgumentTracker,
    type StreamChunkMeta,
} from "./tool-call-argument-repair.ts";

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
    /**
     * N28：上下文预算（token）。> 0 时，转发前按轮次边界压缩过长的会话历史，
     * 避免会话撞上模型窗口后每个请求都被上游 400 拒绝且永不恢复。
     * 0（默认）= 不压缩，保持旧行为。
     */
    contextBudgetTokens?: number;
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
    private readonly contextBudgetTokens: number;
    /**
     * 最近一次上下文压缩的结果。N28 的另一半问题是"静默"——用户与运维都
     * 不知道会话已经被裁剪过，这里保留可查询的事实，供观测与测试断言。
     */
    private lastCompaction: CompactionOutcome | null = null;
    private readonly fetchImpl: typeof fetch;
    private readonly newRequestId: () => string;
    private readonly now: () => number;
    /** 缓存命中样本环形缓冲（观测用）。 */
    private readonly cacheSamples: LlmCacheSample[] = [];
    private readonly cacheBufferSize = 200;
    private cacheSampleCount = 0;
    private cachePromptTokensTotal = 0;
    private cacheCachedTokensTotal = 0;
    /** N27 观测：本进程内补发过修复增量的工具调用数。 */
    private toolCallRepairs = 0;

    constructor(
        public readonly router: ModelRouter,
        options: LlmGatewayOptions = {},
    ) {
        this.timeoutMs = options.requestTimeoutMs ?? 60_000;
        this.prefixCacheEnabled = options.prefixCacheEnabled ?? true;
        this.streamUsageCapture = options.streamUsageCapture ?? true;
        this.cacheSampleSink = options.cacheSampleSink;
        this.contextBudgetTokens = options.contextBudgetTokens ?? 0;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.newRequestId =
            options.requestId ?? (() => crypto.randomUUID());
        this.now = options.now ?? (() => Date.now());
    }

    /** N28 观测：最近一次上下文压缩的事实；未曾压缩时为 null。 */
    lastCompactionStats(): CompactionOutcome | null {
        return this.lastCompaction;
    }

    /**
     * N27 观测：本进程内被上游截断、并由网关补发闭合增量的工具调用次数。
     * 该计数 > 0 是"上游缺陷确实命中过、但被网关兜住"的直接证据。
     */
    toolCallRepairStats(): { repairedToolCalls: number } {
        return { repairedToolCalls: this.toolCallRepairs };
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
        // N28：会话历史超预算时按轮次边界压缩。必须在 prefix 规范化之前做：
        // 规范化会重排 messages，压缩要按原始轮次结构判断边界。
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
            // N26：把"为什么没有可用后端"说清楚，别让用户自己猜。
            // 两种原因完全不同：① 该逻辑模型根本没配后端；② 配了但全部在熔断
            // 冷却中。真机上"流式断流 + 重试耗尽"正是第 ② 种，原先被笼统写成
            // "未配置或全部熔断"，用户会误以为根本没配后端。
            const described = this.router.describeModelBackends(logicalModel);
            // N9：区分"这个逻辑模型根本没配"与"配了但暂时全不可用"。
            // 前者是资源不存在（404 model_not_found），后者才是服务不可用（503）。
            // 旧实现一律 503，客户端会把拼错的模型名当成"服务抖动"去重试。
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
     * SSE 透传 + usage 采集 + N27 工具调用参数截断修复。
     *
     * 逐行扫描 `data:` 行：旁路采集 usage 缓存命中样本；同时累计 tool_call
     * 的 arguments，并在流尾判定是否被上游截断。为把补发的闭合符排在
     * finish chunk 之前，finish_reason 与 [DONE] 会先被扣住（heldTail），
     * 到流结束（或见到 [DONE]）时先发修复增量再原样发出流尾。
     * 提前断流（未收到 finish_reason）不做修复，交由 N17 的失败裁决与重试。
     */
    private wrapUpstreamStream(
        upstream: Response,
        backendId: string,
        context: { requestId: string; logicalModel: string; prefixCacheKey: string | null },
        sampleUsage: boolean,
    ): Response {
        const self = this;
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const reader = upstream.body?.getReader() ?? null;
        let buffer = "";
        let sampled = false;
        let finished = false;
        let holdingTail = false;
        let tailFlushed = false;
        let cancelled = false;
        const heldTail: string[] = [];
        const tracker = new ToolCallArgumentTracker();
        const chunkMeta: StreamChunkMeta = {};
        // 输出队列：handleLine/flushTail 只负责"产出字节"，pull 负责"交付字节"。
        // 这样即使某个上游 chunk 全部是"被扣住的流尾"（本次没有产出），
        // pull 也能继续往下读，而不会因为一次 pull 没 deliver 就永久停滞
        // （highWaterMark: 0 下，未 enqueue 的 pull 不会自动再次触发）。
        const outbox: Uint8Array[] = [];

        const flushTail = (): void => {
            if (tailFlushed) {
                return;
            }

            tailFlushed = true;

            if (finished) {
                for (const repair of tracker.repairs()) {
                    const chunk = buildToolCallRepairChunk(
                        repair,
                        chunkMeta,
                        self.now(),
                    );
                    outbox.push(
                        encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                    );
                    self.toolCallRepairs += 1;
                    console.warn(
                        "[llm-gateway] N27 上游截断了工具调用参数，已补发闭合增量："
                        + `backend=${backendId}`
                        + ` choice=${repair.choiceIndex}`
                        + ` toolCall=${repair.toolCallIndex}`
                        + ` suffix=${JSON.stringify(repair.suffix)}`
                        + `（requestId=${context.requestId}）`,
                    );
                }
            }

            for (const line of heldTail) {
                outbox.push(encoder.encode(`${line}\n`));
            }

            heldTail.length = 0;
        };

        const handleLine = (rawLine: string): void => {
            if (holdingTail) {
                heldTail.push(rawLine);
                return;
            }

            const line = rawLine.trim();

            if (finished || !line.startsWith("data:")) {
                outbox.push(encoder.encode(`${rawLine}\n`));
                return;
            }

            const payload = line.slice(5).trim();

            if (payload === "[DONE]") {
                finished = true;
                holdingTail = true;
                heldTail.push(rawLine);
                // [DONE] 之后不会再有内容，立刻收尾（不依赖上游关闭连接）。
                flushTail();
                return;
            }

            if (payload.length > 0) {
                try {
                    const parsed = JSON.parse(payload) as {
                        id?: unknown;
                        created?: unknown;
                        model?: unknown;
                        choices?: Array<{ finish_reason?: string | null }>;
                    } & Record<string, unknown>;

                    if (typeof parsed.id === "string") chunkMeta.id = parsed.id;
                    if (typeof parsed.created === "number") {
                        chunkMeta.created = parsed.created;
                    }
                    if (typeof parsed.model === "string") chunkMeta.model = parsed.model;

                    tracker.observe(parsed);

                    if (!sampled) {
                        const usage = extractCachedTokensFromResponse(parsed);

                        if (usage.promptTokens !== null) {
                            sampled = true;

                            if (sampleUsage) {
                                self.recordCacheSample({
                                    requestId: context.requestId,
                                    backendId,
                                    logicalModel: context.logicalModel,
                                    prefixCacheKey: context.prefixCacheKey,
                                    promptTokens: usage.promptTokens,
                                    cachedTokens: usage.cachedTokens,
                                    recordedAt: new Date(self.now()).toISOString(),
                                });
                            }
                        }
                    }

                    const isFinish = (parsed.choices ?? []).some(
                        (choice) => choice.finish_reason !== null
                            && choice.finish_reason !== undefined,
                    );

                    if (isFinish) {
                        finished = true;
                        holdingTail = true;
                        heldTail.push(rawLine);
                        return;
                    }
                } catch {
                    // 非 JSON 的 SSE 行（注释/心跳）按原样透传，不计入。
                }
            }

            outbox.push(encoder.encode(`${rawLine}\n`));
        };

        const body = reader === null
            ? null
            : new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        // 持续读，直到本次 pull 能交付一个 chunk（或流结束）。
                        for (;;) {
                            const buffered = outbox.shift();

                            if (buffered !== undefined) {
                                controller.enqueue(buffered);
                                return;
                            }

                            const { done, value } = await reader.read();

                            if (done) {
                                // 上游最后一行可能没有换行符（常见于收尾的 [DONE]）。
                                const residual = buffer.trim();
                                buffer = "";

                                if (residual.length > 0) {
                                    handleLine(residual);
                                }

                                if (!cancelled) {
                                    flushTail();
                                    // N17：流真正结束才裁决这一轮成败。
                                    if (finished) {
                                        self.router.recordSuccess(backendId);
                                    } else {
                                        self.router.recordFailure(backendId);
                                    }
                                }

                                const tail = outbox.shift();

                                if (tail !== undefined) {
                                    controller.enqueue(tail);
                                    return;
                                }

                                controller.close();
                                return;
                            }

                            buffer += decoder.decode(value, { stream: true });

                            let newlineIndex: number;

                            while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
                                const rawLine = buffer.slice(0, newlineIndex);
                                buffer = buffer.slice(newlineIndex + 1);
                                handleLine(rawLine);
                            }
                        }
                    } catch (error) {
                        if (!cancelled) self.router.recordFailure(backendId);
                        controller.error(error);
                    }
                },
                cancel(reason) {
                    // 下游主动取消（客户端断开）不算后端失败，不做修复补发。
                    cancelled = true;
                    return reader.cancel(reason);
                },
            },
            // highWaterMark: 0 —— 保持与旧实现相同的"按需拉取"语义。
            { highWaterMark: 0 });

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
