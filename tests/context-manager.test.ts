import { describe, expect, test, mock } from "bun:test";
import { ContextManager } from "../src/harness/context-manager.ts";
import { LLMClient } from "../src/client/llm-client.ts";

describe("ContextManager", () => {
  const createMockLLMClient = () => {
    return new LLMClient({
      baseURL: "http://localhost:3001/v1",
      model: "test-model",
    });
  };

  test("can be instantiated", () => {
    const client = createMockLLMClient();
    const manager = new ContextManager(client);
    expect(manager).toBeDefined();
  });

  test("creates new session", () => {
    const client = createMockLLMClient();
    const manager = new ContextManager(client);
    const session = manager.getOrCreateSession("test-session");
    
    expect(session.sessionId).toBe("test-session");
    expect(session.frozenSummary).toBe("");
    expect(session.liveTurns).toEqual([]);
  });

  test("returns existing session", () => {
    const client = createMockLLMClient();
    const manager = new ContextManager(client);
    
    manager.getOrCreateSession("test-session", "project context");
    const session = manager.getOrCreateSession("test-session");
    
    expect(session.projectContext).toBe("project context");
  });

  test("builds messages with correct structure", () => {
    const client = createMockLLMClient();
    const manager = new ContextManager(client);
    const session = manager.getOrCreateSession("test-session", "test project");
    
    const userMessage = { role: "user" as const, content: "hello" };
    const messages = manager.buildMessages(session, userMessage);
    
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toBe("test project");
    expect(messages[2]!.role).toBe("assistant");
    expect(messages[2]!.content).toBe("已了解项目上下文");
    expect(messages[messages.length - 1]!.content).toBe("hello");
  });

  test("builds messages without project context", () => {
    const client = createMockLLMClient();
    const manager = new ContextManager(client);
    const session = manager.getOrCreateSession("test-session");
    
    const userMessage = { role: "user" as const, content: "hello" };
    const messages = manager.buildMessages(session, userMessage);
    
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.content).toBe("hello");
  });

  test("builds messages with frozen summary", () => {
    const client = createMockLLMClient();
    const manager = new ContextManager(client);
    const session = manager.getOrCreateSession("test-session");
    session.frozenSummary = "Previous conversation summary";
    
    const userMessage = { role: "user" as const, content: "hello" };
    const messages = manager.buildMessages(session, userMessage);
    
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toBe("Previous conversation summary");
    expect(messages[2]!.role).toBe("assistant");
    expect(messages[2]!.content).toBe("已了解前情");
  });

  test("tracks session pressure", () => {
    const client = createMockLLMClient();
    const manager = new ContextManager(client);
    const session = manager.getOrCreateSession("test-session");
    session.lastPromptTokens = 50000;
    
    const pressure = manager.getSessionPressure("test-session");
    expect(pressure).toBeGreaterThan(0);
  });

  test("exports and imports summary", () => {
    const client = createMockLLMClient();
    const manager = new ContextManager(client);
    
    manager.importSummary("test-session", "imported summary");
    const exported = manager.exportSummary("test-session");
    
    expect(exported).toBe("imported summary");
  });

  test("marks recovery attempted", () => {
    const client = createMockLLMClient();
    const manager = new ContextManager(client);
    
    expect(manager.hasRecoveryAttempted("test-session")).toBe(false);
    manager.markRecoveryAttempted("test-session");
    expect(manager.hasRecoveryAttempted("test-session")).toBe(true);
  });
});
