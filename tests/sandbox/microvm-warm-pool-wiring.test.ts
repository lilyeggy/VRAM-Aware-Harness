import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";
import type { SandboxRecord, SecretProvider } from "../../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../../src/sandbox/sandbox-store.ts";
import { MicrovmSandboxProvider } from "../../src/sandbox/microvm/microvm-sandbox-provider.ts";
import { MicrovmWarmPool } from "../../src/sandbox/microvm/microvm-warm-pool.ts";
import type {
    MicrovmCreateOptions,
    MicrovmDriver,
    MicrovmExecuteOptions,
    MicrovmExecutionResult,
    MicrovmInstance,
} from "../../src/sandbox/microvm/microvm-types.ts";

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

const mockSecrets: SecretProvider = { get: () => null };

function strictPolicy(overrides: Partial<EffectivePolicySnapshot> = {}): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: "policy-strict",
        runId: "run-warm",
        tenantId: "tenant-a",
        sandboxProfile: "strict",
        layers: [],
        createdAt: "2026-10-06T00:00:00.000Z",
        workspaceRoots: ["/srv/workspaces/tenant-a"],
        allowNetwork: false,
        allowedSecrets: [],
        ...overrides,
    };
}

class FakeHardwareDriver implements MicrovmDriver {
    readonly name = "firecracker" as const;
    readonly providesHardwareIsolation = true;
    createCount = 0;
    readonly createdIds: string[] = [];
    readonly terminatedIds: string[] = [];
    private readonly diskRoot = mkdtempSync(join(tmpdir(), "warm-driver-"));

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async create(options: MicrovmCreateOptions): Promise<MicrovmInstance> {
        this.createCount++;
        this.createdIds.push(options.id);
        const diskDir = join(this.diskRoot, options.id);
        mkdirSync(diskDir, { recursive: true });
        writeFileSync(join(diskDir, "marker.txt"), options.id);
        return {
            id: options.id,
            driver: "firecracker",
            workspacePath: options.workspacePath,
            workspaceDiskHostPath: diskDir,
            createdAt: new Date().toISOString(),
        };
    }

    async execute(
        _vmId: string,
        _command: readonly string[],
        _options?: MicrovmExecuteOptions,
    ): Promise<MicrovmExecutionResult> {
        return { exitCode: 0, stdout: "", stderr: "" };
    }

    async terminate(vmId: string): Promise<void> {
        this.terminatedIds.push(vmId);
        rmSync(join(this.diskRoot, vmId), { recursive: true, force: true });
    }

    cleanup(): void {
        rmSync(this.diskRoot, { recursive: true, force: true });
    }
}

function setup(driver: FakeHardwareDriver) {
    const root = mkdtempSync(join(tmpdir(), "warm-provider-"));
    const templatePath = join(root, "template.ext4");
    writeFileSync(templatePath, "fake-ext4");
    const store = new MemorySandboxStore();
    const warmPool = new MicrovmWarmPool(driver, { ttlMs: 60_000 });
    const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, {
        driver,
        workspaceDiskTemplatePath: templatePath,
        warmPool,
        templateHash: "test-template-hash",
    });
    return {
        provider,
        warmPool,
        workspacePath: join(root, "workspace"),
        cleanup: () => {
            driver.cleanup();
            rmSync(root, { recursive: true, force: true });
        },
    };
}

test("预热命中：第二个 Run 复用预热 VM，warmHit 如实为 true，driver.create 只冷启动一次", async () => {
    const driver = new FakeHardwareDriver();
    const { provider, workspacePath, cleanup } = setup(driver);
    try {
        // 启动期预热一台 M 档
        await provider.prewarm(["M"]);
        expect(driver.createCount).toBe(1); // 预热 VM 冷启动

        mkdirSync(workspacePath, { recursive: true });
        const handle = await provider.create({
            id: "sbx-warm-1",
            runId: "run-warm",
            workspacePath,
            policy: strictPolicy(),
        });

        // 命中预热：Run 本身没有冷启动，证据如实；
        // createCount=2 = 1 次预热冷启动 + 1 次命中后的后台补货，
        // 两次都是 warm-* ID，绝不是本 Run 的 "sbx-warm-1"。
        expect(handle.acquisition?.warmHit).toBe(true);
        expect(driver.createdIds).not.toContain("sbx-warm-1");
        expect(driver.createdIds.every((id) => id.startsWith("warm-"))).toBe(true);
        expect(driver.createCount).toBe(2);

        await provider.terminate("sbx-warm-1");
        // 命中后后台补货是异步的，这里不等待；关闭时统一回收
        await provider.close();
    } finally {
        cleanup();
    }
});

test("allowNetwork=true 被拒绝，且不会消耗预热池中的待命 VM", async () => {
    const driver = new FakeHardwareDriver();
    const { provider, workspacePath, cleanup } = setup(driver);
    try {
        await provider.prewarm(["M"]);
        expect(driver.createCount).toBe(1);

        mkdirSync(workspacePath, { recursive: true });
        await expect(provider.create({
            id: "sbx-warm-net",
            runId: "run-warm",
            workspacePath,
            policy: strictPolicy({ allowNetwork: true }),
        })).rejects.toThrow(/不提供网卡服务/);

        // 关键：被拒绝的联网请求不得触发冷启动，也不得取走预热 VM
        expect(driver.createCount).toBe(1);

        // 随后的正常请求仍能命中预热（预热 VM 未被污染、未被误取）
        const handle = await provider.create({
            id: "sbx-warm-ok",
            runId: "run-warm-ok",
            workspacePath,
            policy: strictPolicy(),
        });
        expect(handle.acquisition?.warmHit).toBe(true);
        // 本 Run 自身没有冷启动（createCount 的 +1 来自命中后的后台补货）
        expect(driver.createdIds).not.toContain("sbx-warm-ok");

        await provider.terminate("sbx-warm-ok");
        await provider.close();
    } finally {
        cleanup();
    }
});
