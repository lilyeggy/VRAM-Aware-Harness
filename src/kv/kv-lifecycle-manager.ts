import type { Message, CompletionResult } from "../types/index.ts";
import { TurnImportanceEvaluator, type TurnMetadata, type TurnScore } from "./turn-importance-evaluator.ts";

export interface VLLMKVClient {
  markTurn(sessionId: string, turnId: number, tokenStart: number, tokenEnd: number): Promise<void>;
  evictTurn(sessionId: string, turnId: number): Promise<number>;
  markProtected(sessionId: string, turnId: number): Promise<void>;
  unmarkProtected(sessionId: string, turnId: number): Promise<void>;
  getMemoryMetrics(): Promise<MemoryMetrics>;
}

export interface MemoryMetrics {
  gpuCacheUsagePerc: number;
  numRequestsRunning: number;
  numRequestsWaiting: number;
  perSessionKVUsage: Map<string, number>;
}

export interface SessionKVState {
  sessionId: string;
  turns: Map<number, TurnState>;
  currentTurn: number;
  coldStorage: Map<number, string>;
}

export interface TurnState {
  turnId: number;
  tokenStart: number;
  tokenEnd: number;
  tier: "hot" | "warm" | "cold" | "protected";
  importance: number;
  createdAt: number;
}

export type PressureLevel = "relaxed" | "normal" | "pressure" | "emergency";

export interface KVLifecycleConfig {
  hotWindowSizes: {
    relaxed: number;
    normal: number;
    pressure: number;
    emergency: number;
  };
  pressureThresholds: {
    relaxed: number;
    normal: number;
    pressure: number;
    emergency: number;
  };
}

const DEFAULT_CONFIG: KVLifecycleConfig = {
  hotWindowSizes: {
    relaxed: 6,
    normal: 4,
    pressure: 2,
    emergency: 1,
  },
  pressureThresholds: {
    relaxed: 0.7,
    normal: 0.85,
    pressure: 0.95,
    emergency: 1.0,
  },
};

export class KVLifecycleManager {
  private sessions: Map<string, SessionKVState> = new Map();
  private evaluator: TurnImportanceEvaluator;
  private kvClient: VLLMKVClient;
  private config: KVLifecycleConfig;
  private pressureLevel: PressureLevel = "normal";

  constructor(
    kvClient: VLLMKVClient,
    evaluator: TurnImportanceEvaluator,
    config?: Partial<KVLifecycleConfig>
  ) {
    this.kvClient = kvClient;
    this.evaluator = evaluator;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getOrCreateSession(sessionId: string): SessionKVState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        turns: new Map(),
        currentTurn: 0,
        coldStorage: new Map(),
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  async markTurn(
    sessionId: string,
    turnId: number,
    tokenStart: number,
    tokenEnd: number,
    content: string
  ): Promise<void> {
    const session = this.getOrCreateSession(sessionId);
    session.currentTurn = Math.max(session.currentTurn, turnId);

    const metadata: TurnMetadata = {
      turnId,
      content,
      hasCodeBlocks: content.includes("```"),
      hasDesignDecisions: /设计|架构|决策|方案/.test(content),
      isChitChat: content.length < 50 && !content.includes("```"),
      intent: this.evaluator.classifyIntent(sessionId, turnId, content),
      timestamp: Date.now(),
    };

    this.evaluator.registerTurn(sessionId, metadata);

    session.turns.set(turnId, {
      turnId,
      tokenStart,
      tokenEnd,
      tier: "hot",
      importance: 0,
      createdAt: Date.now(),
    });

    await this.kvClient.markTurn(sessionId, turnId, tokenStart, tokenEnd);
  }

  async updateTurnImportance(sessionId: string, refs: number[]): Promise<void> {
    this.evaluator.updateRefs(sessionId, refs);

    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const [turnId, turnState] of session.turns) {
      turnState.importance = this.evaluator.computeImportance(
        sessionId,
        turnId,
        session.currentTurn
      );
    }
  }

  async protectTurn(sessionId: string, turnId: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const turn = session.turns.get(turnId);
    if (turn) {
      turn.tier = "protected";
      await this.kvClient.markProtected(sessionId, turnId);
    }
  }

  async unprotectTurn(sessionId: string, turnId: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const turn = session.turns.get(turnId);
    if (turn && turn.tier === "protected") {
      turn.tier = "hot";
      await this.kvClient.unmarkProtected(sessionId, turnId);
    }
  }

  async runEvictionCycle(): Promise<{ evictedTurns: number[]; freedBlocks: number }> {
    const metrics = await this.kvClient.getMemoryMetrics();
    this.updatePressureLevel(metrics.gpuCacheUsagePerc);

    const evictedTurns: number[] = [];
    let freedBlocks = 0;

    for (const [sessionId, session] of this.sessions) {
      const hotWindowSize = this.config.hotWindowSizes[this.pressureLevel];
      const candidates = this.evaluator.getEvictionCandidates(sessionId, session.currentTurn);

      const hotTurns = new Set(
        Array.from(session.turns.keys())
          .sort((a, b) => b - a)
          .slice(0, hotWindowSize)
      );

      for (const candidate of candidates) {
        const turn = session.turns.get(candidate.turnId);
        if (!turn) continue;
        if (turn.tier === "protected") continue;
        if (hotTurns.has(candidate.turnId)) continue;

        if (this.pressureLevel === "emergency" || turn.tier === "warm") {
          const content = this.getTurnContent(sessionId, candidate.turnId);
          if (content) {
            session.coldStorage.set(candidate.turnId, content);
          }

          const blocks = await this.kvClient.evictTurn(sessionId, candidate.turnId);
          freedBlocks += blocks;
          evictedTurns.push(candidate.turnId);

          session.turns.delete(candidate.turnId);
        } else if (turn.tier === "hot") {
          turn.tier = "warm";
        }

        if (metrics.gpuCacheUsagePerc < this.config.pressureThresholds.normal) {
          break;
        }
      }
    }

    return { evictedTurns, freedBlocks };
  }

  private updatePressureLevel(gpuUsagePerc: number): void {
    if (gpuUsagePerc >= this.config.pressureThresholds.emergency) {
      this.pressureLevel = "emergency";
    } else if (gpuUsagePerc >= this.config.pressureThresholds.pressure) {
      this.pressureLevel = "pressure";
    } else if (gpuUsagePerc >= this.config.pressureThresholds.normal) {
      this.pressureLevel = "normal";
    } else {
      this.pressureLevel = "relaxed";
    }
  }

  private getTurnContent(sessionId: string, turnId: number): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return session.coldStorage.get(turnId) ?? null;
  }

  getPressureLevel(): PressureLevel {
    return this.pressureLevel;
  }

  getSessionState(sessionId: string): SessionKVState | undefined {
    return this.sessions.get(sessionId);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.evaluator.clearSession(sessionId);
  }
}
