import { describe, expect, test } from "bun:test";
import { STATIC_SYSTEM_PROMPT, PROMPT_VERSION, assertStaticPrompt } from "../src/harness/system-prompt.ts";

describe("System Prompt", () => {
  test("PROMPT_VERSION is set", () => {
    expect(PROMPT_VERSION).toBe("0.1.0");
  });

  test("STATIC_SYSTEM_PROMPT is a non-empty string", () => {
    expect(STATIC_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test("STATIC_SYSTEM_PROMPT contains refs instruction", () => {
    expect(STATIC_SYSTEM_PROMPT).toContain("<refs>");
  });

  test("assertStaticPrompt passes with exact match", () => {
    expect(() => assertStaticPrompt(STATIC_SYSTEM_PROMPT)).not.toThrow();
  });

  test("assertStaticPrompt fails with modified prompt", () => {
    expect(() => assertStaticPrompt(STATIC_SYSTEM_PROMPT + " extra")).toThrow();
  });

  test("assertStaticPrompt fails with empty string", () => {
    expect(() => assertStaticPrompt("")).toThrow();
  });
});
