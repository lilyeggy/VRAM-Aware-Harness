import { describe, expect, test } from "bun:test";
import { TurnImportanceEvaluator } from "../src/kv/turn-importance-evaluator.ts";

describe("TurnImportanceEvaluator", () => {
  test("can be instantiated", () => {
    const evaluator = new TurnImportanceEvaluator();
    expect(evaluator).toBeDefined();
  });

  test("parses refs from output", () => {
    const evaluator = new TurnImportanceEvaluator();

    const refs1 = evaluator.parseRefs("Some text <refs>turn_3,turn_7</refs>");
    expect(refs1).toEqual([3, 7]);

    const refs2 = evaluator.parseRefs("No refs here");
    expect(refs2).toEqual([]);

    const refs3 = evaluator.parseRefs("Empty refs <refs></refs>");
    expect(refs3).toEqual([]);
  });

  test("strips refs from output", () => {
    const evaluator = new TurnImportanceEvaluator();

    const stripped = evaluator.stripRefs("Some text <refs>turn_3,turn_7</refs> more text");
    expect(stripped).toBe("Some text  more text");
  });

  test("updates ref counts", () => {
    const evaluator = new TurnImportanceEvaluator();

    evaluator.updateRefs("session-1", [3, 7]);
    evaluator.updateRefs("session-1", [3, 5]);

    const refs = evaluator.getSessionRefCounts("session-1");
    expect(refs.get(3)).toBe(2);
    expect(refs.get(7)).toBe(1);
    expect(refs.get(5)).toBe(1);
  });

  test("registers turn metadata", () => {
    const evaluator = new TurnImportanceEvaluator();

    evaluator.registerTurn("session-1", {
      turnId: 1,
      content: "Hello world",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: true,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    const scores = evaluator.getEvictionCandidates("session-1", 5);
    expect(scores).toHaveLength(1);
    expect(scores[0]!.turnId).toBe(1);
  });

  test("computes importance with decay", () => {
    const evaluator = new TurnImportanceEvaluator();

    evaluator.registerTurn("session-1", {
      turnId: 1,
      content: "Old turn",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: false,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    evaluator.registerTurn("session-1", {
      turnId: 5,
      content: "New turn",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: false,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    const scores = evaluator.getEvictionCandidates("session-1", 5);
    expect(scores).toHaveLength(2);

    const oldScore = scores.find(s => s.turnId === 1)!;
    const newScore = scores.find(s => s.turnId === 5)!;

    expect(newScore.importance).toBeGreaterThan(oldScore.importance);
  });

  test("computes importance with refs", () => {
    const evaluator = new TurnImportanceEvaluator();

    evaluator.registerTurn("session-1", {
      turnId: 1,
      content: "Referenced turn",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: false,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    evaluator.registerTurn("session-1", {
      turnId: 2,
      content: "Not referenced",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: false,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    evaluator.updateRefs("session-1", [1, 1, 1]);

    const scores = evaluator.getEvictionCandidates("session-1", 5);
    const refScore = scores.find(s => s.turnId === 1)!;
    const noRefScore = scores.find(s => s.turnId === 2)!;

    expect(refScore.importance).toBeGreaterThan(noRefScore.importance);
  });

  test("computes importance with content type", () => {
    const evaluator = new TurnImportanceEvaluator();

    evaluator.registerTurn("session-1", {
      turnId: 1,
      content: "Here is some code:\n```typescript\nconst x = 1;\n```",
      hasCodeBlocks: true,
      hasDesignDecisions: false,
      isChitChat: false,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    evaluator.registerTurn("session-1", {
      turnId: 2,
      content: "Just chit chat",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: true,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    const scores = evaluator.getEvictionCandidates("session-1", 5);
    const codeScore = scores.find(s => s.turnId === 1)!;
    const chitChatScore = scores.find(s => s.turnId === 2)!;

    expect(codeScore.importance).toBeGreaterThan(chitChatScore.importance);
  });

  test("classifies intent as off_topic", () => {
    const evaluator = new TurnImportanceEvaluator();

    evaluator.registerTurn("session-1", {
      turnId: 1,
      content: "How do I implement a binary search tree in Python?",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: false,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    evaluator.registerTurn("session-1", {
      turnId: 2,
      content: "What is the capital of France?",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: false,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    const intent = evaluator.classifyIntent("session-1", 3, "Tell me about quantum physics");
    expect(intent).toBe("off_topic");
  });

  test("classifies intent as persistent", () => {
    const evaluator = new TurnImportanceEvaluator();

    for (let i = 1; i <= 5; i++) {
      evaluator.registerTurn("session-1", {
        turnId: i,
        content: "How do I implement a binary search tree in Python?",
        hasCodeBlocks: false,
        hasDesignDecisions: false,
        isChitChat: false,
        intent: "one_shot",
        timestamp: Date.now(),
      });
    }

    const intent = evaluator.classifyIntent("session-1", 6, "How do I implement a binary search tree in Python?");
    expect(intent).toBe("persistent");
  });

  test("returns eviction candidates sorted by importance", () => {
    const evaluator = new TurnImportanceEvaluator();

    evaluator.registerTurn("session-1", {
      turnId: 1,
      content: "Old chit chat",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: true,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    evaluator.registerTurn("session-1", {
      turnId: 2,
      content: "Important code:\n```typescript\nconst x = 1;\n```",
      hasCodeBlocks: true,
      hasDesignDecisions: false,
      isChitChat: false,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    evaluator.registerTurn("session-1", {
      turnId: 3,
      content: "Recent turn",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: false,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    const candidates = evaluator.getEvictionCandidates("session-1", 3);
    expect(candidates).toHaveLength(3);

    expect(candidates[0]!.importance).toBeLessThanOrEqual(candidates[1]!.importance);
    expect(candidates[1]!.importance).toBeLessThanOrEqual(candidates[2]!.importance);
  });

  test("clears session data", () => {
    const evaluator = new TurnImportanceEvaluator();

    evaluator.registerTurn("session-1", {
      turnId: 1,
      content: "Test",
      hasCodeBlocks: false,
      hasDesignDecisions: false,
      isChitChat: false,
      intent: "one_shot",
      timestamp: Date.now(),
    });

    evaluator.updateRefs("session-1", [1]);

    evaluator.clearSession("session-1");

    const refs = evaluator.getSessionRefCounts("session-1");
    expect(refs.size).toBe(0);

    const candidates = evaluator.getEvictionCandidates("session-1", 5);
    expect(candidates).toHaveLength(0);
  });
});
