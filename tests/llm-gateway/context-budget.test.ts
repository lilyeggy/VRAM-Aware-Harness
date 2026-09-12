import { describe, expect, test } from "bun:test";

import {
    compactConversation,
    DEFAULT_COMPACTION_NOTICE,
    estimateTextTokens,
    splitTurns,
    type ContextBudgetLimits,
} from "../../src/llm-gateway/context-budget.ts";
import { LlmGateway } from "../../src/llm-gateway/llm-gateway.ts";
import {
    ModelRouter,
    type LlmBackend,
} from "../../src/llm-gateway/model-router.ts";
import type { ChatMessage } from "../../src/llm-gateway/prompt-prefix.ts";

const LIMITS: ContextBudgetLimits = { budgetTokens: 400 };

function bigTurn(tag: string, chars: number): ChatMessage[] {
    return [
        { role: "user", content: `${tag} 请处理这段输入：${"甲".repeat(chars)}` },
        { role: "assistant", content: `${tag} 已完成` },
    ];
}

describe("N28 上下文压缩：轮次边界与不变量", () => {
    test("未超预算时原样返回", () => {
        const messages: ChatMessage[] = [
            { role: "system", content: "系统提示" },
            ...bigTurn("A", 20),
        ];
        const outcome = compactConversation(messages, 0, LIMITS);
        expect(outcome.compacted).toBe(false);
        expect(outcome.messages).toEqual(messages);
        expect(outcome.droppedTurns).toBe(0);
    });

    test("budgetTokens=0 表示关闭压缩", () => {
        const messages: ChatMessage[] = [
            { role: "system", content: "系统提示" },
            ...bigTurn("A", 5_000),
            ...bigTurn("B", 5_000),
        ];
        const outcome = compactConversation(messages, 0, { budgetTokens: 0 });
        expect(outcome.compacted).toBe(false);
        expect(outcome.messages).toHaveLength(messages.length);
    });

    test("超预算时丢弃最老的轮次，保留系统提示与最近轮次，并插入显式说明", () => {
        const system: ChatMessage = { role: "system", content: "系统提示：不要编造" };
        const messages: ChatMessage[] = [
            system,
            ...bigTurn("OLD1", 800),
            ...bigTurn("OLD2", 800),
            ...bigTurn("NEW1", 40),
            ...bigTurn("NEW2", 40),
        ];
        const outcome = compactConversation(messages, 0, LIMITS);

        expect(outcome.compacted).toBe(true);
        expect(outcome.droppedTurns).toBeGreaterThan(0);
        expect(outcome.messages[0]).toEqual(system);
        expect(outcome.messages[1]).toEqual({ role: "system", content: DEFAULT_COMPACTION_NOTICE });

        const text = JSON.stringify(outcome.messages);
        expect(text).toContain("NEW2");
        expect(text).toContain("NEW1");
        expect(text).not.toContain("OLD1");
        expect(text).not.toContain("OLD2");
        expect(outcome.estimatedTokensAfter).toBeLessThan(outcome.estimatedTokensBefore);
    });

    test("工具调用对不会被拆散（assistant.tool_calls 与其 tool 结果同轮存亡）", () => {
        const messages: ChatMessage[] = [
            { role: "system", content: "sys" },
            // 一轮：user -> assistant(tool_calls) -> tool 结果
            { role: "user", content: `老任务 ${"乙".repeat(900)}` },
            {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "call-old", function: { name: "write", arguments: "{}" } }],
            },
            { role: "tool", tool_call_id: "call-old", content: `老工具结果 ${"丙".repeat(900)}` },
            // 最近一轮
            { role: "user", content: "新任务" },
            { role: "assistant", content: "新回答" },
        ];
        const outcome = compactConversation(messages, 0, { budgetTokens: 300 });

        expect(outcome.compacted).toBe(true);
        // 压缩后首条非 system 消息绝不能是孤立的 tool 结果
        const conversational = outcome.messages.filter((m) => m.role !== "system");
        expect(conversational[0]!.role).toBe("user");
        const orphan = outcome.messages.some(
            (m) => m.role === "tool"
                && !outcome.messages.some((a) => Array.isArray(a.tool_calls)
                    && (a.tool_calls as Array<{ id?: string }>).some((c) => c.id === m.tool_call_id)),
        );
        expect(orphan).toBe(false);
        // 被丢弃的 tool 结果与其 assistant 一起消失，不留半截
        const text = JSON.stringify(outcome.messages);
        expect(text.includes("call-old")).toBe(text.includes("老工具结果"));
    });

    test("预算极紧时至少保留最近 1 轮，不会把历史清空", () => {
        const messages: ChatMessage[] = [
            { role: "system", content: "sys" },
            ...bigTurn("R1", 2_000),
            ...bigTurn("R2", 2_000),
            ...bigTurn("R3", 2_000),
        ];
        const outcome = compactConversation(messages, 0, { budgetTokens: 10 });
        expect(outcome.compacted).toBe(true);
        const conversational = outcome.messages.filter((m) => m.role !== "system");
        expect(conversational.length).toBeGreaterThan(0);
        expect(JSON.stringify(outcome.messages)).toContain("R3");
        expect(JSON.stringify(outcome.messages)).not.toContain("R1");
    });

    test("splitTurns 以 user 消息开轮，轮内顺序不变", () => {
        const turns = splitTurns([
            { role: "user", content: "u1" },
            { role: "assistant", content: "a1" },
            { role: "tool", tool_call_id: "t", content: "r1" },
            { role: "user", content: "u2" },
            { role: "assistant", content: "a2" },
        ]);
        expect(turns).toHaveLength(2);
        expect(turns[0]!.map((m) => m.content)).toEqual(["u1", "a1", "r1"]);
        expect(turns[1]!.map((m) => m.content)).toEqual(["u2", "a2"]);
    });

    test("token 估算对中文按字计、对 ASCII 按 4 字符计", () => {
        expect(estimateTextTokens("")).toBe(0);
        expect(estimateTextTokens("中文四个字")).toBe(5);
        expect(estimateTextTokens("abcdefgh")).toBe(2);
    });
});

const BACKEND: LlmBackend[] = [
    { id: "vllm", baseUrl: "http://gpu0/v1", model: "qwen", logicalModel: "qwen" },
];

function capturingUpstream(seen: { body?: Record<string, unknown> }): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
        seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
            JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }) as unknown as typeof fetch;
}

describe("N28 网关集成：压缩在转发前生效", () => {
    async function call(options: { contextBudgetTokens?: number }): Promise<Record<string, unknown>> {
        const seen: { body?: Record<string, unknown> } = {};
        const gateway = new LlmGateway(new ModelRouter(BACKEND), {
            fetchImpl: capturingUpstream(seen),
            prefixCacheEnabled: true,
            streamUsageCapture: false,
            ...options,
        });
        const messages: ChatMessage[] = [
            { role: "system", content: "系统提示" },
            ...bigTurn("OLD", 4_000),
            ...bigTurn("NEW", 20),
        ];
        const res = await gateway.handleChatCompletions(new Request(
            "http://gw/v1/chat/completions",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: "qwen", messages }),
            },
        ));
        expect(res.status).toBe(200);
        return seen.body!;
    }

    test("预算开启时上游收到的是压缩后的消息", async () => {
        const body = await call({ contextBudgetTokens: 600 });
        const text = JSON.stringify(body.messages);
        expect(text).toContain("NEW");
        expect(text).not.toContain("OLD");
        expect(text).toContain("上下文压缩");
    });

    test("预算关闭时上游收到完整历史（旧行为不变）", async () => {
        const body = await call({ contextBudgetTokens: 0 });
        const text = JSON.stringify(body.messages);
        expect(text).toContain("NEW");
        expect(text).toContain("OLD");
        expect(text).not.toContain("上下文压缩");
    });
});
