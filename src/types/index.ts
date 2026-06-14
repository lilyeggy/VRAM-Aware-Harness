export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMClientConfig {
  baseURL: string;
  model: string;
  apiKey?: string;
  defaultTimeout?: number;
}

export interface CompletionOptions {
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

export interface CompletionResult {
  content: string;
  tool_calls?: ToolCall[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export interface StreamEvent {
  type: "content" | "tool_call_start" | "tool_call_delta" | "tool_call_done" | "usage" | "done";
  content?: string;
  tool_call?: ToolCall;
  delta?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}
