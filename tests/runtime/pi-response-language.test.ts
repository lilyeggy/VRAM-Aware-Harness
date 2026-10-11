import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
    new URL("../../src/runtime/pi-adapter.ts", import.meta.url),
    "utf8",
);

test("Pi 会话必须追加跟随用户语言回答的系统提示（N29 回归）", () => {
    expect(source).toContain("RESPONSE_LANGUAGE_INSTRUCTION");
    expect(source).toContain("appendSystemPrompt: [RESPONSE_LANGUAGE_INSTRUCTION]");
    expect(source).toContain("same language as the user's latest message");
    expect(source).toContain("如果用户使用中文提问，请用中文回答");
});
