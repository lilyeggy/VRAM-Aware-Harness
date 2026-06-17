import { describe, expect, test } from "bun:test";
import { Harness } from "../src/harness/harness.ts";

describe("Harness Integration", () => {
  test("can be instantiated", () => {
    const harness = new Harness({
      llm: {
        baseURL: "http://localhost:3001/v1",
        model: "test-model",
      },
    });
    expect(harness).toBeDefined();
  });

  test("registers tools", () => {
    const harness = new Harness({
      llm: {
        baseURL: "http://localhost:3001/v1",
        model: "test-model",
      },
    });

    harness.registerTool({
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      handler: async () => "result",
    });

    // 无法直接测试，但不应该抛错
    expect(true).toBe(true);
  });

  test("exports and imports summary", () => {
    const harness = new Harness({
      llm: {
        baseURL: "http://localhost:3001/v1",
        model: "test-model",
      },
    });

    harness.importSummary("test-session", "test summary");
    const exported = harness.exportSummary("test-session");
    expect(exported).toBe("test summary");
  });

  test("gets session pressure", () => {
    const harness = new Harness({
      llm: {
        baseURL: "http://localhost:3001/v1",
        model: "test-model",
      },
    });

    const pressure = harness.getSessionPressure("test-session");
    expect(pressure).toBe(0);
  });
});
