import type { Message, CompletionResult } from "../types/index.ts";
import { LLMClient } from "../client/llm-client.ts";
import { STATIC_SYSTEM_PROMPT, assertStaticPrompt } from "./system-prompt.ts";

// Session 的上下文
export interface SessionContext {
  sessionId: string;
  projectContext: string;
  frozenSummary: string;
  liveTurns: Message[];
  totalTokens: number;
  lastPromptTokens: number;
  hasAttemptedRecovery: boolean;
}

/*

管理上下文的配置：
 1. 多少轮是热层？ 我觉得还有改进空间，我们因为要区分热层、暖层和冷层，只有这个maxLiveTurns参数或许不太够
 2. 压缩上下文的门槛。   -- 这个值是谁的门槛？
 3. 最大的上下文 token 数   -- 这个和要压缩的上下文的门槛有什么区别？
 4. 到了要压缩上下文的时候，我们让模型进行压缩的 prompt

*/

export interface ContextManagerConfig {
  maxLiveTurns: number;
  compressionThreshold: number;
  maxContextTokens: number;
  summarizerPrompt: string;
}

// 默认的上下文管理配置
const DEFAULT_CONFIG: ContextManagerConfig = {
  maxLiveTurns: 4,
  compressionThreshold: 32_000, 
  maxContextTokens: 128_000,
  summarizerPrompt: `You are a conversation summarizer. Summarize the following conversation into a concise summary.

Rules:
1. Preserve all code blocks verbatim - do not summarize code
2. Preserve all important decisions, configurations, and technical details
3. Compress narrative and conversational text
4. Maintain chronological order
5. Output only the summary, no explanations

Conversation to summarize:
`,
};

export class ContextManager {
  private sessions: Map<string, SessionContext> = new Map();
  private config: ContextManagerConfig;
  private llmClient: LLMClient;

  constructor(llmClient: LLMClient, config?: Partial<ContextManagerConfig>) {
    this.llmClient = llmClient;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getOrCreateSession(sessionId: string, projectContext: string = ""): SessionContext {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        projectContext,
        frozenSummary: "",
        liveTurns: [],
        totalTokens: 0,
        lastPromptTokens: 0,
        hasAttemptedRecovery: false,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  getSession(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  buildMessages(session: SessionContext, userMessage: Message): Message[] {
    const messages: Message[] = [];

    messages.push({ role: "system", content: STATIC_SYSTEM_PROMPT });

    if (session.projectContext) {
      messages.push({ role: "user", content: session.projectContext });
      messages.push({ role: "assistant", content: "已了解项目上下文" });
    }

    if (session.frozenSummary) {
      messages.push({ role: "user", content: session.frozenSummary });
      messages.push({ role: "assistant", content: "已了解前情" });
    }

    for (const turn of session.liveTurns) {
      messages.push(turn);
    }

    messages.push(userMessage);

    return messages;
  }

  async addTurn(
    sessionId: string,
    userMessage: Message,
    assistantResponse: CompletionResult
  ): Promise<{ messages: Message[]; compressed: boolean }> {
    const session = this.getOrCreateSession(sessionId);

    session.liveTurns.push(userMessage);
    session.liveTurns.push({
      role: "assistant",
      content: assistantResponse.content,
      tool_calls: assistantResponse.tool_calls,
    });

    session.lastPromptTokens = assistantResponse.usage.prompt_tokens;
    session.totalTokens = assistantResponse.usage.prompt_tokens + assistantResponse.usage.completion_tokens;

    let compressed = false;
    if (this.shouldCompress(session)) {
      await this.compressSession(session);
      compressed = true;
    }

    if (session.totalTokens > this.config.maxContextTokens) {
      throw new Error(
        `Session ${sessionId} exceeded max context tokens (${this.config.maxContextTokens}). ` +
        `Consider starting a new session.`
      );
    }

    const messages = this.buildMessages(session, userMessage);
    return { messages, compressed };
  }

  shouldCompress(session: SessionContext): boolean {
    return session.lastPromptTokens > this.config.compressionThreshold ||
           session.liveTurns.length > this.config.maxLiveTurns * 2;
  }

  async compressSession(session: SessionContext): Promise<void> {
    if (session.liveTurns.length <= 2) return;

    const turnsToCompress = session.liveTurns.slice(0, -this.config.maxLiveTurns * 2);
    const remainingTurns = session.liveTurns.slice(-this.config.maxLiveTurns * 2);

    const conversationText = turnsToCompress
      .map(turn => `${turn.role}: ${turn.content}`)
      .join("\n\n");

    const summaryResult = await this.llmClient.complete([
      { role: "system", content: this.config.summarizerPrompt },
      { role: "user", content: conversationText },
    ], { max_tokens: 2000 });

    const newSummary = session.frozenSummary
      ? `${session.frozenSummary}\n\n${summaryResult.content}`
      : summaryResult.content;

    session.frozenSummary = newSummary;
    session.liveTurns = remainingTurns;
  }

  triggerCompression(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.compressSession(session).catch(console.error);
    }
  }

  getSessionPressure(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    return session.lastPromptTokens / this.config.maxContextTokens;
  }

  markRecoveryAttempted(sessionId: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.hasAttemptedRecovery = true;
  }

  hasRecoveryAttempted(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.hasAttemptedRecovery ?? false;
  }

  exportSummary(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session?.frozenSummary ?? null;
  }

  importSummary(sessionId: string, summary: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.frozenSummary = summary;
  }
}
