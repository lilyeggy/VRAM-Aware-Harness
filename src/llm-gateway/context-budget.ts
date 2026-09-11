/**
 * N28：会话上下文撑爆后**永久不可用**。
 *
 * 会话历史由 Pi 持有，Harness 只在模型边界（网关）能看到完整的 messages，
 * 因此上下文压缩只能做在这里。旧行为是：会话累积超过模型窗口后，该会话
 * **之后每个请求都被上游 400 拒绝且永不恢复**（8h 长稳实测：最惨会话
 * 142 连败、0 成功；全部失败中 21.3% 属此类）。
 *
 * 本模块按「轮次边界」丢弃最老的历史，并插入一条显式说明，让模型知道
 * 早前内容已被省略——不静默降级。token 数为保守估计，不引入 tokenizer 依赖。
 *
 * 边界安全：一个「轮次」= 一条 user 消息 + 其后直到下一条 user 之前的所有
 * 消息。因此 assistant(tool_calls) 与其 tool 结果永远落在同一轮里，按轮丢弃
 * 不可能拆散工具调用对（拆散会直接产生非法消息序列）。
 */

import type { ChatMessage } from "./prompt-prefix.ts";

export interface ContextBudgetLimits {
    /** 预算 token 数；<= 0 表示关闭压缩。 */
    budgetTokens: number;
    /** 丢弃历史时插入的说明文本；不传则用内置默认。 */
    notice?: string;
}

export interface CompactionOutcome {
    messages: ChatMessage[];
    compacted: boolean;
    droppedMessages: number;
    droppedTurns: number;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
}

export const DEFAULT_COMPACTION_NOTICE =
    "[上下文压缩] 本次请求之前的部分更早对话因超出上下文预算已被省略。"
    + "更早的约定、文件内容或工具结果可能不再可见；若任务依赖它们，"
    + "请以当前工作区状态为准，或明确向用户确认，不要凭印象续写。";

/** CJK 约 1 token/字，其余按 4 字符/token 估算（保守，宁大不小）。 */
export function estimateTextTokens(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    let cjk = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (
            (cp >= 0x2e80 && cp <= 0x9fff)   // CJK 部首/假名/汉字
            || (cp >= 0xf900 && cp <= 0xfaff) // CJK 兼容
            || (cp >= 0xff00 && cp <= 0xffef) // 全角
        ) {
            cjk++;
        }
    }
    return cjk + Math.ceil((text.length - cjk) / 4);
}

function contentText(content: unknown): string {
    if (content === null || content === undefined) {
        return "";
    }
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") {
                    return part;
                }
                const text = (part as { text?: unknown } | null)?.text;
                return typeof text === "string" ? text : JSON.stringify(part);
            })
            .join("\n");
    }
    return JSON.stringify(content);
}

function messageTokens(message: ChatMessage): number {
    // 每条消息的角色标签与分隔符约占 4 token。
    let total = 4 + estimateTextTokens(contentText(message.content));
    if (message.tool_calls !== undefined) {
        total += estimateTextTokens(JSON.stringify(message.tool_calls));
    }
    if (typeof message.name === "string") {
        total += estimateTextTokens(message.name);
    }
    return total;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
    let total = 0;
    for (const message of messages) {
        total += messageTokens(message);
    }
    return total;
}

export function estimateToolsTokens(tools: unknown): number {
    if (!Array.isArray(tools) || tools.length === 0) {
        return 0;
    }
    return estimateTextTokens(JSON.stringify(tools));
}

/**
 * 把消息切成轮次：每条 user 消息开启新的一轮。轮次之前的
 * 非 user 消息（正常应已被 system 取出）归入首轮，保证不丢内容。
 */
export function splitTurns(messages: readonly ChatMessage[]): ChatMessage[][] {
    const turns: ChatMessage[][] = [];
    for (const message of messages) {
        if (message.role === "user" || turns.length === 0) {
            turns.push([message]);
        } else {
            turns[turns.length - 1]!.push(message);
        }
    }
    return turns;
}

/** 丢弃轮次后，开头可能残留孤立的 tool 结果，会让上游直接拒绝。 */
function dropLeadingOrphanToolMessages(messages: readonly ChatMessage[]): ChatMessage[] {
    let index = 0;
    while (index < messages.length && messages[index]!.role === "tool") {
        index++;
    }
    return messages.slice(index);
}

export function compactConversation(
    messages: readonly ChatMessage[],
    toolsTokens: number,
    limits: ContextBudgetLimits,
): CompactionOutcome {
    const before = estimateMessagesTokens(messages) + toolsTokens;
    const unchanged: CompactionOutcome = {
        messages: [...messages],
        compacted: false,
        droppedMessages: 0,
        droppedTurns: 0,
        estimatedTokensBefore: before,
        estimatedTokensAfter: before,
    };
    if (limits.budgetTokens <= 0 || messages.length === 0) {
        return unchanged;
    }

    const systemMessages = messages.filter((m) => m.role === "system");
    const conversational = messages.filter((m) => m.role !== "system");
    if (conversational.length === 0) {
        return unchanged;
    }
    const turns = splitTurns(conversational);

    // 固定开销：system + 工具定义 + 压缩说明本身。
    const notice = limits.notice ?? DEFAULT_COMPACTION_NOTICE;
    const fixedTokens = estimateMessagesTokens(systemMessages)
        + toolsTokens
        + messageTokens({ role: "system", content: notice });

    // 求「从最近往回数，最多能留下几轮」。取下界 1 轮：不为凑预算把历史清空，
    // 但一轮都放不下时也只能给一轮（此时请求本就超限，压缩无法救，交给上游裁决）。
    let keep = 1;
    let keptTokens = estimateMessagesTokens(turns[turns.length - 1]!);
    for (let k = 2; k <= turns.length; k++) {
        const turnTokens = estimateMessagesTokens(turns[turns.length - k]!);
        if (fixedTokens + keptTokens + turnTokens > limits.budgetTokens) {
            break;
        }
        keptTokens += turnTokens;
        keep = k;
    }

    if (keep >= turns.length) {
        return unchanged;
    }

    const droppedTurns = turns.slice(0, turns.length - keep);
    const kept = dropLeadingOrphanToolMessages(turns.slice(turns.length - keep).flat());
    const droppedMessages = droppedTurns.reduce((sum, turn) => sum + turn.length, 0);
    const next = [
        ...systemMessages,
        { role: "system", content: notice } as ChatMessage,
        ...kept,
    ];
    return {
        messages: next,
        compacted: true,
        droppedMessages,
        droppedTurns: droppedTurns.length,
        estimatedTokensBefore: before,
        estimatedTokensAfter: estimateMessagesTokens(next) + toolsTokens,
    };
}
