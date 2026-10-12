#!/usr/bin/env bun
/*
 * 冷启动预热（O5）：服务启动后先把"黄金快照"做出来，让用户的第一个 Run 也走
 * 快照恢复路径，而不是付一次冷启动（guest 内核启动 + agent 就绪 + 制作快照，
 * 真机 ~2.4s）。
 *
 * 为什么需要它：快照是"首次启动顺手做"的（best-effort），所以服务重启 / 清空
 * 快照池之后，第一个用户的 Run 必然冷启动。把这一步挪到服务启动阶段，用户侧
 * 就只剩热恢复（真机 O3 后 ~100~180ms）。
 *
 * 运行身份：与 broker 相同（root，jailer 需要）。读同一组环境变量
 * （/etc/harness/broker.env），因此算出的 templateHash 与 broker 一致。
 *
 * 幂等：池里已有该模板快照时直接跳过（不会多起一台 VM）。
 *
 * 输出：VM_PREWARM_OK / VM_PREWARM_SKIP / VM_PREWARM_FAIL
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { FirecrackerSandboxDriver } from "../src/sandbox/microvm/firecracker-sandbox-driver";
import { VmSnapshotManager } from "../src/sandbox/microvm/vm-snapshot-manager";

function envString(name: string, fallback: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") return fallback;
    return value;
}

function envNumber(name: string, fallback: number): number {
    const value = process.env[name];
    if (value === undefined || value === "") return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
    const value = process.env[name];
    if (value === undefined || value === "") return fallback;
    return value === "1" || value.toLowerCase() === "true";
}

const binaryPath = envString("FIRECRACKER_BINARY_PATH", "/home/cxr/microvm-test/bin/fc117");
const jailerPath = envString("FIRECRACKER_JAILER_PATH", "/home/cxr/microvm-test/bin/jailer117");
const kernelPath = envString("FIRECRACKER_KERNEL_PATH", "/home/cxr/microvm-test/bin/vmlinux");
const rootfsPath = envString("FIRECRACKER_ROOTFS_PATH", "/home/cxr/microvm-test/images/rootfs.ext4");
const workspaceDiskTemplatePath = envString(
    "FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH",
    "/home/cxr/microvm-test/images/workspace-template.ext4",
);
const useJailer = envBool("HARNESS_USE_JAILER", true);
const snapshotPoolDir = envString("HARNESS_VM_SNAPSHOT_POOL_DIR", "/var/lib/harness/snapshots");
const vmRuntimeRoot = envString("HARNESS_VM_RUNTIME_ROOT", "/var/lib/harness/vm");
const guestAgentVersion = envString("HARNESS_GUEST_AGENT_VERSION", "1.0.0");
const workspaceRoot = envString("HARNESS_VM_PREWARM_WORKSPACE_ROOT", join(dirname(vmRuntimeRoot), "prewarm"));
const memoryMb = envNumber("HARNESS_VM_PREWARM_MEMORY_MB", 256);
const cpuCount = envNumber("HARNESS_VM_PREWARM_VCPU", 2);
const force = process.argv.includes("--force");

const manager = new VmSnapshotManager({ snapshotPoolDir });
const templateHash = manager.computeTemplateHash(kernelPath, rootfsPath, guestAgentVersion);

if (manager.hasSnapshot(templateHash) && force === false) {
    console.log(
        `VM_PREWARM_SKIP template=${templateHash} reason=snapshot-present pool=${snapshotPoolDir}（无需预热）`,
    );
    process.exit(0);
}

const sandboxId = `prewarm-${Date.now().toString(36)}`;
const workspacePath = join(workspaceRoot, sandboxId);
mkdirSync(workspacePath, { recursive: true });

const driver = new FirecrackerSandboxDriver({
    binaryPath,
    jailerPath,
    kernelPath,
    rootfsPath,
    workspaceDiskTemplatePath,
    useJailer,
    snapshotsEnabled: true,
    snapshotPoolDir,
    vmRuntimeRoot,
    guestAgentVersion,
    phaseTrace: envBool("HARNESS_VM_PHASE_TRACE", false),
});

const startedAt = Date.now();
let exitCode = 0;
try {
    const instance = await driver.create({
        id: sandboxId,
        runId: sandboxId,
        workspacePath,
        cpuCount,
        memoryMb,
        allowNetwork: false,
    });
    const firstCreateMs = Date.now() - startedAt;
    const probe = await driver.execute(sandboxId, ["uname", "-r"]);
    const kernelRelease = probe.stdout.replace(/\s+/g, " ").trim();
    console.log(
        `VM_PREWARM_OK template=${templateHash} sandboxId=${sandboxId} firstCreateMs=${firstCreateMs} warmHit=${instance.warmHit === true} probe=${kernelRelease} pool=${snapshotPoolDir}（后续 VM 走快照恢复）`,
    );
} catch (error) {
    exitCode = 1;
    console.error(`VM_PREWARM_FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
    try {
        await driver.terminate(sandboxId);
    } catch {
        // 预热失败时也尽力清理；残留由 vm-orphan-reaper 兜底
    }
    rmSync(workspacePath, { recursive: true, force: true });
}

process.exit(exitCode);
