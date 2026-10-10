import { expect, test } from "bun:test";
import {
    assertNetworkRequestAllowed,
    computeEffectivePolicy,
    createPolicyLayer,
    unrestrictedPolicy,
    type PolicyConstraints,
} from "../../src/policies/effective-policy.ts";

function constraints(
    overrides: Partial<PolicyConstraints>,
): PolicyConstraints {
    return { ...unrestrictedPolicy, ...overrides };
}

test("五层策略对集合、布尔权限和资源上限取交集", () => {
    const snapshot = computeEffectivePolicy({
        id: "snapshot-1",
        runId: "run-1",
        tenantId: "tenant-1",
        layers: [
            createPolicyLayer("platform", "PLATFORM", constraints({
                allowedTools: ["read", "write", "bash"],
                allowedModels: ["local/qwen", "remote/other"],
                resourceLimits: { cpuCores: 8, memoryMiB: 8192, diskMiB: 20480 },
            })),
            createPolicyLayer("tenant", "TENANT", constraints({
                allowedTools: ["read", "write"],
                allowedModels: ["local/qwen"],
                allowNetwork: false,
                resourceLimits: { cpuCores: 4, memoryMiB: 4096, diskMiB: null },
            })),
            createPolicyLayer("template", "TEMPLATE", constraints({
                allowedTools: ["read", "bash"],
                allowedModels: ["local/qwen"],
            })),
            createPolicyLayer("workspace", "WORKSPACE", constraints({
                workspaceRoots: ["/tmp/workspace"],
            })),
            createPolicyLayer("run", "RUN", constraints({
                allowedTools: ["read"],
                resourceLimits: { cpuCores: 2, memoryMiB: null, diskMiB: 1024 },
            })),
        ],
        createdAt: "2026-08-10T10:00:00.000Z",
    });

    expect(snapshot.allowedTools).toEqual(["read"]);
    expect(snapshot.allowedModels).toEqual(["local/qwen"]);
    expect(snapshot.allowNetwork).toBe(false);
    expect(snapshot.workspaceRoots).toEqual(["/tmp/workspace"]);
    expect(snapshot.resourceLimits).toEqual({
        cpuCores: 2,
        memoryMiB: 4096,
        diskMiB: 1024,
    });
});

test("Sandbox profile 进入不可变快照，冲突时 fail closed", () => {
    const snapshot = computeEffectivePolicy({
        id: "profile-snapshot",
        runId: "run-profile",
        tenantId: "tenant-profile",
        layers: [
            createPolicyLayer("platform", "PLATFORM"),
            createPolicyLayer("tenant", "TENANT", constraints({ sandboxProfile: "strict" })),
            createPolicyLayer("template", "TEMPLATE"),
            createPolicyLayer("workspace", "WORKSPACE"),
            createPolicyLayer("run", "RUN"),
        ],
        createdAt: "2026-08-10T10:00:00.000Z",
    });
    expect(snapshot.sandboxProfile).toBe("strict");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => computeEffectivePolicy({
        id: "conflict",
        runId: "run-conflict",
        tenantId: "tenant-conflict",
        layers: [
            createPolicyLayer("platform", "PLATFORM", constraints({ sandboxProfile: "default" })),
            createPolicyLayer("tenant", "TENANT", constraints({ sandboxProfile: "strict" })),
            createPolicyLayer("template", "TEMPLATE"),
            createPolicyLayer("workspace", "WORKSPACE"),
            createPolicyLayer("run", "RUN"),
        ],
        createdAt: "2026-08-10T10:00:00.000Z",
    })).toThrow("Sandbox profile 策略冲突");
});

test("缺少任一规范策略层时拒绝生成有效快照", () => {
    expect(() => computeEffectivePolicy({
        id: "snapshot-1",
        runId: "run-1",
        tenantId: "tenant-1",
        layers: [createPolicyLayer("platform", "PLATFORM")],
        createdAt: "2026-08-10T10:00:00.000Z",
    })).toThrow("缺少策略层：TENANT");
});

test("B2：请求级 allowNetwork=true 被有效策略拒绝时必须 fail-closed", () => {
    const snapshot = computeEffectivePolicy({
        id: "network-snapshot",
        runId: "run-network",
        tenantId: "tenant-network",
        layers: [
            createPolicyLayer("platform", "PLATFORM", constraints({
                allowNetwork: false,
            })),
            createPolicyLayer("tenant", "TENANT"),
            createPolicyLayer("template", "TEMPLATE"),
            createPolicyLayer("workspace", "WORKSPACE"),
            createPolicyLayer("run", "RUN"),
        ],
        createdAt: "2026-10-10T00:00:00.000Z",
    });

    expect(snapshot.allowNetwork).toBe(false);
    expect(() => assertNetworkRequestAllowed(
        constraints({ allowNetwork: true }),
        snapshot,
    )).toThrow("allowNetwork=true 被平台策略拒绝");
    expect(() => assertNetworkRequestAllowed(
        constraints({ allowNetwork: false }),
        snapshot,
    )).not.toThrow();
    expect(() => assertNetworkRequestAllowed(undefined, snapshot)).not.toThrow();
});

test("B2：开发档允许联网时，请求级 allowNetwork=true 不被拒绝", () => {
    const snapshot = computeEffectivePolicy({
        id: "network-snapshot-development",
        runId: "run-network-development",
        tenantId: "tenant-network-development",
        layers: [
            createPolicyLayer("platform", "PLATFORM"),
            createPolicyLayer("tenant", "TENANT"),
            createPolicyLayer("template", "TEMPLATE"),
            createPolicyLayer("workspace", "WORKSPACE"),
            createPolicyLayer("run", "RUN"),
        ],
        createdAt: "2026-10-10T00:00:00.000Z",
    });

    expect(snapshot.allowNetwork).toBe(true);
    expect(() => assertNetworkRequestAllowed(
        constraints({ allowNetwork: true }),
        snapshot,
    )).not.toThrow();
});
