import { describe, expect, test } from "bun:test";
import { AgentLoop } from "../src/harness/agent-loop.ts";
import { LLMClient } from "../src/client/llm-client.ts";
import { ContextManager } from "../src/harness/context-manager.ts";

describe("AgentLoop", () => {
  const createMockLLMClient = () => {
    return new LLMClient({
      baseURL: "http://localhost:3001/v1",
      model: "test-model",
    });
  };

  test("can be instantiated", () => {
    const client = createMockLLMClient();
    const contextManager = new ContextManager(client);
    const loop = new AgentLoop(client, contextManager);
    expect(loop).toBeDefined();
  });

  test("registers and unregisters tools", () => {
    const client = createMockLLMClient();
    const contextManager = new ContextManager(client);
    const loop = new AgentLoop(client, contextManager);
    
    const tool = {
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      handler: async () => "result",
    };
    
    loop.registerTool(tool);
    expect(loop.getToolDefinitions()).toHaveLength(1);
    expect(loop.getToolDefinitions()[0]!.function.name).toBe("test_tool");
    
    loop.unregisterTool("test_tool");
    expect(loop.getToolDefinitions()).toHaveLength(0);
  });

  test("gets tool definitions", () => {
    const client = createMockLLMClient();
    const contextManager = new ContextManager(client);
    const loop = new AgentLoop(client, contextManager);
    
    loop.registerTool({
      name: "tool1",
      description: "Tool 1",
      parameters: { type: "object", properties: {} },
      handler: async () => "result1",
    });
    
    loop.registerTool({
      name: "tool2",
      description: "Tool 2",
      parameters: { type: "object", properties: {} },
      handler: async () => "result2",
    });
    
    const definitions = loop.getToolDefinitions();
    expect(definitions).toHaveLength(2);
    expect(definitions[0]!.function.name).toBe("tool1");
    expect(definitions[1]!.function.name).toBe("tool2");
  });
});
