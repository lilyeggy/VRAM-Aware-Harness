import { describe, expect, test } from "bun:test";
import { LLMClient } from "../src/client/llm-client.ts";

describe("LLMClient", () => {
  test("can be instantiated with config", () => {
    const client = new LLMClient({
      baseURL: "http://localhost:3001/v1",
      model: "test-model",
    });
    expect(client).toBeDefined();
  });

  test("accepts optional apiKey", () => {
    const client = new LLMClient({
      baseURL: "http://localhost:3001/v1",
      model: "test-model",
      apiKey: "test-key",
    });
    expect(client).toBeDefined();
  });

  test("accepts custom timeout", () => {
    const client = new LLMClient({
      baseURL: "http://localhost:3001/v1",
      model: "test-model",
      defaultTimeout: 30_000,
    });
    expect(client).toBeDefined();
  });
});
