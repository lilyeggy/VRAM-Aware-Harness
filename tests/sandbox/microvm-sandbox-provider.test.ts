import { expect, test } from "bun:test";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";
import type { SandboxRecord, SecretProvider } from "../../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../../src/sandbox/sandbox-store.ts";
import { SandboxProviderRouter } from "../../src/sandbox/sandbox-provider-router.ts";
import {
    MicrovmSandboxProvider,
    MockMicrovmDriver,
    FirecrackerSandboxDriver,
    E2bSandboxDriver,
} from "../../src/sandbox/microvm/index.ts";

class MemorySandboxStore {
    readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void {
        this.records.set(record.id, record);
    }
    get(id: string): SandboxRecord | null {
        return this.records.get(id) ?? null;
    }
    update(record: SandboxRecord, _previousStatus: string): void {
        this.records.set(record.id, record);
    }
    listActive(): SandboxRecord[] {
        return Array.from(this.records.values()).filter((r) => r.status === "ACTIVE");
    }
    listOrphans(): SandboxRecord[] {
        return [];
    }
}

const mockSecrets: SecretProvider = {
    get: (_tenantId, name) => (name === "TEST_SECRET" ? "secret-value-123" : null),
};

function strictPolicy(overrides: Partial<EffectivePolicySnapshot> = {}): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: "policy-strict",
        runId: "run-strict-1",
        tenantId: "tenant-a",
        sandboxProfile: "strict",
        layers: [],
        createdAt: "2026-10-05T00:00:00.000Z",
        workspaceRoots: ["/srv/workspaces/tenant-a"],
        allowNetwork: false,
        allowedSecrets: ["TEST_SECRET"],
        ...overrides,
    };
}

test("strict profile 成功路由至 MicrovmSandboxProvider 并产出合规硬件级审计证据", async () => {
    const store = new MemorySandboxStore();
    const mockDriver = new MockMicrovmDriver();
    const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, { driver: mockDriver });

    const handle = await provider.create({
        id: "sbx-strict-1",
        runId: "run-strict-1",
        workspacePath: "/srv/workspaces/tenant-a/run-strict-1",
        policy: strictPolicy(),
    });

    // 验证 Handle 返回的隔离与执行能力
    expect(handle.id).toBe("sbx-strict-1");
    expect(handle.enforcement.toolExecutionBoundary).toBe("SANDBOX");
    expect(handle.enforcement.processIsolation).toBe(true);
    expect(handle.enforcement.filesystemIsolation).toBe(true);

    // 验证 Secret 在 handle.withSecrets 中能被安全读取
    handle.withSecrets((env) => {
        expect(env.TEST_SECRET).toBe("secret-value-123");
    });

    // 验证持久化记录中的硬件虚拟化审计证据
    const record = store.get("sbx-strict-1");
    expect(record).not.toBeNull();
    expect(record?.profile).toBe("strict");
    expect(record?.runtime).toBe("firecracker");
    expect(record?.runtimeEvidence.requestedRuntime).toBe("firecracker");
    expect(record?.runtimeEvidence.verified).toBe(true);
    expect(record?.spec.userId).toBe(0); // 独立 Guest OS 内，root 安全隔离
    expect(record?.spec.secretNames).toEqual(["TEST_SECRET"]);
});

test("MicrovmSandboxProvider 执行多轮命令并返回确定的执行结果", async () => {
    const store = new MemorySandboxStore();
    const mockDriver = new MockMicrovmDriver();
    const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, { driver: mockDriver });

    await provider.create({
        id: "sbx-exec-1",
        runId: "run-1",
        workspacePath: "/workspace/project",
        policy: strictPolicy(),
    });

    const res1 = await provider.execute("sbx-exec-1", ["uname", "-r"]);
    expect(res1.exitCode).toBe(0);
    expect(res1.stdout).toContain("microvm");

    const res2 = await provider.execute("sbx-exec-1", ["whoami"]);
    expect(res2.exitCode).toBe(0);
    expect(res2.stdout.trim()).toBe("root");

    expect(mockDriver.executionHistory.length).toBe(2);
});

test("MicrovmSandboxProvider 在底层驱动不可用时 fail-closed 并标记 FAILED", async () => {
    const store = new MemorySandboxStore();
    const mockDriver = new MockMicrovmDriver();
    mockDriver.setAvailable(false);
    const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, { driver: mockDriver });

    await expect(provider.create({
        id: "sbx-fail-1",
        runId: "run-fail",
        workspacePath: "/workspace",
        policy: strictPolicy(),
    })).rejects.toThrow("不可用");

    // 驱动不可用时提前拒绝，不产生悬挂活跃实例
    expect(store.get("sbx-fail-1")).toBeNull();
});

test("MicrovmSandboxProvider 正常终止沙箱并更新生命周期状态", async () => {
    const store = new MemorySandboxStore();
    const mockDriver = new MockMicrovmDriver();
    const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, { driver: mockDriver });

    await provider.create({
        id: "sbx-term-1",
        runId: "run-term",
        workspacePath: "/workspace",
        policy: strictPolicy(),
    });

    expect(mockDriver.instances.has("sbx-term-1")).toBe(true);
    expect(store.get("sbx-term-1")?.status).toBe("ACTIVE");

    await provider.terminate("sbx-term-1");

    expect(mockDriver.instances.has("sbx-term-1")).toBe(false);
    expect(store.get("sbx-term-1")?.status).toBe("TERMINATED");
});

test("SandboxProviderRouter 配合 MicrovmSandboxProvider 时能正常分发 strict 策略", async () => {
    const store = new MemorySandboxStore();
    const mockDriver = new MockMicrovmDriver();
    const microvmProvider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, { driver: mockDriver });

    const router = new SandboxProviderRouter({
        strict: microvmProvider,
    }, "strict");

    const handle = await router.create({
        id: "routed-strict-1",
        runId: "run-routed",
        workspacePath: "/srv/workspaces/run-routed",
        policy: strictPolicy(),
    });

    expect(handle.id).toBe("routed-strict-1");
    const execRes = await router.execute("routed-strict-1", ["whoami"]);
    expect(execRes.stdout.trim()).toBe("root");

    await router.terminate("routed-strict-1");
    expect(store.get("routed-strict-1")?.status).toBe("TERMINATED");
});

test("E2bSandboxDriver 在缺失 API Key 时 fail-closed，配置 key 时可正常生成实例", async () => {
    const noKeyDriver = new E2bSandboxDriver({ apiKey: "" });
    expect(await noKeyDriver.isAvailable()).toBe(false);
    await expect(noKeyDriver.create({
        id: "e2b-1",
        runId: "run-1",
        workspacePath: "/workspace",
    })).rejects.toThrow("缺少 E2B_API_KEY");

    const withKeyDriver = new E2bSandboxDriver({ apiKey: "e2b_test_key_abc", template: "custom-template" });
    expect(await withKeyDriver.isAvailable()).toBe(true);
    const instance = await withKeyDriver.create({
        id: "e2b-2",
        runId: "run-2",
        workspacePath: "/workspace",
    });
    expect(instance.driver).toBe("e2b");

    const execRes = await withKeyDriver.execute("e2b-2", ["echo", "hello"]);
    expect(execRes.stdout).toContain("[e2b:e2b-custom-template-e2b-2] echo hello");
});

test("FirecrackerSandboxDriver 缺少 KVM 设备时检测到不可用并安全拦截", async () => {
    const nonExistentKvmDriver = new FirecrackerSandboxDriver({ kvmDevicePath: "/tmp/non-existent-kvm" });
    expect(await nonExistentKvmDriver.isAvailable()).toBe(false);
    await expect(nonExistentKvmDriver.create({
        id: "fc-1",
        runId: "run-fc",
        workspacePath: "/workspace",
    })).rejects.toThrow("KVM 设备不可访问");
});
