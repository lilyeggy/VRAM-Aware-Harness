import { expect, test } from "bun:test";

import {
    computeEffectivePolicy,
    createPolicyLayer,
    unrestrictedPolicy,
    type PolicyConstraints,
} from "../../src/policies/effective-policy.ts";
import { compilePiPolicy } from "../../src/policies/policy-compilation.ts";
import type { PiTemplateSpec } from "../../src/templates/harness-template.ts";

const template: PiTemplateSpec = {
    runtimeKind: "PI",
    provider: "fake-provider",
    modelId: "fake-model",
    tools: ["read", "write", "bash"],
    skills: ["review", "deploy"],
};

function snapshot(
    id: string,
    tenantConstraints: Partial<PolicyConstraints>,
) {
    const tenantPolicy = {
        ...unrestrictedPolicy,
        ...tenantConstraints,
    };
    return computeEffectivePolicy({
        id,
        runId: `run-${id}`,
        tenantId: `tenant-${id}`,
        templateVersionId: "template-version-1",
        layers: [
            createPolicyLayer("platform", "PLATFORM", unrestrictedPolicy),
            createPolicyLayer(`tenant-${id}`, "TENANT", tenantPolicy),
            createPolicyLayer("template", "TEMPLATE", unrestrictedPolicy),
            createPolicyLayer("workspace", "WORKSPACE", unrestrictedPolicy),
            createPolicyLayer("run", "RUN", unrestrictedPolicy),
        ],
        createdAt: "2026-08-10T10:00:00.000Z",
    });
}

test("同一 Pi 模板按 Tenant 有效策略编译出不同 Tool 与 Skill 配置", () => {
    const tenantA = compilePiPolicy(template, snapshot("a", {
        allowedTools: ["read"],
        allowedSkills: ["review"],
        allowedModels: ["fake-provider/fake-model"],
    }));
    const tenantB = compilePiPolicy(template, snapshot("b", {
        allowedTools: ["read", "write"],
        allowedSkills: ["deploy"],
        allowedModels: ["fake-provider/fake-model"],
    }));

    expect(tenantA).toMatchObject({
        tools: ["read"],
        skills: ["review"],
        provider: "fake-provider",
        modelId: "fake-model",
    });
    expect(tenantB).toMatchObject({
        tools: ["read", "write"],
        skills: ["deploy"],
        provider: "fake-provider",
        modelId: "fake-model",
    });
});

test("模型不在有效许可集时编译器在 Runtime 之前 fail closed", () => {
    expect(() => compilePiPolicy(template, snapshot("model-denied", {
        allowedModels: ["fake-provider/another-model"],
    }))).toThrow("有效策略不允许模型：fake-provider/fake-model");
});
