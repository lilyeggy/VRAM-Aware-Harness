import { describe, expect, it } from "bun:test";

import { LlmGateway } from "../../src/llm-gateway/llm-gateway.ts";
import { ModelRouter, type LlmBackend } from "../../src/llm-gateway/model-router.ts";
import {
    buildToolCallRepairChunk,
    repairTruncatedJson,
    ToolCallArgumentTracker,
} from "../../src/llm-gateway/tool-call-argument-repair.ts";

const BACKENDS: LlmBackend[] = [
    { id: "vllm-local", baseUrl: "http://upstream/v1", model: "real-model", logicalModel: "qwen" },
];

describe("N27 repairTruncatedJson：只做尾部追加的保守修复", () => {
    it("补上被丢掉的最后一个右花括号（真机 T3/T6 的原始形态）", () => {
        expect(repairTruncatedJson('{"books":200,"food":150,"toys":200'))
            .toBe('{"books":200,"food":150,"toys":200}');
    });

    it("停在字符串中间时先闭合字符串再闭合结构", () => {
        expect(repairTruncatedJson('{"path":"a/b')).toBe('{"path":"a/b"}');
    });

    it("补上被丢掉的右方括号", () => {
        expect(repairTruncatedJson('{"items":[1,2')).toBe('{"items":[1,2]}');
    });

    it("丢弃悬空的尾随逗号", () => {
        expect(repairTruncatedJson('{"a":1,')).toBe('{"a":1}');
    });

    it("尾部成员不完整时退回上一个逗号（有键无值的情况）", () => {
        expect(repairTruncatedJson('{"a":1,"b"')).toBe('{"a":1}');
    });

    it("已经是合法 JSON → 返回 null（无需修复，不产生多余增量）", () => {
        expect(repairTruncatedJson('{"a":1}')).toBeNull();
    });

    it("无法保守修复时返回 null，不猜内容", () => {
        expect(repairTruncatedJson("")).toBeNull();
        expect(repairTruncatedJson("   ")).toBeNull();
        expect(repairTruncatedJson("not json at all")).toBeNull();
        expect(repairTruncatedJson('{"a":')).toBeNull();
    });
});

describe("N27 ToolCallArgumentTracker：按 choice+tool_call index 累计", () => {
    it("跨多个 chunk 拼接同一个工具调用的参数", () => {
        const tracker = new ToolCallArgumentTracker();
        tracker.observe({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] } }] });
        tracker.observe({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ":1" } }] } }] });

        const repairs = tracker.repairs();
        expect(repairs).toHaveLength(1);
        expect(repairs[0]!.suffix).toBe("}");
    });

    it("参数完整时无修复；多个工具调用各自独立判定", () => {
        const tracker = new ToolCallArgumentTracker();
        tracker.observe({ choices: [{ index: 0, delta: { tool_calls: [
            { index: 0, function: { arguments: '{"ok":true}' } },
            { index: 1, function: { arguments: '{"n":1' } },
        ] } }] });

        const repairs = tracker.repairs();
        expect(repairs).toHaveLength(1);
        expect(repairs[0]!.toolCallIndex).toBe(1);
        expect(repairs[0]!.suffix).toBe("}");
    });

    it("补发 chunk 不带 tool_call id/name（否则客户端会当成第二个工具调用）", () => {
        const chunk = buildToolCallRepairChunk(
            { choiceIndex: 0, toolCallIndex: 0, suffix: "}" },
            { id: "cmpl-1", created: 123, model: "qwen" },
            1_700_000_000_000,
        ) as {
            choices: Array<{ index: number; finish_reason: null; delta: { tool_calls: Array<Record<string, unknown>> } }>;
        };
        const toolCall = chunk.choices[0]!.delta.tool_calls[0]!;
        expect(chunk.choices[0]!.index).toBe(0);
        expect(chunk.choices[0]!.finish_reason).toBeNull();
        expect(toolCall.index).toBe(0);
        expect(toolCall.id).toBeUndefined();
        expect(toolCall).not.toHaveProperty("name");
        expect((toolCall.function as { arguments: string }).arguments).toBe("}");
    });
});

function sseStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (index >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(chunks[index]));
            index += 1;
        },
    });
}

function gatewayWithStream(chunks: readonly string[]) {
    const router = new ModelRouter(BACKENDS);
    const gateway = new LlmGateway(router, {
        fetchImpl: (async () => new Response(sseStream(chunks), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        })) as unknown as typeof fetch,
    });
    return { router, gateway };
}

function chatRequest(): Request {
    return new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "qwen", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
}

/** 按客户端（Pi）的方式合并 SSE 里的 tool_call 参数增量。 */
function accumulateArguments(sseText: string): string {
    let args = "";
    for (const line of sseText.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload.length === 0 || payload === "[DONE]") continue;
        const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
        };
        for (const choice of parsed.choices ?? []) {
            for (const toolCall of choice.delta?.tool_calls ?? []) {
                if (typeof toolCall.function?.arguments === "string") {
                    args += toolCall.function.arguments;
                }
            }
        }
    }
    return args;
}

function dataLines(sseText: string): string[] {
    return sseText.split("\n").filter((line) => line.trim().startsWith("data:"));
}

const TRUNCATED_STREAM = [
    'data: {"id":"cmpl-1","created":1,"model":"qwen","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write","arguments":"{\\"books\\":200,"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"cmpl-1","created":1,"model":"qwen","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"food\\":150"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"cmpl-1","created":1,"model":"qwen","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
];

describe("N27 网关 SSE 透传：上游丢掉末字符时补发闭合增量", () => {
    it("被截断的工具调用参数在客户端侧变成合法 JSON，且修复增量排在 finish 之前", async () => {
        const { gateway } = gatewayWithStream(TRUNCATED_STREAM);
        const response = await gateway.handleChatCompletions(chatRequest());
        const text = await response.text();

        const raw = accumulateArguments(text);
        // 上游只发到 `{"books":200,"food":150`，网关补齐闭合符后必须可解析。
        expect(raw).toBe('{"books":200,"food":150}');
        expect(JSON.parse(raw)).toEqual({ books: 200, food: 150 });

        const lines = dataLines(text);
        const repairIndex = lines.findIndex((line) => line.includes("harness-n27-repair") || line.includes('"arguments":"}"'));
        const finishIndex = lines.findIndex((line) => line.includes('"finish_reason":"tool_calls"'));
        expect(repairIndex).toBeGreaterThanOrEqual(0);
        expect(finishIndex).toBeGreaterThan(repairIndex);
        expect(lines.at(-1)).toContain("[DONE]");
        expect(gateway.toolCallRepairStats().repairedToolCalls).toBe(1);
    });

    it("参数完整时不注入任何增量（不改变正常流）", async () => {
        const complete = [
            'data: {"id":"cmpl-1","created":1,"model":"qwen","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write","arguments":"{\\"a\\":1}"}}]},"finish_reason":null}]}\n\n',
            'data: {"id":"cmpl-1","created":1,"model":"qwen","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
            "data: [DONE]\n\n",
        ];
        const { gateway } = gatewayWithStream(complete);
        const text = await (await gateway.handleChatCompletions(chatRequest())).text();

        expect(accumulateArguments(text)).toBe('{"a":1}');
        expect(text).not.toContain("harness-n27-repair");
        expect(gateway.toolCallRepairStats().repairedToolCalls).toBe(0);
    });

    it("没有 finish_reason 的提前断流不做修复（该轮本就算失败，不能假装成功）", async () => {
        const interrupted = [
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"arguments":"{\\"a\\":1"}}]},"finish_reason":null}]}\n\n',
        ];
        const { gateway } = gatewayWithStream(interrupted);
        const text = await (await gateway.handleChatCompletions(chatRequest())).text();

        expect(accumulateArguments(text)).toBe('{"a":1');
        expect(text).not.toContain("harness-n27-repair");
        expect(gateway.toolCallRepairStats().repairedToolCalls).toBe(0);
    });
});
