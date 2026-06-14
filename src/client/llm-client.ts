import type { Message, CompletionOptions, CompletionResult, StreamEvent, LLMClientConfig } from "../types/index.ts";

export class LLMClient {
  private config: Required<LLMClientConfig>;

  constructor(config: LLMClientConfig) {
    this.config = {
      ...config,
      apiKey: config.apiKey ?? "not-needed",
      defaultTimeout: config.defaultTimeout ?? 120_000,
    };
  }

  async complete(messages: Message[], options?: CompletionOptions): Promise<CompletionResult> {
    const timeout = options?.max_tokens ? this.config.defaultTimeout : this.config.defaultTimeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages,
        stream: false,
      };
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;
      if (options?.tools !== undefined) body.tools = options.tools;
      if (options?.tool_choice !== undefined) body.tool_choice = options.tool_choice;

      const res = await fetch(`${this.config.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM API error ${res.status}: ${text}`);
      }

      const json = await res.json() as any;
      const choice = json.choices?.[0];
      if (!choice) throw new Error("No choices in response");

      return {
        content: choice.message?.content ?? "",
        tool_calls: choice.message?.tool_calls ?? undefined,
        usage: json.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(messages: Message[], options?: CompletionOptions): AsyncIterable<StreamEvent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.defaultTimeout);

    try {
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages,
        stream: true,
      };
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;
      if (options?.tools !== undefined) body.tools = options.tools;
      if (options?.tool_choice !== undefined) body.tool_choice = options.tool_choice;

      const res = await fetch(`${this.config.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM API error ${res.status}: ${text}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") {
            if (trimmed === "data: [DONE]") {
              yield { type: "done" };
            }
            continue;
          }
          if (!trimmed.startsWith("data: ")) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              yield { type: "content", content: delta.content };
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.index !== undefined && tc.function?.name) {
                  yield {
                    type: "tool_call_start",
                    tool_call: {
                      id: tc.id ?? "",
                      type: "function",
                      function: { name: tc.function.name, arguments: tc.function.arguments ?? "" },
                    },
                  };
                } else if (tc.function?.arguments) {
                  yield { type: "tool_call_delta", delta: tc.function.arguments };
                }
              }
            }
            if (json.usage) {
              yield { type: "usage", usage: json.usage };
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
