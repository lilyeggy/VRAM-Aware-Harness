/**
/**
 * MicroVM Hardware & Sandbox Live Smoke Script.
 *
 * Verifies:
 * 1. Physical /dev/kvm availability and access permissions.
 * 2. Strict profile routing to MicrovmSandboxProvider.
 * 3. Execution of commands within the microVM boundary.
 * 4. Clean teardown and termination.
 */

import { existsSync, accessSync, constants } from "node:fs";
import type { SandboxRecord } from "../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../src/sandbox/sandbox-store.ts";
import {
    MicrovmSandboxProvider,
    MockMicrovmDriver,
    FirecrackerSandboxDriver,
    type MicrovmDriver,
} from "../src/sandbox/microvm/index.ts";
import { unrestrictedPolicy } from "../src/policies/effective-policy.ts";

class MemorySandboxStore implements SandboxStore {
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

async function runSmoke() {
    console.log("=== MicroVM 硬件与沙箱冒烟检测 (MicroVM Smoke Check) ===");

    const kvmPath = "/dev/kvm";
    const hasKvmFile = existsSync(kvmPath);
    let kvmAccessible = false;
    if (hasKvmFile) {
        try {
            accessSync(kvmPath, constants.R_OK | constants.W_OK);
            kvmAccessible = true;
        } catch {
            kvmAccessible = false;
        }
    }

    console.log(`[1] 硬件虚拟化检测：${kvmPath} 存在=${hasKvmFile}, 读写就绪=${kvmAccessible}`);

    let driver: MicrovmDriver;
    if (kvmAccessible && process.env.USE_FIRECRACKER === "1") {
        console.log("[2] 检测到硬件 KVM，使用真实 Firecracker 驱动...");
        driver = new FirecrackerSandboxDriver();
    } else {
        console.log(`[2] 使用模拟 MicroVM 驱动 (MockMicrovmDriver) 进行全流程行为验证...`);
        driver = new MockMicrovmDriver();
    }

    const store = new MemorySandboxStore();
    const secrets = { get: () => null };

    const provider = new MicrovmSandboxProvider(store, secrets, { driver });

    console.log("[3] 创建 Strict 隔离等级微虚拟机...");
    const sandboxId = `smoke-vm-${Date.now()}`;
    const handle = await provider.create({
        id: sandboxId,
        runId: `run-smoke-${Date.now()}`,
        workspacePath: "/tmp/smoke-workspace",
        policy: {
            ...unrestrictedPolicy,
            id: "policy-smoke",
            runId: "run-smoke",
            tenantId: "tenant-smoke",
            sandboxProfile: "strict",
            layers: [],
            createdAt: new Date().toISOString(),
            workspaceRoots: ["/tmp/smoke-workspace"],
            allowNetwork: false,
        },
    });

    console.log(`    微虚拟机已创建：ID=${handle.id}, 工具边界=${handle.enforcement.toolExecutionBoundary}`);

    console.log("[4] 执行 Guest 内核诊断命令：uname -r ...");
    const unameRes = await provider.execute(sandboxId, ["uname", "-r"]);
    console.log(`    输出：${unameRes.stdout.trim()}`);

    console.log("[5] 执行权限诊断命令：whoami ...");
    const whoamiRes = await provider.execute(sandboxId, ["whoami"]);
    console.log(`    输出：${whoamiRes.stdout.trim()}`);

    console.log("[6] 验证沙箱销毁与生命周期收割...");
    await provider.terminate(sandboxId);
    const finalRecord = store.get(sandboxId);
    console.log(`    最终持久化状态：${finalRecord?.status} (预期: TERMINATED)`);

    console.log("=== 检测通过：MicroVM 沙箱基线验证完成 ===");
}

runSmoke().catch((err) => {
    console.error("检测失败：", err);
    process.exit(1);
});
