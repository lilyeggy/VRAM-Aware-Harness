/**
 * 支柱 2：Prefix Caching 优化。
 *
 * vLLM 的 Automatic Prefix Caching 按「请求 token 前缀的 block hash」复用 KV Cache。
 * 要让它命中，发往同一后端的请求必须有逐字节稳定的前缀。因此网关在转发前把
 * Prompt 结构规范化为稳定顺序：
 *
 *   System Prompt（稳定） -> 稳定工具定义（按名字排序、键序规范化） -> 动态上下文
 *
 * 任何位于前缀里的易变内容（乱序的 tools 数组、分散的 system 消息）都会把
 * 缓存命中打断在第一个差异 block 上。
 */

export interface ChatMessage {
    role: string;
    content?: unknown;
    [key: string]: unknown;
}

export interface ToolDefinition {
    type?: string;
    function?: { name?: string; [key: string]: unknown };
    [key: string]: unknown;
}

/** 递归键排序的稳定 JSON 序列化：同结构必得同字符串。 */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
        .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
        .join(",")}}`;
}

function toolSortKey(tool: ToolDefinition): string {
    return tool.function?.name ?? tool.type ?? "";
}

/**
 * 把 chat completions 请求体规范化为「稳定前缀在前」的结构：
 * - system 消息全部提前（保持相对顺序），其余消息保持原顺序；
 * - tools 按函数名排序，且每个定义键序规范化。
 * 幂等：已规范化的请求体再次规范化结果不变。
 */
export function normalizePromptForPrefixCache<
    T extends {
        messages?: unknown;
        tools?: unknown;
    },
>(body: T): T {
    const next: T = { ...body };

    if (Array.isArray(body.messages)) {
        const messages = body.messages as ChatMessage[];
        const system = messages.filter((m) => m?.role === "system");
        const rest = messages.filter((m) => m?.role !== "system");
        next.messages = [...system, ...rest];
    }

    if (Array.isArray(body.tools) && body.tools.length > 1) {
        const tools = [...(body.tools as ToolDefinition[])].sort((a, b) => {
            const ka = toolSortKey(a);
            const kb = toolSortKey(b);
            return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
        // 键序规范化后再 parse 回对象，保证转发体本身就是稳定形态。
        next.tools = JSON.parse(stableStringify(tools)) as unknown;
    }

    return next;
}

/**
 * 计算稳定前缀（System Prompt + 工具定义）的指纹。
 * 动态上下文（用户消息、工具结果）不参与指纹，因此同一会话的多轮请求
 * 与跨 Run 的同构请求会得到相同指纹 —— 可用于观测前缀缓存复用。
 * 没有任何稳定前缀成分（无 system 消息且无 tools）时返回 null。
 */
export function computePrefixFingerprint(
    body: { messages?: unknown; tools?: unknown },
): string | null {
    const messages = Array.isArray(body.messages)
        ? (body.messages as ChatMessage[])
        : [];
    const system = messages.filter((m) => m?.role === "system");
    const tools = Array.isArray(body.tools) ? (body.tools as ToolDefinition[]) : [];

    if (system.length === 0 && tools.length === 0) {
        return null;
    }

    const normalized = normalizePromptForPrefixCache({
        messages: system,
        tools: tools.length > 0 ? tools : undefined,
    });

    return sha256Hex(stableStringify({
        system: normalized.messages,
        tools: normalized.tools ?? null,
    }));
}

function sha256Hex(text: string): string {
    return Bun.SHA256.hash(text, "hex");
}

export interface UpstreamPromptUsage {
    promptTokens: number | null;
    cachedTokens: number | null;
}

/**
 * 从 OpenAI 兼容的 chat completions 响应里提取 prompt token 用量与
 * vLLM 返回的 prompt_tokens_details.cached_tokens。
 * 字段缺失（旧版本 vLLM / 流式聚合前的 chunk）时返回 null 成分。
 */
export function extractCachedTokensFromResponse(
    payload: unknown,
): UpstreamPromptUsage {
    if (payload === null || typeof payload !== "object") {
        return { promptTokens: null, cachedTokens: null };
    }
    const usage = (payload as { usage?: unknown }).usage;
    if (usage === null || typeof usage !== "object") {
        return { promptTokens: null, cachedTokens: null };
    }
    const usageRecord = usage as {
        prompt_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown } | null;
        cached_tokens?: unknown;
    };
    const promptTokens = typeof usageRecord.prompt_tokens === "number"
        ? usageRecord.prompt_tokens
        : null;
    const fromDetails = usageRecord.prompt_tokens_details?.cached_tokens;
    const cachedRaw = fromDetails ?? usageRecord.cached_tokens;
    const cachedTokens = typeof cachedRaw === "number" ? cachedRaw : null;
    return { promptTokens, cachedTokens };
}
