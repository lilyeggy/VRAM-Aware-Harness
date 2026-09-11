/**
 * N27：流式工具调用参数截断的上游修复层。
 *
 * 现象（真机可复现，绕过 Harness 直连 vLLM 127.0.0.1:18000 同样命中）：
 * vLLM 在 `stream:true` + `tools` 下偶发丢失工具调用参数的**末字符**，
 * 批次间命中率 5%–58%、均值约 26%。后果是模型"已经把答案写对了"，
 * 但落盘/传参的 JSON 缺最后一个 `}`（实测 34 字节
 * `{"books":200,"food":150,"toys":200`），下游严格 JSON.parse 直接失败。
 *
 * 这是上游依赖缺陷，本项目无法改 vLLM 源码，因此在网关的 SSE 包装层做
 * **保守修复**：累计每个 tool_call 的 arguments，在流尾（finish_reason /
 * [DONE]）判定它是否为"可闭合的截断 JSON"；若是，则补发一条只带
 * `index + function.arguments` 的增量 chunk，把缺失的闭合符交给客户端。
 *
 * 修复只在三种条件下成立，否则一律不动（宁可暴露问题也不猜）：
 *   1. 该轮确实收到 finish_reason（提前断流属于失败轮，交由重试）；
 *   2. 累计参数不是合法 JSON（否则无需修复）；
 *   3. 修复结果只是**在原文尾部追加闭合符**（不重写、不删除已有内容）。
 */

/** JSON 词法扫描结果：是否停在字符串内、是否有未转义反斜杠、未闭合括号栈。 */
export interface JsonScanState {
    inString: boolean;
    escape: boolean;
    stack: string[];
}

export function scanJsonState(text: string): JsonScanState {
    let inString = false;
    let escape = false;
    const stack: string[] = [];

    for (const char of text) {
        if (escape) {
            escape = false;
            continue;
        }

        if (inString) {
            if (char === "\\") {
                escape = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === "{" || char === "[") {
            stack.push(char === "{" ? "}" : "]");
        } else if (char === "}" || char === "]") {
            stack.pop();
        }
    }

    return { inString, escape, stack };
}

/**
 * 把被截断的 JSON 文本补成合法 JSON；只在"尾部追加"能凑效时返回结果，
 * 否则返回 null（不猜内容）。已经是合法 JSON 时也返回 null。
 */
export function repairTruncatedJson(text: string): string | null {
    if (text.trim().length === 0) {
        return null;
    }

    try {
        JSON.parse(text);
        return null;
    } catch {
        // 继续尝试修复。
    }

    let candidate = text;

    // 最多回退几层：丢掉尾部一个不完整成员再闭合（应对 `{"a":1,"b"` 这类）。
    for (let attempt = 0; attempt < 5; attempt += 1) {
        let working = candidate.replace(/[\s,]+$/, "");
        let state = scanJsonState(working);

        if (state.escape) {
            working = working.slice(0, -1);
            state = scanJsonState(working);
        }

        if (state.inString) {
            working += '"';
            state = scanJsonState(working);
        }

        // 悬空的 `"key":`（有键无值）无法安全补值，退回上一个逗号重试。
        if (/:\s*$/.test(working)) {
            const lastComma = working.lastIndexOf(",");
            if (lastComma === -1) {
                return null;
            }
            candidate = working.slice(0, lastComma);
            continue;
        }

        const closers = [...state.stack].reverse().join("");
        const repaired = working + closers;

        try {
            JSON.parse(repaired);
            return repaired;
        } catch {
            const lastComma = working.lastIndexOf(",");
            if (lastComma === -1) {
                return null;
            }
            candidate = working.slice(0, lastComma);
        }
    }

    return null;
}

export interface ToolCallArgumentRepair {
    readonly choiceIndex: number;
    readonly toolCallIndex: number;
    /** 需要补发的增量文本（通常是若干闭合符）。 */
    readonly suffix: string;
}

interface AccumulatedArguments {
    choiceIndex: number;
    toolCallIndex: number;
    args: string;
}

/**
 * 按 `choice.index` + `tool_call.index` 累计流式 arguments 增量。
 * 与 Pi 的合并方式对齐（Pi 优先按 index 匹配 tool call block）。
 */
export class ToolCallArgumentTracker {
    private readonly byKey = new Map<string, AccumulatedArguments>();

    observe(payload: unknown): void {
        const choices = (payload as { choices?: unknown } | null)?.choices;

        if (!Array.isArray(choices)) {
            return;
        }

        for (const rawChoice of choices) {
            const choice = rawChoice as {
                index?: unknown;
                delta?: { tool_calls?: unknown };
            };
            const choiceIndex =
                typeof choice.index === "number" ? choice.index : 0;
            const toolCalls = choice.delta?.tool_calls;

            if (!Array.isArray(toolCalls)) {
                continue;
            }

            for (const rawToolCall of toolCalls) {
                const toolCall = rawToolCall as {
                    index?: unknown;
                    function?: { arguments?: unknown };
                };
                const args = toolCall.function?.arguments;

                if (typeof args !== "string" || args.length === 0) {
                    continue;
                }

                const toolCallIndex =
                    typeof toolCall.index === "number" ? toolCall.index : 0;
                const key = `${choiceIndex}:${toolCallIndex}`;
                const existing = this.byKey.get(key);

                if (existing === undefined) {
                    this.byKey.set(key, { choiceIndex, toolCallIndex, args });
                } else {
                    existing.args += args;
                }
            }
        }
    }

    /** 返回需要补发的增量；无截断（或不可保守修复）时返回空数组。 */
    repairs(): readonly ToolCallArgumentRepair[] {
        const repairs: ToolCallArgumentRepair[] = [];

        for (const entry of this.byKey.values()) {
            const repaired = repairTruncatedJson(entry.args);

            if (repaired === null || repaired === entry.args) {
                continue;
            }

            // 只接受"纯追加"修复：不改写、不删除已经发出去的内容。
            if (!repaired.startsWith(entry.args)) {
                continue;
            }

            const suffix = repaired.slice(entry.args.length);

            if (suffix.length === 0) {
                continue;
            }

            repairs.push({
                choiceIndex: entry.choiceIndex,
                toolCallIndex: entry.toolCallIndex,
                suffix,
            });
        }

        return repairs;
    }

    reset(): void {
        this.byKey.clear();
    }
}

export interface StreamChunkMeta {
    id?: string;
    created?: number;
    model?: string;
}

/**
 * 构造补发用的 chunk。刻意**不带** tool_call 的 id / name：
 * 客户端（Pi）按 index 匹配已有 block，带新 id 会被当成第二个工具调用。
 */
export function buildToolCallRepairChunk(
    repair: ToolCallArgumentRepair,
    meta: StreamChunkMeta,
    now: number,
): Record<string, unknown> {
    return {
        id: meta.id ?? `harness-n27-repair-${now}`,
        object: "chat.completion.chunk",
        created: meta.created ?? Math.floor(now / 1000),
        model: meta.model ?? "",
        choices: [
            {
                index: repair.choiceIndex,
                delta: {
                    tool_calls: [
                        {
                            index: repair.toolCallIndex,
                            type: "function",
                            function: { arguments: repair.suffix },
                        },
                    ],
                },
                finish_reason: null,
            },
        ],
    };
}
