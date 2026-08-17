import { expect, test } from "bun:test";
import { EnvironmentSecretProvider, ManagedLocalSandboxProvider } from "../../src/sandbox/managed-local-sandbox.ts";
import type { SandboxRecord } from "../../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../../src/sandbox/sandbox-store.ts";
import {
    unrestrictedPolicy,
    type EffectivePolicySnapshot,
} from "../../src/policies/effective-policy.ts";

class MemorySandboxStore {
    readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
}

function snapshot(
    overrides: Partial<EffectivePolicySnapshot> = {},
): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: "policy-1",
        runId: "run-1",
        tenantId: "tenant-1",
        templateVersionId: "version-1",
        layers: [],
        workspaceRoots: ["/tmp/workspace"],
        createdAt: "2026-08-10T10:00:00.000Z",
        ...overrides,
    };
}

test("Secret 只在 Handle 回调中出现，持久化记录只保存名称", async () => {
    const store = new MemorySandboxStore();
    const provider = new ManagedLocalSandboxProvider(
        store as unknown as SandboxStore,
        { get: (tenantId, name) => tenantId === "tenant-1" && name === "API_TOKEN" ? "super-secret-value" : null },
    );
    const handle = await provider.create({
        id: "sandbox-1",
        runId: "run-1",
        instanceId: "instance-1",
        workspacePath: "/tmp/workspace",
        policy: snapshot({ allowedSecrets: ["API_TOKEN"] }),
    });

    expect(handle.withSecrets((environment) => environment.API_TOKEN))
        .toBe("super-secret-value");
    const persisted = store.get("sandbox-1")!;
    expect(persisted.secretNames).toEqual(["API_TOKEN"]);
    expect(JSON.stringify(persisted)).not.toContain("super-secret-value");

    await provider.terminate(handle.id);
    expect(handle.withSecrets((environment) => environment.API_TOKEN))
        .toBeUndefined();
});

test("环境 Secret 使用无碰撞的 Tenant namespace，不回退到全局变量", () => {
    const provider = new EnvironmentSecretProvider({
        HARNESS_SECRET_74656E616E742D61_API_TOKEN: "tenant-a-value",
        HARNESS_SECRET_74656E616E745F61_API_TOKEN: "tenant_a-value",
        API_TOKEN: "unsafe-global-value",
    });
    expect(provider.get("tenant-a", "API_TOKEN")).toBe("tenant-a-value");
    expect(provider.get("tenant_a", "API_TOKEN")).toBe("tenant_a-value");
    expect(provider.get("tenant-b", "API_TOKEN")).toBeNull();
    expect(() => provider.get("tenant-a", "bad-name")).toThrow("Secret 名称");
});

test("本地 Provider 无法落实硬资源限制时 fail closed", async () => {
    const provider = new ManagedLocalSandboxProvider(
        new MemorySandboxStore() as unknown as SandboxStore,
        { get: () => null },
    );
    await expect(provider.create({
        id: "sandbox-1",
        runId: "run-1",
        instanceId: "instance-1",
        workspacePath: "/tmp/workspace",
        policy: snapshot({
            resourceLimits: { cpuCores: 1, memoryMiB: null, diskMiB: null },
        }),
    })).rejects.toThrow("无法落实 CPU/内存/磁盘硬限制");
});
