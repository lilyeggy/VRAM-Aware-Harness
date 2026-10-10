import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";
import type { SandboxRecord, SecretProvider } from "../../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../../src/sandbox/sandbox-store.ts";
import { MicrovmSandboxProvider } from "../../src/sandbox/microvm/microvm-sandbox-provider.ts";
import {
    FirecrackerSandboxDriver,
    buildJailerCgroupArgs,
} from "../../src/sandbox/microvm/firecracker-sandbox-driver.ts";
import { FirecrackerVsockBridge } from "../../src/sandbox/microvm/firecracker-vsock-bridge.ts";
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
        runId: "run-regress",
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
    readonly calls: string[] = [];
    readonly createdIds: string[] = [];
    terminated = false;
    private readonly diskRoot = mkdtempSync(join(tmpdir(), "regress-driver-"));

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async create(options: MicrovmCreateOptions): Promise<MicrovmInstance> {
        this.calls.push("create");
        this.createdIds.push(options.id);
        const diskDir = join(this.diskRoot, options.id);
        mkdirSync(diskDir, { recursive: true });
        writeFileSync(join(diskDir, "artifact.txt"), "run-output");
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

    async flushFilesystem(_vmId: string): Promise<void> {
        this.calls.push("flushFilesystem");
    }

    async stopVm(_vmId: string): Promise<void> {
        this.calls.push("stopVm");
    }

    async terminate(vmId: string): Promise<void> {
        this.calls.push("terminate");
        this.terminated = true;
        rmSync(join(this.diskRoot, vmId), { recursive: true, force: true });
    }

    cleanup(): void {
        rmSync(this.diskRoot, { recursive: true, force: true });
    }
}

/**
 * 回归 #1：terminate() 的清理不得被"工作区导出失败"短路。
 *
 * 修复前 `catch (exportErr) { throw exportErr; }` 位于销毁之前，导出一旦失败
 * 就跳过 `driver.terminate()` 与运行目录回收 —— jailer 模式下每个 Run 会永久
 * 泄漏约 800MB 的 chroot 磁盘副本，且 UID/CID 登记永不释放（池最终耗尽）。
 */
test("回归 #1: 导出失败仍必须销毁 VM 并回收运行目录", async () => {
    const root = mkdtempSync(join(tmpdir(), "regress-terminate-"));
    const driver = new FakeHardwareDriver();
    try {
        const templatePath = join(root, "template.ext4");
        writeFileSync(templatePath, "fake-ext4-template");

        // 让导出必然失败：工作区目标路径是一个**文件**，
        // WorkspaceDiskExporter 在其上 mkdirSync 会抛 EEXIST。
        const workspaceFilePath = join(root, "workspace-as-file");
        writeFileSync(workspaceFilePath, "not-a-directory");

        const vmRuntimeRoot = join(root, "vm");
        const sandboxId = "sbx-export-fail";
        const runDir = join(vmRuntimeRoot, sandboxId);
        mkdirSync(runDir, { recursive: true });

        const store = new MemorySandboxStore();
        const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, mockSecrets, {
            driver,
            workspaceDiskTemplatePath: templatePath,
            vmRuntimeRoot,
        });

        await provider.create({
            id: sandboxId,
            runId: "run-regress",
            workspacePath: workspaceFilePath,
            policy: strictPolicy(),
        });

        // 导出失败必须向上抛出（不得静默吞掉）
        await expect(provider.terminate(sandboxId)).rejects.toThrow(/无法导出工作区磁盘|EEXIST|not a directory/i);

        // 关键断言：清理仍然发生了
        expect(driver.calls).toContain("terminate");
        expect(driver.terminated).toBe(true);
        // 运行目录已回收（修复前会残留）
        expect(existsSync(runDir)).toBe(false);
        // 状态如实记为 FAILED
        expect(store.get(sandboxId)?.status).toBe("FAILED");
    } finally {
        driver.cleanup();
        rmSync(root, { recursive: true, force: true });
    }
});
/**
 * 回归 #6：vsock 连接超时的报错必须使用真实生效的超时值。
 * 修复前固定写 "(3000ms)"，而冷启动路径实际用 1s，误导了真机排查。
 */
test("回归 #6: vsock 超时报错使用实际超时值而非硬编码 3000ms", async () => {
    const root = mkdtempSync(join(tmpdir(), "regress-vsock-"));
    const sockPath = join(root, "silent.sock");
    let server: Server | undefined;
    try {
        // 接受连接但永不回包：必然走到超时分支
        server = createServer(() => { /* keep the connection silent */ });
        await new Promise<void>((r) => server!.listen(sockPath, r));

        const bridge = new FirecrackerVsockBridge(sockPath, 5000);
        await expect(bridge.connect(60)).rejects.toThrow(/\(60ms\)/);
        bridge.close();
    } finally {
        await new Promise<void>((r) => server?.close(() => r()) ?? r());
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * 回归 #5：guest agent 版本必须参与模板指纹。
 * 修复前 `agentVersion` 是默认参数 "1.0.0"，改了 guest agent 却不改版本号时
 * 模板指纹不变，会静默复用含旧 agent 的黄金快照。
 */
/**
 * 回归 #9：jailer cgroup 的 memory.max 必须容纳 guest 内存 **加上** VMM 自身开销。
 * 修复前 memory.max 恰好等于 guest 内存，Firecracker 进程会在 guest 吃满内存时
 * 被自己的 cgroup OOM 掉（无任何落脚的余地）；同时 cgroup 与 /machine-config
 * 各自兜底不同默认值（512MiB vs 256MiB），未显式传值时两者错位。
 */
test("回归 #9: jailer cgroup 限额 = guest 内存 + 64MiB VMM 底噪，且与 guest 配置同源", () => {
    // 与 /machine-config 的 mem_size_mib=512 / vcpu_count=2 配对
    expect(buildJailerCgroupArgs(2, 512)).toEqual([
        "--cgroup", "cpu.max=200000 100000",
        "--cgroup", "memory.max=603979776",
    ]);
    expect(buildJailerCgroupArgs(1, 256)).toContain("memory.max=335544320");
    expect(buildJailerCgroupArgs(1, 256)).toContain("cpu.max=100000 100000");
    expect(buildJailerCgroupArgs(4, 2048)).toContain(`memory.max=${(2048 + 64) * 1024 * 1024}`);

    // 硬约束：memory.max 必须严格大于 guest 内存，否则 VMM 无处安放
    for (const [cpu, mem] of [[1, 256], [2, 512], [4, 2048]] as const) {
        const args = buildJailerCgroupArgs(cpu, mem);
        const maxBytes = Number(String(args[3]).replace("memory.max=", ""));
        expect(maxBytes).toBeGreaterThan(mem * 1024 * 1024);
    }
});

test("回归 #5: guest agent 版本变化必须使模板指纹失效", () => {
    const root = mkdtempSync(join(tmpdir(), "regress-hash-"));
    try {
        const kernelPath = join(root, "kernel.bin");
        const rootfsPath = join(root, "rootfs.ext4");
        writeFileSync(kernelPath, "kernel");
        writeFileSync(rootfsPath, "rootfs");

        const v1 = new FirecrackerSandboxDriver({
            kernelPath,
            rootfsPath,
            guestAgentVersion: "1.0.0",
        });
        const v2 = new FirecrackerSandboxDriver({
            kernelPath,
            rootfsPath,
            guestAgentVersion: "1.1.0",
        });

        const hash1 = v1.computeTemplateHash();
        expect(hash1).not.toBeNull();
        expect(hash1).toBe(v1.computeTemplateHash());
        expect(v2.computeTemplateHash()).not.toBe(hash1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
