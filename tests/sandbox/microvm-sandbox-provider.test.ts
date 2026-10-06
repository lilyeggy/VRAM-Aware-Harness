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
    // P0 修复：Mock 驱动不提供硬件隔离，enforcement 必须如实为 false，
    // 而不是原先无条件硬编码的 true。
    expect(handle.id).toBe("sbx-strict-1");
    expect(handle.enforcement.toolExecutionBoundary).toBe("SANDBOX");
    expect(handle.enforcement.processIsolation).toBe(false);
    expect(handle.enforcement.filesystemIsolation).toBe(false);

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
    // P0 修复：桩驱动不再被报告为"已验证的硬件隔离"。
    expect(record?.runtimeEvidence.verified).toBe(false);
    expect(record?.runtimeEvidence.verificationReason).toContain("桩");
    expect(record?.spec.userId).toBe(0); // 独立 Guest OS 内，root 安全隔离
    expect(record?.spec.secretNames).toEqual(["TEST_SECRET"]);
    // P0 修复：未实现的磁盘/PID 限额必须如实声明为 false。
    expect(handle.enforcement.diskLimitEnforced).toBe(false);
    expect(handle.enforcement.pidLimitEnforced).toBe(false);
    expect(handle.enforcement.workspaceScope).toBe("NONE");
    // acquisition 指标必须实测，不再是硬编码的 45ms。
    expect(handle.acquisition).toBeDefined();
    expect(handle.acquisition!.durationMs).toBeGreaterThanOrEqual(0);
});

test("MicrovmSandboxProvider 拒绝 allowNetwork=true（受控出口未实现，fail-closed）", async () => {
    const store = new MemorySandboxStore();
    const mockDriver = new MockMicrovmDriver();
    const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, { driver: mockDriver });

    await expect(provider.create({
        id: "sbx-net-1",
        runId: "run-net",
        workspacePath: "/workspace",
        policy: strictPolicy({ allowNetwork: true }),
    })).rejects.toThrow("allowNetwork");

    expect(store.get("sbx-net-1")).toBeNull();
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

test("E2bSandboxDriver 是 fail-closed 桩：即使配置了 API Key 也拒绝伪造实例与执行", async () => {
    const noKeyDriver = new E2bSandboxDriver({ apiKey: "" });
    expect(await noKeyDriver.isAvailable()).toBe(false);
    await expect(noKeyDriver.create({
        id: "e2b-1",
        runId: "run-1",
        workspacePath: "/workspace",
    })).rejects.toThrow("尚未实现");

    // P0 修复：原先配置 key 后 create/execute 返回伪造结果（exitCode 0 + echo），
    // 上游还据此写入 verified:true 的硬件隔离证据。现在即使有 key 也必须拒绝。
    const withKeyDriver = new E2bSandboxDriver({ apiKey: "e2b_test_key_abc", template: "custom-template" });
    expect(await withKeyDriver.isAvailable()).toBe(false);
    await expect(withKeyDriver.create({
        id: "e2b-2",
        runId: "run-2",
        workspacePath: "/workspace",
    })).rejects.toThrow("尚未实现");
    await expect(withKeyDriver.execute("e2b-2", ["echo", "hello"])).rejects.toThrow("尚未实现");
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

test("FirecrackerSandboxDriver 缺少 kernel/rootfs 时 fail-closed，不再静默假执行", async () => {
    // KVM 路径用真实路径以便通过第一道可用性检查（无 KVM 的环境跳过本用例）。
    const { accessSync, constants } = await import("node:fs");
    let kvmAvailable = true;
    try {
        accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    } catch {
        kvmAvailable = false;
    }
    if (!kvmAvailable) return;

    const driver = new FirecrackerSandboxDriver({
        // 故意不配置 kernelPath / rootfsPath
        kvmDevicePath: "/dev/kvm",
    });
    await expect(driver.create({
        id: "fc-no-kernel",
        runId: "run-fc-2",
        workspacePath: "/workspace",
    })).rejects.toThrow("内核或 rootfs");
});

test("产品边界：Firecracker 驱动对 allowNetwork=true 直接拒绝（不挂载任何网卡）", async () => {
    // 无需真实 KVM：联网拒绝发生在任何 spawn 之前，是纯策略门禁。
    const driver = new FirecrackerSandboxDriver({
        kernelPath: "/nonexistent/vmlinux",
        rootfsPath: "/nonexistent/rootfs.ext4",
        workspaceDiskTemplatePath: "/nonexistent/workspace.ext4",
    });

    // 报错必须是"无网卡服务"语义，而不是模板缺失 / KVM 不可用——
    // 否则说明门禁顺序被放到了环境检查之后。
    await expect(driver.create({
        id: "fc-net-rejected",
        runId: "run-net",
        workspacePath: "/workspace",
        allowNetwork: true,
    })).rejects.toThrow(/不提供网卡服务/);
});

test("MicrovmSandboxProvider.execute 将 secret 值经 env 传给驱动（值不在 argv 里）", async () => {
    const store = new MemorySandboxStore();
    const mockDriver = new MockMicrovmDriver();
    const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, { driver: mockDriver });

    await provider.create({
        id: "sbx-secret-test",
        runId: "run-secret",
        workspacePath: "/workspace",
        policy: strictPolicy({ allowedSecrets: ["TEST_SECRET"] }),
    });

    const command = ["bash", "-lc", "echo $TEST_SECRET"];
    await provider.execute("sbx-secret-test", command);

    expect(mockDriver.executionHistory.length).toBe(1);
    const recorded = mockDriver.executionHistory[0]!;
    // 值必须在 env 中
    expect(recorded.env?.TEST_SECRET).toBe("secret-value-123");
    // argv / command 中绝对不能包含 secret 值
    expect(recorded.command.join(" ")).not.toContain("secret-value-123");
});

test("产品边界：allowNetwork=true 一律被拒绝（MicroVM 不提供网卡服务），且不产生任何 VM", async () => {
    const store = new MemorySandboxStore();
    const mockDriver = new MockMicrovmDriver();

    const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, {
        driver: mockDriver,
    });

    await expect(provider.create({
        id: "sbx-net-rejected",
        runId: "run-net-rejected",
        workspacePath: "/workspace",
        policy: strictPolicy({ allowNetwork: true }),
    })).rejects.toThrow(/不提供网卡服务/);

    // fail-closed 必须发生在创建 VM 之前：不得留下任何实例或 ACTIVE 记录
    expect(mockDriver.instances.size).toBe(0);
    expect(store.get("sbx-net-rejected")).toBeNull();
    expect(store.listActive()).toHaveLength(0);
});
