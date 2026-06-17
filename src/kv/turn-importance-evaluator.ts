export interface TurnScore {
  turnId: number;
  importance: number;
  signals: {
    refs: number;
    decay: number;
    content: number;
    intent: number;
  };
}

export type IntentType = "persistent" | "one_shot" | "off_topic";

export interface TurnMetadata {
  turnId: number;
  content: string;
  hasCodeBlocks: boolean;
  hasDesignDecisions: boolean;
  isChitChat: boolean;
  intent: IntentType;
  timestamp: number;
}

export interface TurnImportanceConfig {
  weights: {
    refs: number;
    decay: number;
    content: number;
    intent: number;
  };
  intentThresholds: {
    offTopicJaccard: number;
    persistentJaccard: number;
    persistentMinTurns: number;
  };
}

const DEFAULT_CONFIG: TurnImportanceConfig = {
  weights: {
    refs: 0.3,
    decay: 0.3,
    content: 0.2,
    intent: 0.2,
  },
  intentThresholds: {
    offTopicJaccard: 0.1,
    persistentJaccard: 0.3,
    persistentMinTurns: 3,
  },
};

export class TurnImportanceEvaluator {
  private config: TurnImportanceConfig;
  private refCounts: Map<string, Map<number, number>> = new Map();
  private turnMetadata: Map<string, Map<number, TurnMetadata>> = new Map();

  constructor(config?: Partial<TurnImportanceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  parseRefs(output: string): number[] {
    const refsMatch = output.match(/<refs>(.*?)<\/refs>/);
    if (!refsMatch || !refsMatch[1]) return [];

    const refsStr = refsMatch[1].trim();
    if (!refsStr) return [];

    return refsStr
      .split(",")
      .map(ref => {
        const match = ref.trim().match(/turn_(\d+)/);
        return match && match[1] ? parseInt(match[1], 10) : null;
      })
      .filter((id): id is number => id !== null);
  }

  stripRefs(output: string): string {
    return output.replace(/<refs>.*?<\/refs>/g, "").trim();
  }

  updateRefs(sessionId: string, refs: number[]): void {
    if (!this.refCounts.has(sessionId)) {
      this.refCounts.set(sessionId, new Map());
    }

    const sessionRefs = this.refCounts.get(sessionId)!;
    for (const turnId of refs) {
      const current = sessionRefs.get(turnId) ?? 0;
      sessionRefs.set(turnId, current + 1);
    }
  }

  registerTurn(sessionId: string, metadata: TurnMetadata): void {
    if (!this.turnMetadata.has(sessionId)) {
      this.turnMetadata.set(sessionId, new Map());
    }
    this.turnMetadata.get(sessionId)!.set(metadata.turnId, metadata);
  }

  computeImportance(sessionId: string, turnId: number, currentTurn: number): number {
    const sessionRefs = this.refCounts.get(sessionId);
    const sessionMetadata = this.turnMetadata.get(sessionId);
    const metadata = sessionMetadata?.get(turnId);

    const refScore = this.computeRefScore(sessionRefs, turnId);
    const decayScore = this.computeDecayScore(turnId, currentTurn);
    const contentScore = this.computeContentScore(metadata);
    const intentScore = this.computeIntentScore(metadata);

    return (
      this.config.weights.refs * refScore +
      this.config.weights.decay * decayScore +
      this.config.weights.content * contentScore +
      this.config.weights.intent * intentScore
    );
  }

  private computeRefScore(sessionRefs: Map<number, number> | undefined, turnId: number): number {
    if (!sessionRefs) return 0;

    const refCount = sessionRefs.get(turnId) ?? 0;
    const maxRefCount = Math.max(...Array.from(sessionRefs.values()), 1);

    return refCount / maxRefCount;
  }

  private computeDecayScore(turnId: number, currentTurn: number): number {
    return 1 / (currentTurn - turnId + 1);
  }

  private computeContentScore(metadata: TurnMetadata | undefined): number {
    if (!metadata) return 0.5;

    if (metadata.hasCodeBlocks || metadata.hasDesignDecisions) {
      return 1.0;
    }
    if (metadata.isChitChat) {
      return 0.2;
    }
    return 0.5;
  }

  private computeIntentScore(metadata: TurnMetadata | undefined): number {
    if (!metadata) return 0.5;

    switch (metadata.intent) {
      case "persistent":
        return 1.0;
      case "one_shot":
        return 0.3;
      case "off_topic":
        return 0.05;
      default:
        return 0.5;
    }
  }

  classifyIntent(
    sessionId: string,
    currentTurnId: number,
    currentContent: string
  ): IntentType {
    const sessionMetadata = this.turnMetadata.get(sessionId);
    if (!sessionMetadata) return "one_shot";

    const recentTurns = Array.from(sessionMetadata.values())
      .filter(t => t.turnId < currentTurnId)
      .sort((a, b) => b.turnId - a.turnId)
      .slice(0, 3);

    if (recentTurns.length === 0) return "one_shot";

    const currentTokens = this.tokenize(currentContent);
    const similarities = recentTurns.map(turn => {
      const turnTokens = this.tokenize(turn.content);
      return this.jaccardSimilarity(currentTokens, turnTokens);
    });

    const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;

    if (avgSimilarity < this.config.intentThresholds.offTopicJaccard) {
      return "off_topic";
    }

    const persistentCount = recentTurns.filter(
      (turn, i) => (similarities[i] ?? 0) >= this.config.intentThresholds.persistentJaccard
    ).length;

    if (persistentCount >= this.config.intentThresholds.persistentMinTurns - 1) {
      return "persistent";
    }

    return "one_shot";
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(token => token.length > 0)
    );
  }

  private jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);

    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  getEvictionCandidates(sessionId: string, currentTurn: number): TurnScore[] {
    const sessionMetadata = this.turnMetadata.get(sessionId);
    if (!sessionMetadata) return [];

    const scores: TurnScore[] = [];

    for (const [turnId] of sessionMetadata) {
      const importance = this.computeImportance(sessionId, turnId, currentTurn);
      const sessionRefs = this.refCounts.get(sessionId);
      const metadata = sessionMetadata.get(turnId);

      scores.push({
        turnId,
        importance,
        signals: {
          refs: this.computeRefScore(sessionRefs, turnId),
          decay: this.computeDecayScore(turnId, currentTurn),
          content: this.computeContentScore(metadata),
          intent: this.computeIntentScore(metadata),
        },
      });
    }

    return scores.sort((a, b) => a.importance - b.importance);
  }

  getSessionRefCounts(sessionId: string): Map<number, number> {
    return this.refCounts.get(sessionId) ?? new Map();
  }

  clearSession(sessionId: string): void {
    this.refCounts.delete(sessionId);
    this.turnMetadata.delete(sessionId);
  }
}
