import type { Message, ToolCall, ToolDefinition, CompletionResult, StreamEvent } from "../types/index.ts";
import { LLMClient } from "../client/llm-client.ts";
import { ContextManager } from "./context-manager.ts";

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
  cacheable?: boolean;
  ttlMs?: number;
  timeoutMs?: number;
}

export interface AgentLoopConfig {
  maxIterations: number;
  defaultToolTimeout: number;
  cacheMaxEntries: number;
  cacheMaxSizeBytes: number;
}

interface CacheEntry {
  result: string;
  timestamp: number;
  size: number;
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  maxIterations: 20,
  defaultToolTimeout: 30_000,
  cacheMaxEntries: 1000,
  cacheMaxSizeBytes: 100 * 1024 * 1024,
};

export class AgentLoop {
  private tools: Map<string, ToolHandler> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private config: AgentLoopConfig;
  private llmClient: LLMClient;
  private contextManager: ContextManager;

  constructor(
    llmClient: LLMClient,
    contextManager: ContextManager,
    config?: Partial<AgentLoopConfig>
  ) {
    this.llmClient = llmClient;
    this.contextManager = contextManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  registerTool(tool: ToolHandler): void {
    this.tools.set(tool.name, tool);
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private getCacheKey(toolName: string, args: Record<string, unknown>): string {
    const sortedArgs = JSON.stringify(args, Object.keys(args).sort());
    return `${toolName}:${sortedArgs}`;
  }

  private getFromCache(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const toolName = key.split(":")[0];
    if (!toolName) return null;
    
    const tool = this.tools.get(toolName);
    const ttlMs = tool?.ttlMs ?? 0;
    if (ttlMs > 0 && Date.now() - entry.timestamp > ttlMs) {
      this.cache.delete(key);
      return null;
    }

    return entry.result;
  }

  private setCache(key: string, result: string, toolName: string): void {
    const tool = this.tools.get(toolName);
    if (!tool?.cacheable) return;

    const size = new TextEncoder().encode(result).length;
    if (size > this.config.cacheMaxSizeBytes) return;

    while (this.cache.size >= this.config.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, { result, timestamp: Date.now(), size });
  }

  async executeToolCall(toolCall: ToolCall): Promise<string> {
    const tool = this.tools.get(toolCall.function.name);
    if (!tool) {
      return JSON.stringify({
        error: "tool_not_found",
        message: `Tool ${toolCall.function.name} not found`,
      });
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return JSON.stringify({
        error: "invalid_arguments",
        message: `Invalid JSON in tool arguments: ${toolCall.function.arguments}`,
      });
    }

    const cacheKey = this.getCacheKey(toolCall.function.name, args);
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const timeout = tool.timeoutMs ?? this.config.defaultToolTimeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const result = await tool.handler(args);
      this.setCache(cacheKey, result, toolCall.function.name);
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return JSON.stringify({
          error: "timeout",
          message: `Tool ${toolCall.function.name} timed out after ${timeout}ms`,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async executeToolCalls(toolCalls: ToolCall[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const promises = toolCalls.map(async (toolCall) => {
      const result = await this.executeToolCall(toolCall);
      results.set(toolCall.id, result);
    });
    await Promise.all(promises);
    return results;
  }

  async run(
    sessionId: string,
    userMessage: Message,
    dynamicTools?: ToolDefinition[]
  ): Promise<CompletionResult> {
    const session = this.contextManager.getOrCreateSession(sessionId);
    const messages = this.contextManager.buildMessages(session, userMessage);

    const tools = [...this.getToolDefinitions(), ...(dynamicTools ?? [])];

    let iterations = 0;
    let finalContent = "";
    let finalToolCalls: ToolCall[] | undefined;
    let finalUsage = { prompt_tokens: 0, completion_tokens: 0 };

    while (iterations < this.config.maxIterations) {
      iterations++;

      const result = await this.llmClient.complete(messages, {
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? "auto" : undefined,
      });

      finalContent = result.content;
      finalToolCalls = result.tool_calls;
      finalUsage = result.usage;

      if (!result.tool_calls || result.tool_calls.length === 0) {
        break;
      }

      messages.push({
        role: "assistant",
        content: result.content,
        tool_calls: result.tool_calls,
      });

      const toolResults = await this.executeToolCalls(result.tool_calls);

      for (const toolCall of result.tool_calls) {
        const toolResult = toolResults.get(toolCall.id) ?? "";
        messages.push({
          role: "tool",
          content: toolResult,
          tool_call_id: toolCall.id,
        });
      }
    }

    if (iterations >= this.config.maxIterations) {
      throw new Error(
        `Agent loop exceeded max iterations (${this.config.maxIterations}). ` +
        `This may indicate an infinite tool-calling loop.`
      );
    }

    return {
      content: finalContent,
      tool_calls: finalToolCalls,
      usage: finalUsage,
    };
  }
}
