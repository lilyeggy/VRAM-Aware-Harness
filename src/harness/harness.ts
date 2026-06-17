import type { Message, CompletionResult, ToolDefinition } from "../types/index.ts";
import { LLMClient } from "../client/llm-client.ts";
import { ContextManager } from "./context-manager.ts";
import { AgentLoop } from "./agent-loop.ts";
import { OutputValidator } from "./validator.ts";
import { assertStaticPrompt } from "./system-prompt.ts";

export interface HarnessConfig {
  llm: {
    baseURL: string;
    model: string;
    apiKey?: string;
  };
  context?: {
    maxLiveTurns?: number;
    compressionThreshold?: number;
    maxContextTokens?: number;
  };
  agent?: {
    maxIterations?: number;
    defaultToolTimeout?: number;
  };
  validator?: {
    maxRetries?: number;
  };
}

export interface ProcessOptions {
  sessionId: string;
  userMessage: Message;
  projectContext?: string;
  dynamicTools?: ToolDefinition[];
  validator?: (content: string) => { valid: boolean; error?: string };
  jsonSchema?: Record<string, unknown>;
}

export class Harness {
  private llmClient: LLMClient;
  private contextManager: ContextManager;
  private agentLoop: AgentLoop;
  private validator: OutputValidator;

  constructor(config: HarnessConfig) {
    this.llmClient = new LLMClient({
      baseURL: config.llm.baseURL,
      model: config.llm.model,
      apiKey: config.llm.apiKey,
    });

    this.contextManager = new ContextManager(this.llmClient, config.context);
    this.agentLoop = new AgentLoop(this.llmClient, this.contextManager, config.agent);
    this.validator = new OutputValidator(this.llmClient, config.validator);
  }

  async process(options: ProcessOptions): Promise<CompletionResult> {
    const { sessionId, userMessage, projectContext, dynamicTools, validator, jsonSchema } = options;

    // 1. Prefix 守卫：校验 system prompt
    assertStaticPrompt(userMessage.content);

    // 2. 获取或创建会话
    const session = this.contextManager.getOrCreateSession(sessionId, projectContext);

    // 3. 构建消息
    const messages = this.contextManager.buildMessages(session, userMessage);

    // 4. 运行 Agent Loop（带工具调用）
    let result = await this.agentLoop.run(sessionId, userMessage, dynamicTools);

    // 5. Output Validator 校验（如果提供了校验器）
    if (validator || jsonSchema) {
      const validationResult = await this.validator.validateWithRetry(
        messages,
        validator ?? jsonSchema!,
        { max_tokens: result.usage.completion_tokens }
      );

      if (!validationResult.result.valid) {
        // 6. 求助模式：校验失败后，发送求助消息
        if (!this.contextManager.hasRecoveryAttempted(sessionId)) {
          this.contextManager.markRecoveryAttempted(sessionId);
          const helpRequest = this.validator.createHelpRequest(
            validationResult.result.details ?? validationResult.result.error ?? "Unknown error"
          );
          messages.push(helpRequest);

          // 重新运行一次，这次不校验
          result = await this.agentLoop.run(sessionId, userMessage, dynamicTools);
        }
      } else if (validationResult.correctedContent) {
        result = {
          ...result,
          content: validationResult.correctedContent,
        };
      }
    }

    // 7. 更新会话状态
    await this.contextManager.addTurn(sessionId, userMessage, result);

    return result;
  }

  // 便捷方法：注册工具
  registerTool(tool: Parameters<typeof this.agentLoop.registerTool>[0]): void {
    this.agentLoop.registerTool(tool);
  }

  // 便捷方法：获取会话压力
  getSessionPressure(sessionId: string): number {
    return this.contextManager.getSessionPressure(sessionId);
  }

  // 便捷方法：导出摘要（用于跨 session 衔接）
  exportSummary(sessionId: string): string | null {
    return this.contextManager.exportSummary(sessionId);
  }

  // 便捷方法：导入摘要
  importSummary(sessionId: string, summary: string): void {
    this.contextManager.importSummary(sessionId, summary);
  }
}
