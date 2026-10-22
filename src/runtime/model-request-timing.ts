/**
 * 模型请求计时：把「请求真正发出」和「响应头到达」两个时刻记下来。
 *
 * 背景：事件流里 `SESSION_INITIALIZED` → 首次 `MODEL_STARTED` 之间有一段
 * 空档，但它同时包含「我们组装请求」和「provider 排队/prefill」两部分。
 * 没有请求发出时刻，就无法判断该优化谁。
 *
 * 做法：包装 globalThis.fetch（Pi/OpenAI SDK 都走它），记录每个 POST 请求的
 * 发出时刻与响应头到达时刻；PiAdapter 在 `message_start` 时取最早的一条，
 * 作为该次模型调用的 `requestStartedAt` / `ttftMs` 写进事件。
 *
 * 约束：只做旁路观测，不改变请求/响应；缓冲区有上限，取不到就返回 null，
 * 不影响主流程。
 */
export interface ModelRequestTiming {
    /** performance.now() 口径的发出时刻。 */
    readonly startedAt: number;
    /** 墙钟 ISO 时间，便于和事件时间戳对齐。 */
    readonly startedAtWall: string;
    /** 响应头到达时刻；请求失败时为 null。 */
    headersAt: number | null;
    readonly url: string;
}

const MAX_ENTRIES = 64;
const pending: ModelRequestTiming[] = [];
let installed = false;
let originalFetchRef: typeof fetch | null = null;

function isModelRequest(input: unknown, init: unknown): boolean {
    const method = (init as { method?: string } | undefined)?.method
        ?? (input as { method?: string } | undefined)?.method
        ?? "GET";

    if (String(method).toUpperCase() !== "POST") {
        return false;
    }

    const url = typeof input === "string"
        ? input
        : input instanceof URL
            ? input.toString()
            : String((input as { url?: string } | undefined)?.url ?? "");

    return url.includes("/chat/completions")
        || url.includes("/responses")
        || url.includes("/messages");
}

export function installModelRequestTiming(): void {
    if (installed) {
        return;
    }

    installed = true;
    const originalFetch = globalThis.fetch;
    originalFetchRef = originalFetch;

    globalThis.fetch = (async (input: unknown, init?: unknown) => {
        if (isModelRequest(input, init) === false) {
            return originalFetch(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
        }

        const url = typeof input === "string"
            ? input
            : input instanceof URL
                ? input.toString()
                : String((input as { url?: string } | undefined)?.url ?? "");

        const entry: ModelRequestTiming = {
            startedAt: performance.now(),
            startedAtWall: new Date().toISOString(),
            headersAt: null,
            url,
        };

        pending.push(entry);
        if (pending.length > MAX_ENTRIES) {
            pending.shift();
        }

        try {
            const response = await originalFetch(
                input as Parameters<typeof fetch>[0],
                init as Parameters<typeof fetch>[1],
            );
            entry.headersAt = performance.now();
            return response;
        } catch (error) {
            const index = pending.indexOf(entry);
            if (index !== -1) {
                pending.splice(index, 1);
            }
            throw error;
        }
    }) as typeof fetch;
}

/** 取最早的一条未消费计时（模型调用是串行的，FIFO 足够）。 */
export function takeModelRequestTiming(): ModelRequestTiming | null {
    return pending.shift() ?? null;
}

/** 仅测试用：清空缓冲区并还原 fetch。 */
export function resetModelRequestTimingForTest(): void {
    pending.length = 0;

    if (originalFetchRef !== null) {
        globalThis.fetch = originalFetchRef;
        originalFetchRef = null;
    }

    installed = false;
}
