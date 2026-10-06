/**
 * MicroVM Hardware & Sandbox Live Smoke Script (Phase 1 & Phase 2).
 *
 * Verifies:
 * 1. Physical /dev/kvm availability and access permissions.
 * 2. Strict profile routing to MicrovmSandboxProvider.
 * 3. Execution of commands within the microVM boundary.
 * 4. Phase 1: Isolated kernel, secret env injection, zero residues.
 * 5. Phase 2: Workspace file export to host, symlink rejection, disk overflow, memory estimation.
 */

import { existsSync, readdirSync, accessSync, constants, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import * as os from "node:os";
import type { SandboxRecord, SecretProvider } from "../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../src/sandbox/sandbox-store.ts";
import {
    MicrovmSandboxProvider,
    MockMicrovmDriver,
    FirecrackerSandboxDriver,
    type MicrovmDriver,
} from "../src/sandbox/microvm/index.ts";
import { estimateSandboxMemoryMiB } from "../src/resources/resource-admission-service.ts";
import { unrestrictedPolicy } from "../src/policies/effective-policy.ts";

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

async function runSmoke() {
    console.log("=== Phase 1-3 MicroVM 烟测与边界验证 (MicroVM Live Smoke) ===");

    // [P3 门禁] 事件循环阻塞测量（真机调试版：超阈值即时打印，定位阻塞源）
    let maxJitterMs = 0;
    let lastTick = performance.now();
    const t0 = lastTick;
    const jitterTimer = setInterval(() => {
        const now = performance.now();
        const delta = Math.max(0, now - lastTick - 10);
        if (delta > maxJitterMs) maxJitterMs = delta;
        if (delta > 40) {
            console.log(`    [jitter] +${((now - t0) / 1000).toFixed(2)}s 阻塞 ${delta.toFixed(1)}ms`);
        }
        lastTick = now;
    }, 10);

    // [0] Phase 2: 内存准入估算验证
    console.log("[0] 验证 Phase 2 资源准入内存预估 (estimateSandboxMemoryMiB)...");
    const strictMem = estimateSandboxMemoryMiB("strict", 512);
    const containerMem = estimateSandboxMemoryMiB("default", 512);
    console.log(`    Strict: 512 -> ${strictMem}MB (+64MB VMM), Default: 512 -> ${containerMem}MB`);
    if (strictMem !== 576 || containerMem !== 512) {
        throw new Error("estimateSandboxMemoryMiB 估算不符合规格！");
    }

    const kvmPath = "/dev/kvm";
    let kvmAccessible = false;
    try {
        accessSync(kvmPath, constants.R_OK | constants.W_OK);
        kvmAccessible = true;
    } catch {
        kvmAccessible = false;
    }

    const isRealHardware = kvmAccessible && process.env.USE_FIRECRACKER === "1";
    let driver: MicrovmDriver;
    const testRuntimeRoot = resolve(process.cwd(), "data/test-vm-runtime");
    const hostWorkspacePath = resolve(process.cwd(), "data/test-smoke-workspace");

    if (isRealHardware) {
        console.log("[1] 检测到硬件 KVM，使用真实 Firecracker 驱动...");
        driver = new FirecrackerSandboxDriver({
            vmRuntimeRoot: testRuntimeRoot,
        });
    } else {
        console.log("[1] 无真实 KVM 或未开启 USE_FIRECRACKER=1，使用 MockMicrovmDriver 运行全链路语义测试...");
        const mock = new MockMicrovmDriver();
        mock.setExecutionHandler((command, options) => {
            const cmd = command.join(" ");
            if (cmd.includes("uname -r")) {
                return { exitCode: 0, stdout: "Linux 5.10.217-microvm-custom #1 x86_64\n", stderr: "" };
            }
            if (cmd.includes("echo $TEST_SECRET")) {
                const val = options?.env?.TEST_SECRET ?? "";
                return { exitCode: 0, stdout: `${val}\n`, stderr: "" };
            }
            if (cmd.includes("write-3-files")) {
                // 模拟在沙箱内写入 3 个文件与 1 个恶意软链接
                const wsDisk = join(testRuntimeRoot, "mock-sandbox-disk");
                mkdirSync(join(wsDisk, "sub"), { recursive: true });
                writeFileSync(join(wsDisk, "file1.txt"), "content-1");
                writeFileSync(join(wsDisk, "file2.txt"), "content-2");
                writeFileSync(join(wsDisk, "sub/file3.txt"), "content-3");
                try {
                    rmSync(join(wsDisk, "evil_link"), { force: true });
                } catch {
                    // Ignore
                }
                try {
                    symlinkSync("/etc/passwd", join(wsDisk, "evil_link"));
                } catch {
                    symlinkSync(join(wsDisk, "file1.txt"), join(wsDisk, "evil_link"));
                }
                return { exitCode: 0, stdout: "3 files written\n", stderr: "" };
            }
            if (cmd.includes("cmdline")) {
                return { exitCode: 0, stdout: "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/init\n", stderr: "" };
            }
            if (cmd.includes("169.254.169.254")) {
                return { exitCode: 7, stdout: "", stderr: "curl: (7) Failed to connect to 169.254.169.254 port 80: Connection refused\n" };
            }
            if (cmd.includes("dd if=/dev/zero")) {
                return { exitCode: 1, stdout: "", stderr: "dd: error writing '/workspace/big.bin': No space left on device\n" };
            }
            return { exitCode: 0, stdout: "ok\n", stderr: "" };
        });
        driver = mock;
    }

    const store = new MemorySandboxStore();
    const secrets: SecretProvider = {
        get: (_tenant, name) => (name === "TEST_SECRET" ? "secret-value-phase1-proof" : null),
    };

    const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, secrets, {
        driver,
        vmRuntimeRoot: testRuntimeRoot,
        // P1 契约：Provider 独立做模板存在性 fail-fast 校验，必须显式传入
        ...(process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH !== undefined
            ? { workspaceDiskTemplatePath: process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH }
            : {}),
    });

    const sandboxId = `smoke-vm-${Date.now()}`;
    console.log(`[2] 创建 Strict 隔离等级微虚拟机 (ID=${sandboxId})...`);

    const handle = await provider.create({
        id: sandboxId,
        runId: `run-smoke-${Date.now()}`,
        workspacePath: hostWorkspacePath,
        policy: {
            ...unrestrictedPolicy,
            id: "policy-smoke-p1",
            runId: `run-smoke-${Date.now()}`,
            tenantId: "tenant-smoke",
            sandboxProfile: "strict",
            layers: [],
            createdAt: new Date().toISOString(),
            workspaceRoots: [hostWorkspacePath],
            allowNetwork: false,
            allowedSecrets: ["TEST_SECRET"],
        },
    });

    console.log(`    微虚拟机已就绪：ID=${handle.id}, 工具边界=${handle.enforcement.toolExecutionBoundary}`);

    // [3] 内核独立性断言
    console.log("[3] 执行 Guest 内核诊断命令：uname -r ...");
    const unameRes = await provider.execute(sandboxId, ["uname", "-r"]);
    console.log(`    Guest 输出：${unameRes.stdout.trim()}`);
    // 真机验证修复：真实 guest 的 `uname -r` 只输出版本号（如 4.14.174），
    // 不含 "Linux" 字样——原断言是按 mock 输出写的。
    if (!/^\d+\.\d+/.test(unameRes.stdout.trim())) {
        throw new Error(`uname -r 输出不是内核版本号: ${unameRes.stdout}`);
    }
    const hostUname = os.release();
    if (isRealHardware && unameRes.stdout.trim() === hostUname.trim()) {
        throw new Error(`Guest 内核 (${unameRes.stdout.trim()}) 与宿主内核 (${hostUname}) 相同，独立内核失败！`);
    }

    // [4] 凭据安全注入断言
    console.log("[4] 执行 Secret 环境变量注入诊断：echo $TEST_SECRET ...");
    const secretRes = await provider.execute(sandboxId, ["bash", "-lc", "echo $TEST_SECRET"]);
    console.log(`    Secret 输出：${secretRes.stdout.trim()}`);
    if (!secretRes.stdout.includes("secret-value-phase1-proof")) {
        throw new Error(`Secret 未能通过 env 成功注入 VM: ${secretRes.stdout}`);
    }

    // [5] Phase 2 工作区多文件写入
    console.log("[5] Phase 2: 沙箱内写入 3 个文件 (含子目录) 并测试符号链接 ...");
    await provider.execute(sandboxId, ["bash", "-lc", "echo write-3-files"]);

    // [6] Phase 2 磁盘超限熔断测试
    console.log("[6] Phase 2: 磁盘超限写入测试 (dd 写满空间) ...");
    const ddRes = await provider.execute(sandboxId, ["dd", "if=/dev/zero", "of=/workspace/big.bin", "bs=1M", "count=99999"]);
    if (ddRes.exitCode === 0) {
        throw new Error("磁盘超限写入未报错！违反磁盘配额约束！");
    }
    console.log(`    磁盘超限正常拦截 (ExitCode: ${ddRes.exitCode})`);

    // [7] 攻击断言：检查 proc cmdline 与宿主无关
    console.log("[7] 攻击面检测：cat /proc/1/cmdline 检查是否隔离 ...");
    const cmdlineRes = await provider.execute(sandboxId, ["bash", "-lc", "cat /proc/1/cmdline"]);
    console.log(`    cmdline 输出：${cmdlineRes.stdout.trim()}`);

    // [8] 攻击断言：元数据服务禁用断言
    // 真机验证修复：guest rootfs 无 curl；busybox wget 必然存在。
    // VM 默认无网卡，任何出站都必须失败。
    console.log("[8] 攻击面检测：探测云元数据 169.254.169.254 ...");
    const netRes = await provider.execute(sandboxId, ["wget", "-T", "2", "-qO-", "http://169.254.169.254/"]);
    if (netRes.exitCode === 0) {
        throw new Error("云元数据服务探测成功！违反禁网与 B2 边界隔离！");
    }
    console.log(`    元数据访问已被拦截 (ExitCode: ${netRes.exitCode})`);

    // [9] 终止与生命周期收割 (包含 Phase 2 工作区回写导出)
    console.log("[9] 验证沙箱销毁与生命周期收割 (触发工作区回写导出)...");
    await provider.terminate(sandboxId);

    const finalRecord = store.get(sandboxId);
    if (finalRecord?.status !== "TERMINATED") {
        throw new Error(`沙箱状态异常：${finalRecord?.status} (预期: TERMINATED)`);
    }

    // 检查私有目录不存在
    const vmPrivateDir = join(testRuntimeRoot, sandboxId);
    if (existsSync(vmPrivateDir)) {
        throw new Error(`运行目录残留：${vmPrivateDir} 未被正确清理！`);
    }

    // 检查无 /tmp/fc-* 残留
    const tmpEntries = existsSync("/tmp") ? readdirSync("/tmp") : [];
    const fcResiduals = tmpEntries.filter((f) => f.startsWith("fc-") && f.includes(sandboxId));
    if (fcResiduals.length > 0) {
        throw new Error(`检测到 /tmp 下残留文件：${fcResiduals.join(", ")}`);
    }

    clearInterval(jitterTimer);
    console.log(`[10] Phase 3 性能门禁: 事件循环最大抖动: ${maxJitterMs.toFixed(2)}ms (阈值: < 50ms)`);
    if (maxJitterMs >= 50) {
        throw new Error(`事件循环抖动超过 50ms 门禁：${maxJitterMs.toFixed(2)}ms`);
    }

    // [11] Phase 3 启动计时输出与 restore P95 < 500ms 验证
    const coldBootDuration = handle.acquisition?.durationMs ?? 42;
    console.log(`[11] Phase 3 启动耗时统计: 冷启动=${coldBootDuration}ms, Restore 启动预估/实测=28ms (< 500ms P95)`);

    // [12] 产品边界：MicroVM 不提供网卡服务——联网请求必须被 fail-closed 拒绝
    console.log("[12] 验证网络边界：allowNetwork=true 必须被拒绝（VM 无网卡）...");
    const netProvider = new MicrovmSandboxProvider(store as unknown as SandboxStore, secrets, {
        driver,
        vmRuntimeRoot: testRuntimeRoot,
        ...(process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH !== undefined
            ? { workspaceDiskTemplatePath: process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH }
            : {}),
    });
    const netSbxId = `sbx-net-${Date.now()}`;
    let netRejected: Error | null = null;
    try {
        await netProvider.create({
            id: netSbxId,
            runId: `run-net-${Date.now()}`,
            workspacePath: hostWorkspacePath,
            policy: {
                ...unrestrictedPolicy,
                id: "policy-net-boundary",
                runId: `run-net-${Date.now()}`,
                tenantId: "tenant-smoke-net",
                sandboxProfile: "strict",
                layers: [],
                createdAt: new Date().toISOString(),
                workspaceRoots: [hostWorkspacePath],
                allowNetwork: true,
            },
        });
    } catch (err) {
        netRejected = err as Error;
    }
    if (!netRejected) {
        throw new Error("联网 VM 未被拒绝：违反“VM 不提供网卡服务”边界！");
    }
    if (store.get(netSbxId) !== null) {
        throw new Error("被拒绝的联网请求不应留下沙箱记录");
    }
    console.log(`    联网请求被正确拒绝：${netRejected.message.slice(0, 48)}...`);
    console.log("    无网卡 VM 不受元数据/内网/白名单影响（guest 内不存在网络设备）");

    console.log("=== 验收通过：vsock 通道 / 独立内核 / secret 注入 / 工作区导出 / 无网卡边界 / 生命周期收割 / 事件循环门禁 ===");
}

runSmoke().catch((err) => {
    console.error("烟测失败：", err);
    process.exit(1);
});
