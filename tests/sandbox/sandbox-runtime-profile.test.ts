import { expect, test } from "bun:test";
import { ContainerSandboxProvider } from "../../src/sandbox/container-sandbox-provider.ts";
import { SandboxProviderRouter, UnavailableStrictSandboxProvider } from "../../src/sandbox/sandbox-provider-router.ts";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";
import type { SandboxRecord } from "../../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../../src/sandbox/sandbox-store.ts";

class MemorySandboxStore {
    readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
}

class InspectRuntime {
    readonly calls: string[][] = [];
    constructor(private readonly observedRuntime: string) {}
    async run(args: readonly string[]) {
        this.calls.push([...args]);
        if (args[1] === "inspect") {
            return { exitCode: 0, stdout: `${this.observedRuntime}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "container-id", stderr: "" };
    }
}

function policy(overrides: Partial<EffectivePolicySnapshot> = {}): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: "policy",
        runId: "run",
        tenantId: "tenant",
        templateVersionId: "version",
        layers: [],
        createdAt: "2026-08-17T00:00:00.000Z",
        workspaceRoots: ["/srv/workspaces/tenant"],
        allowNetwork: false,
        ...overrides,
    };
}

test("default profile 必须取得 runsc 的实际 inspect 证据", async () => {
    const store = new MemorySandboxStore();
    const runtime = new InspectRuntime("runsc");
    const provider = new ContainerSandboxProvider(
        store as unknown as SandboxStore,
        { get: () => null },
        { image: "agent-sandbox:test", profile: "default", runtime: "runsc" },
        runtime,
    );
    await provider.create({
        id: "sandbox-profile", runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/workspace", policy: policy(),
    });
    expect(runtime.calls[0]).toContain("runsc");
    expect(runtime.calls.some((call) => call[1] === "inspect")).toBe(true);
    expect(store.records.get("sandbox-profile")?.runtimeEvidence.verified).toBe(true);
});

test("default profile 使用 runc 或 inspect 非 runsc 时 fail closed", async () => {
    expect(() => new ContainerSandboxProvider(
        new MemorySandboxStore() as unknown as SandboxStore,
        { get: () => null },
        { image: "agent-sandbox:test", profile: "default", runtime: "runc" },
        new InspectRuntime("runc"),
    )).toThrow("不得回退到 runc");

    const store = new MemorySandboxStore();
    const runtime = new InspectRuntime("runc");
    const provider = new ContainerSandboxProvider(
        store as unknown as SandboxStore,
        { get: () => null },
        { image: "agent-sandbox:test", profile: "default", runtime: "runsc" },
        runtime,
    );
    await expect(provider.create({
        id: "sandbox-mismatch", runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/workspace", policy: policy(),
    })).rejects.toThrow("runtime 证据校验失败");
    expect(store.records.get("sandbox-mismatch")?.status).toBe("FAILED");
    expect(store.records.get("sandbox-mismatch")?.runtimeEvidence.observedRuntime).toBe("runc");
    expect(runtime.calls.at(-1)).toEqual([
        "docker", "rm", "--force", "agent-harness-sandbox-mismatch",
    ]);
});

test("strict profile 没有 microVM Provider 时不静默回退", async () => {
    const strict = new UnavailableStrictSandboxProvider();
    const router = new SandboxProviderRouter({ strict }, "strict");
    await expect(router.create({
        id: "strict-sandbox", runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/workspace",
        policy: policy({ sandboxProfile: "strict" }),
    })).rejects.toThrow("尚未接入");
});
