import { expect, test } from "bun:test";

import {
    createPiTemplateVersion,
} from "../../src/templates/harness-template.ts";
import {
    assertNextTemplateVersion,
} from "../../src/templates/template-version-policy.ts";

function version(templateId: string, number: number) {
    return createPiTemplateVersion({
        id: `version-${number}`,
        templateId,
        version: number,
        provider: "openai-compatible",
        modelId: "qwen3-coder",
        tools: ["read"],
        createdAt: "2026-08-09T10:00:00.000Z",
    });
}

test("首个模板版本必须从 1 开始", () => {
    expect(() => {
        assertNextTemplateVersion("template-1", null, version("template-1", 1));
    }).not.toThrow();

    expect(() => {
        assertNextTemplateVersion("template-1", null, version("template-1", 2));
    }).toThrow("模板版本号不连续：期望 1，实际 2");
});

test("后续模板版本必须严格连续递增", () => {
    expect(() => {
        assertNextTemplateVersion("template-1", 1, version("template-1", 2));
    }).not.toThrow();

    expect(() => {
        assertNextTemplateVersion("template-1", 1, version("template-1", 3));
    }).toThrow("模板版本号不连续：期望 2，实际 3");
});

test("候选版本必须属于目标模板", () => {
    expect(() => {
        assertNextTemplateVersion("template-1", null, version("template-2", 1));
    }).toThrow("模板 ID 不匹配：期望 template-1，实际 template-2");
});
