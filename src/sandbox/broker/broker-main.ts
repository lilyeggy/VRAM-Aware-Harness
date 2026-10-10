
import { chownSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { FirecrackerSandboxDriver } from "../microvm/firecracker-sandbox-driver.ts";
import { MicrovmSandboxProvider } from "../microvm/microvm-sandbox-provider.ts";
import { reapOrphans } from "../microvm/vm-orphan-reaper.ts";
import { EnvironmentSecretProvider } from "../managed-local-sandbox.ts";
import type { SandboxStore } from "../sandbox-store.ts";
import { InMemorySandboxStore } from "./in-memory-sandbox-store.ts";
import { SandboxBrokerServer } from "./sandbox-broker-server.ts";

/**
 * 特权最小 Sandbox Broker 入口。
 *
 * 该进程是唯一持有 Firecracker/jailer 与租户 secret 的组件；Master/Worker
 * 通过 `HARNESS_SANDBOX_BROKER_SOCKET` 指向的 Unix socket 调用它。
 *
 * 启动要求：
 * - `HARNESS_MICROVM_DRIVER=firecracker`（拒绝 mock）；
 * - `FIRECRACKER_BINARY_PATH/KERNEL_PATH/ROOTFS_PATH/WORKSPACE_DISK_TEMPLATE_PATH`；
 * - `HARNESS_VM_RUNTIME_ROOT`；
 * - 若 `HARNESS_USE_JAILER=true`，需 root（jailer chroot/mount namespace 需要）。
 */

const socketPath = process.env.HARNESS_SANDBOX_BROKER_SOCKET ?? "/tmp/harness-sandbox-broker.sock";
const driverName = process.env.HARNESS_MICROVM_DRIVER ?? "firecracker";
if (driverName !== "firecracker") {
    throw new Error(
        "Sandbox Broker 只允许 HARNESS_MICROVM_DRIVER=firecracker；当前值: " + driverName,
    );
}

const binaryPath = process.env.FIRECRACKER_BINARY_PATH ?? "firecracker";
const jailerPath = process.env.FIRECRACKER_JAILER_PATH;
const kernelPath = process.env.FIRECRACKER_KERNEL_PATH;
const rootfsPath = process.env.FIRECRACKER_ROOTFS_PATH;
const workspaceDiskTemplatePath = process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH;
const runtimeRoot = process.env.HARNESS_VM_RUNTIME_ROOT ?? "/var/lib/harness/vm";
const useJailer = process.env.HARNESS_USE_JAILER === "true";
const snapshotsEnabled = process.env.HARNESS_VM_SNAPSHOTS_ENABLED === "true";
const controlToken = process.env.HARNESS_SANDBOX_BROKER_CONTROL_TOKEN;
if (controlToken === undefined || controlToken.length === 0) {
    throw new Error(
        "Sandbox Broker 必须设置非空 HARNESS_SANDBOX_BROKER_CONTROL_TOKEN；否则拒绝启动。",
    );
}

if (kernelPath === undefined || rootfsPath === undefined) {
    throw new Error("Firecracker 需要 FIRECRACKER_KERNEL_PATH 与 FIRECRACKER_ROOTFS_PATH");
}
if (snapshotsEnabled && useJailer === false) {
    throw new Error(
        "非 jailer 模式不允许启用 microVM 快照加速：快照会固化宿主绝对磁盘路径，多台恢复 VM 将共享同一工作区磁盘。",
    );
}
if (useJailer) {
    const euid = process.geteuid?.();
    if (euid !== 0) {
        throw new Error(
            "HARNESS_USE_JAILER=true 时 Sandbox Broker 必须由 root 运行（jailer 需要 chroot/mount namespace）。",
        );
    }
}
if (process.env.HARNESS_MICROVM_WARM_POOL_SIZE !== undefined) {
    console.error("[sandbox-broker] 警告：Broker MVP 暂不支持预热池，HARNESS_MICROVM_WARM_POOL_SIZE 被忽略。");
}

const binaryName = (useJailer ? (jailerPath ?? binaryPath) : binaryPath).split("/").pop() ?? binaryPath;
const reapReport = await reapOrphans(runtimeRoot, { binaryName });
if (reapReport.reaped > 0) {
    console.log("[sandbox-broker] 回收孤儿 VM " + reapReport.reaped + " 个");
}

const driver = new FirecrackerSandboxDriver({
    binaryPath,
    jailerPath,
    kernelPath,
    rootfsPath,
    workspaceDiskTemplatePath,
    vmRuntimeRoot: runtimeRoot,
    socketRoot: process.env.HARNESS_VM_SOCKET_ROOT,
    vsockPort: process.env.HARNESS_VSOCK_PORT === undefined
        ? undefined
        : Number(process.env.HARNESS_VSOCK_PORT),
    useJailer,
    snapshotsEnabled,
    snapshotPoolDir: process.env.HARNESS_VM_SNAPSHOT_POOL_DIR,
    guestAgentVersion: process.env.HARNESS_GUEST_AGENT_VERSION,
});

const store = new InMemorySandboxStore();
const provider = new MicrovmSandboxProvider(
    store as unknown as SandboxStore,
    new EnvironmentSecretProvider(process.env),
    {
        driver,
        workspaceDiskTemplatePath,
        vmRuntimeRoot: runtimeRoot,
    },
);

mkdirSync(dirname(socketPath), { recursive: true, mode: 0o755 });
const server = new SandboxBrokerServer({
    socketPath,
    provider,
    readRecord: (sandboxId) => store.get(sandboxId),
    controlToken,
    onError: (error) => {
        console.error("[sandbox-broker] error", error);
    },
});
await server.start();

const socketGid = process.env.HARNESS_SANDBOX_BROKER_SOCKET_GID;
if (socketGid !== undefined) {
    const uid = Number(process.env.HARNESS_SANDBOX_BROKER_SOCKET_UID ?? process.getuid?.() ?? 0);
    chownSync(socketPath, uid, Number(socketGid));
    console.log("[sandbox-broker] socket chown -> " + uid + ":" + socketGid);
}

console.log("[sandbox-broker] listening", {
    socketPath,
    pid: process.pid,
    runtimeRoot,
    useJailer,
    snapshotsEnabled,
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log("[sandbox-broker] shutting down: " + signal);
    try {
        await server.close();
    } catch (error) {
        console.error("[sandbox-broker] close failed", error);
    }
    process.exit(0);
};
process.on("SIGINT", () => {
    void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
});
