import { describe, expect, test } from "bun:test";
import { TurnImportanceEvaluator } from "../src/kv/turn-importance-evaluator.ts";
import { KVLifecycleManager } from "../src/kv/kv-lifecycle-manager.ts";
import type { VLLMKVClient, MemoryMetrics } from "../src/kv/kv-lifecycle-manager.ts";

describe("KVLifecycleManager", () => {
  const createMockKVClient = (): VLLMKVClient => ({
    markTurn: async () => {},
    evictTurn: async () => 10,
    markProtected: async () => {},
    unmarkProtected: async () => {},
    getMemoryMetrics: async () => ({
      gpuCacheUsagePerc: 0.5,
      numRequestsRunning: 1,
      numRequestsWaiting: 0,
      perSessionKVUsage: new Map(),
    }),
  });

  test("can be instantiated", () => {
    const kvClient = createMockKVClient();
    const evaluator = new TurnImportanceEvaluator();
    const manager = new KVLifecycleManager(kvClient, evaluator);
    expect(manager).toBeDefined();
  });

  test("creates new session", () => {
    const kvClient = createMockKVClient();
    const evaluator = new TurnImportanceEvaluator();
    const manager = new KVLifecycleManager(kvClient, evaluator);

    const session = manager.getOrCreateSession("test-session");
    expect(session.sessionId).toBe("test-session");
    expect(session.turns.size).toBe(0);
    expect(session.currentTurn).toBe(0);
  });

  test("returns existing session", () => {
    const kvClient = createMockKVClient();
    const evaluator = new TurnImportanceEvaluator();
    const manager = new KVLifecycleManager(kvClient, evaluator);

    manager.getOrCreateSession("test-session");
    const session = manager.getOrCreateSession("test-session");
    expect(session.sessionId).toBe("test-session");
  });

  test("marks turn", async () => {
    const kvClient = createMockKVClient();
    const evaluator = new TurnImportanceEvaluator();
    const manager = new KVLifecycleManager(kvClient, evaluator);

    await manager.markTurn("test-session", 1, 0, 100, "Hello world");

    const session = manager.getSessionState("test-session");
    expect(session).toBeDefined();
    expect(session!.turns.size).toBe(1);
    expect(session!.currentTurn).toBe(1);

    const turn = session!.turns.get(1);
    expect(turn).toBeDefined();
    expect(turn!.tier).toBe("hot");
  });

  test("updates turn importance with refs", async () => {
    const kvClient = createMockKVClient();
    const evaluator = new TurnImportanceEvaluator();
    const manager = new KVLifecycleManager(kvClient, evaluator);

    await manager.markTurn("test-session", 1, 0, 100, "Turn 1");
    await manager.markTurn("test-session", 2, 100, 200, "Turn 2");

    await manager.updateTurnImportance("test-session", [1]);

    const session = manager.getSessionState("test-session");
    const turn1 = session!.turns.get(1)!;
    const turn2 = session!.turns.get(2)!;

    expect(turn1.importance).toBeGreaterThan(turn2.importance);
  });

  test("protects and unprotects turn", async () => {
    const kvClient = createMockKVClient();
    const evaluator = new TurnImportanceEvaluator();
    const manager = new KVLifecycleManager(kvClient, evaluator);

    await manager.markTurn("test-session", 1, 0, 100, "Protected turn");

    await manager.protectTurn("test-session", 1);
    const session = manager.getSessionState("test-session");
    expect(session!.turns.get(1)!.tier).toBe("protected");

    await manager.unprotectTurn("test-session", 1);
    expect(session!.turns.get(1)!.tier).toBe("hot");
  });

  test("runs eviction cycle", async () => {
    const kvClient = createMockKVClient();
    const evaluator = new TurnImportanceEvaluator();
    const manager = new KVLifecycleManager(kvClient, evaluator);

    await manager.markTurn("test-session", 1, 0, 100, "Old turn");
    await manager.markTurn("test-session", 2, 100, 200, "Another turn");
    await manager.markTurn("test-session", 3, 200, 300, "Recent turn");
    await manager.markTurn("test-session", 4, 300, 400, "Newest turn");

    const result = await manager.runEvictionCycle();
    expect(result).toBeDefined();
    expect(result.evictedTurns).toBeDefined();
    expect(result.freedBlocks).toBeDefined();
  });

  test("gets pressure level", () => {
    const kvClient = createMockKVClient();
    const evaluator = new TurnImportanceEvaluator();
    const manager = new KVLifecycleManager(kvClient, evaluator);

    expect(manager.getPressureLevel()).toBe("normal");
  });

  test("clears session", async () => {
    const kvClient = createMockKVClient();
    const evaluator = new TurnImportanceEvaluator();
    const manager = new KVLifecycleManager(kvClient, evaluator);

    await manager.markTurn("test-session", 1, 0, 100, "Test");

    manager.clearSession("test-session");

    const session = manager.getSessionState("test-session");
    expect(session).toBeUndefined();
  });
});
