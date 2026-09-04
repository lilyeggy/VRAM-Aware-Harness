import { expect, test } from "bun:test";

import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";
import type { EffectivePolicyStore, ToolPolicyDecision } from "../../src/policies/effective-policy-store.ts";
import { PersistentToolPolicyGuard } from "../../src/policies/tool-policy-guard.ts";
import type { ExecuteToolInput } from "../../src/tools/tool-gateway.ts";

function snapshot(): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: "policy-1",
        runId: "run-1",
        tenantId: "tenant-1",
        templateVersionId: "version-1",
        layers: [],
        allowProcess: true,
        allowNetwork: false,
        workspaceRoots: ["/srv/workspace"],
        createdAt: "2026-08-22T00:00:00.000Z",
    };
}

function input(overrides: Partial<ExecuteToolInput> = {}): ExecuteToolInput {
    return {
        runId: "run-1",
        toolCallId: "bash-1",
        toolName: "bash",
        arguments: { command: "pwd" },
        effect: "UNKNOWN_EFFECT",
        runtimeSessionRef: "session-1",
        lastEventSequence: 1,
        policySnapshotId: "policy-1",
        workspacePath: "/srv/workspace",
        ...overrides,
    };
}

function harness() {
    const decisions: ToolPolicyDecision[] = [];
    const store = {
        getSnapshot: (id: string) => id === "policy-1" ? snapshot() : null,
        recordToolDecision: (decision: ToolPolicyDecision) => decisions.push(decision),
    } as unknown as EffectivePolicyStore;
    return { guard: new PersistentToolPolicyGuard(store), decisions };
}

test("Sandbox 已落实禁网与文件系统隔离时允许 bash", () => {
    const { guard, decisions } = harness();
    expect(() => guard.assertAllowed(input({
        sandboxEnforcement: {
            toolExecutionBoundary: "SANDBOX",
            filesystemIsolation: true,
            processIsolation: true,
            networkPolicyEnforced: true,
            cpuLimitEnforced: false,
            memoryLimitEnforced: false,
            diskLimitEnforced: false,
            pidLimitEnforced: true,
        },
    }))).not.toThrow();
    expect(decisions).toMatchObject([{ action: "ALLOW", toolName: "bash" }]);
});

test("宿主机工具无法落实禁网策略时在副作用前拒绝 bash", () => {
    const { guard, decisions } = harness();
    expect(() => guard.assertAllowed(input({
        sandboxEnforcement: {
            toolExecutionBoundary: "HOST",
            filesystemIsolation: false,
            processIsolation: false,
            networkPolicyEnforced: false,
            cpuLimitEnforced: false,
            memoryLimitEnforced: false,
            diskLimitEnforced: false,
            pidLimitEnforced: false,
        },
    }))).toThrow("无法落实禁网策略");
    expect(decisions).toMatchObject([{ action: "DENY", toolName: "bash" }]);
});
