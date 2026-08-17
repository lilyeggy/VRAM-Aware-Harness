import { expect, test } from "bun:test";

import {
    createHarnessTemplate,
    createPiTemplateVersion,
} from "../../src/templates/harness-template.ts";

const createdAt = "2026-08-07T10:00:00.000Z";

test("创建 HarnessTemplate 并保留租户边界", () => {
    const template = createHarnessTemplate({
        id: "template-1",
        tenantId: "tenant-1",
        createdAt,
    });

    expect(template).toEqual({
        id: "template-1",
        tenantId: "tenant-1",
        createdAt,
    });
    expect(Object.isFrozen(template)).toBe(true);
});

test("HarnessTemplate 拒绝空身份与时间字段", () => {
    expect(() => createHarnessTemplate({
        id: " ",
        tenantId: "tenant-1",
        createdAt,
    })).toThrow("id 不能为空");

    expect(() => createHarnessTemplate({
        id: "template-1",
        tenantId: "",
        createdAt,
    })).toThrow("tenantId 不能为空");

    expect(() => createHarnessTemplate({
        id: "template-1",
        tenantId: "tenant-1",
        createdAt: " ",
    })).toThrow("createdAt 不能为空");
});

test("创建不可变的 Pi HarnessTemplateVersion", () => {
    const version = createPiTemplateVersion({
        id: "template-version-1",
        templateId: "template-1",
        version: 1,
        provider: "openai-compatible",
        modelId: "qwen3-coder",
        tools: ["read", "write"],
        createdAt,
    });

    expect(version).toEqual({
        id: "template-version-1",
        templateId: "template-1",
        version: 1,
        spec: {
            runtimeKind: "PI",
            provider: "openai-compatible",
            modelId: "qwen3-coder",
            tools: ["read", "write"],
        },
        createdAt,
    });
    expect(Object.isFrozen(version)).toBe(true);
    expect(Object.isFrozen(version.spec)).toBe(true);
    expect(Object.isFrozen(version.spec.tools)).toBe(true);
});

test("模板版本对输入 tools 做防御性复制", () => {
    const tools = ["read"];
    const version = createPiTemplateVersion({
        id: "template-version-1",
        templateId: "template-1",
        version: 1,
        provider: "openai-compatible",
        modelId: "qwen3-coder",
        tools,
        createdAt,
    });

    tools.push("write");

    expect(version.spec.tools).toEqual(["read"]);
    expect(version.spec.tools).not.toBe(tools);
});

test("模板版本号必须是正整数", () => {
    const createWithVersion = (version: number) => createPiTemplateVersion({
        id: "template-version-1",
        templateId: "template-1",
        version,
        provider: "openai-compatible",
        modelId: "qwen3-coder",
        tools: ["read"],
        createdAt,
    });

    expect(() => createWithVersion(0)).toThrow("version 必须为正整数");
    expect(() => createWithVersion(-1)).toThrow("version 必须为正整数");
    expect(() => createWithVersion(1.5)).toThrow("version 必须为正整数");
});

test("模板版本拒绝空配置字段", () => {
    expect(() => createPiTemplateVersion({
        id: "template-version-1",
        templateId: "template-1",
        version: 1,
        provider: " ",
        modelId: "qwen3-coder",
        tools: ["read"],
        createdAt,
    })).toThrow("provider 不能为空");

    expect(() => createPiTemplateVersion({
        id: "template-version-1",
        templateId: "template-1",
        version: 1,
        provider: "openai-compatible",
        modelId: "",
        tools: ["read"],
        createdAt,
    })).toThrow("modelId 不能为空");
});

test("模板版本拒绝空工具集合、空工具名和重复工具", () => {
    const createWithTools = (tools: readonly string[]) =>
        createPiTemplateVersion({
            id: "template-version-1",
            templateId: "template-1",
            version: 1,
            provider: "openai-compatible",
            modelId: "qwen3-coder",
            tools,
            createdAt,
        });

    expect(() => createWithTools([])).toThrow("tools 不能为空");
    expect(() => createWithTools(["read", " "])).toThrow("tool 不能为空");
    expect(() => createWithTools(["read", "read"])).toThrow(
        "tools 不能包含重复项: read",
    );
});
