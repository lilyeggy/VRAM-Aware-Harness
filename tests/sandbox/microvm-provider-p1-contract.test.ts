import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";
import type { SandboxRecord, SecretProvider } from "../../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../../src/sandbox/sandbox-store.ts";
import { MicrovmSandboxProvider } from "../../src/sandbox/microvm/microvm-sandbox-provider.ts";
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

const mockSecrets: SecretProvider = {
    get: () => null,
};

function strictPolicy(overrides: Partial<EffectivePolicySnapshot> = {}): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: "policy-strict",
        runId: "run-p1",
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

/**
 * 模拟"硬件隔离"驱动：提供真实的工作区磁盘（用目录充当已挂载/可导出的磁盘，
 * 与 WorkspaceDiskExporter 的目录源分支对齐），并记录生命周期调用顺序。
 */
class FakeHardwareDriver implements MicrovmDriver {
    readonly name = "firecracker" as const;
    readonly providesHardwareIsolation = true;
    readonly calls: string[] = [];
    createOptions?: MicrovmCreateOptions;
    diskDir?: string;
    omitHostPath = false;
    terminated = false;

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async create(options: MicrovmCreateOptions): Promise<MicrovmInstance> {
        this.calls.push("create");
        this.createOptions = options;
        this.diskDir = mkdtempSync(join(tmpdir(), "fake-ws-disk-"));
        writeFileSync(join(this.diskDir, "artifact.txt"), "run-output");
        return {
            id: options.id,
            driver: "firecracker",
            workspacePath: options.workspacePath,
            ...(this.omitHostPath ? {} : { workspaceDiskHostPath: this.diskDir }),
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

    async flushFilesystem(_vmId: string): Promise<void> {
        this.calls.push("flushFilesystem");
    }

    async stopVm(_vmId: string): Promise<void> {
        this.calls.push("stopVm");
    }

    async terminate(_vmId: string): Promise<void> {
        this.calls.push("terminate");
        this.terminated = true;
        if (this.diskDir) {
            rmSync(this.diskDir, { recursive: true, force: true });
        }
    }
}

function makeWorkspace(): { templatePath: string; workspacePath: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "p1-provider-"));
    const templatePath = join(root, "template.ext4");
    writeFileSync(templatePath, "fake-ext4-template");
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    return {
        templatePath,
        workspacePath,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

test("P1-1: Provider 不再向驱动传 workspaceDiskPath，导出以驱动回传的 workspaceDiskHostPath 为准", async () => {
    const { templatePath, workspacePath, cleanup } = makeWorkspace();
    try {
        const store = new MemorySandboxStore();
        const driver = new FakeHardwareDriver();
        const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, {
            driver,
            workspaceDiskTemplatePath: templatePath,
        });

        await provider.create({
            id: "sbx-p1-contract",
            runId: "run-p1",
            workspacePath,
            policy: strictPolicy(),
        });

        // 契约：Provider 不得再传语义含糊的 workspaceDiskPath（旧契约会传一个
        // 根本不存在的路径导致真机创建必败）。
        const opts = driver.createOptions as unknown as Record<string, unknown>;
        expect(opts.workspaceDiskPath).toBeUndefined();

        await provider.terminate("sbx-p1-contract");

        // 导出源是驱动回传路径里的内容，产物落到宿主工作区。
        expect(readFileSync(join(workspacePath, "artifact.txt"), "utf8")).toBe("run-output");
    } finally {
        cleanup();
    }
});

test("P1-2: 终止顺序为 flushFilesystem → stopVm → 导出 → terminate", async () => {
    const { templatePath, workspacePath, cleanup } = makeWorkspace();
    try {
        const store = new MemorySandboxStore();
        const driver = new FakeHardwareDriver();
        const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, {
            driver,
            workspaceDiskTemplatePath: templatePath,
        });

        await provider.create({
            id: "sbx-p1-order",
            runId: "run-p1",
            workspacePath,
            policy: strictPolicy(),
        });
        await provider.terminate("sbx-p1-order");

        // VM 必须先完全静止（stopVm）才允许销毁清理（terminate）；
        // 导出发生在两者之间（由产物存在性间接证明在 terminate 前完成）。
        expect(driver.calls).toEqual(["create", "flushFilesystem", "stopVm", "terminate"]);
        expect(existsSync(join(workspacePath, "artifact.txt"))).toBe(true);
    } finally {
        cleanup();
    }
});

test("P1-1: 硬件隔离驱动未回传 workspaceDiskHostPath 时 fail-closed 且回收 VM", async () => {
    const { templatePath, workspacePath, cleanup } = makeWorkspace();
    try {
        const store = new MemorySandboxStore();
        const driver = new FakeHardwareDriver();
        driver.omitHostPath = true;
        const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, {
            driver,
            workspaceDiskTemplatePath: templatePath,
        });

        await expect(provider.create({
            id: "sbx-p1-leak",
            runId: "run-p1",
            workspacePath,
            policy: strictPolicy(),
        })).rejects.toThrow("workspaceDiskHostPath");

        // create 已成功、校验才失败：必须回收 VM，防止泄漏。
        expect(driver.terminated).toBe(true);
        const record = store.get("sbx-p1-leak");
        expect(record?.status).toBe("FAILED");
    } finally {
        cleanup();
    }
});
