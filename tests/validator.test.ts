import { describe, expect, test } from "bun:test";
import { OutputValidator } from "../src/harness/validator.ts";
import { LLMClient } from "../src/client/llm-client.ts";

describe("OutputValidator", () => {
  const createMockLLMClient = () => {
    return new LLMClient({
      baseURL: "http://localhost:3001/v1",
      model: "test-model",
    });
  };

  test("can be instantiated", () => {
    const client = createMockLLMClient();
    const validator = new OutputValidator(client);
    expect(validator).toBeDefined();
  });

  test("validates valid JSON against schema", () => {
    const client = createMockLLMClient();
    const validator = new OutputValidator(client);
    
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
    };
    
    const result = validator.validateJsonSchema('{"name": "test", "age": 25}', schema);
    expect(result.valid).toBe(true);
  });

  test("validates invalid JSON against schema", () => {
    const client = createMockLLMClient();
    const validator = new OutputValidator(client);
    
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
    };
    
    const result = validator.validateJsonSchema('{"name": "test"}', schema);
    expect(result.valid).toBe(false);
    expect(result.details).toContain("age");
  });

  test("validates malformed JSON", () => {
    const client = createMockLLMClient();
    const validator = new OutputValidator(client);
    
    const schema = { type: "object" };
    const result = validator.validateJsonSchema("not json", schema);
    
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid JSON");
  });

  test("validates with custom validator", () => {
    const client = createMockLLMClient();
    const validator = new OutputValidator(client);
    
    const customValidator = (content: string) => {
      if (content.includes("error")) {
        return { valid: false, error: "Contains error word" };
      }
      return { valid: true };
    };
    
    const result1 = validator.validateCustom("This is good", customValidator);
    expect(result1.valid).toBe(true);
    
    const result2 = validator.validateCustom("This has error", customValidator);
    expect(result2.valid).toBe(false);
  });

  test("creates help request message", () => {
    const client = createMockLLMClient();
    const validator = new OutputValidator(client);
    
    const helpRequest = validator.createHelpRequest("Validation failed");
    expect(helpRequest.role).toBe("user");
    expect(helpRequest.content).toContain("Validation failed");
  });
});
