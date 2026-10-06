/**
 * microVM 真机深度审计（真实 Firecracker + KVM）。
 *
 * 与 server-microvm-smoke.ts 的区别：这里验证"隔离是否真的成立"，
 * 而不只是"链路是否跑通"。每一项都试图证伪隔离假设。
 *
 * 用法（真实硬件）：
 *   USE_FIRECRACKER=1 \
 *   FIRECRACKER_BINARY_PATH=... FIRECRACKER_KERNEL_PATH=... \
 *   FIRECRACKER_ROOTFS_PATH=... FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH=... \
 *   bun scripts/microvm-live-audit.ts
 *
 * 可选：
 *   HARNESS_USE_JAILER=false            非 jailer 模式（无 root 时）
 *   HARNESS_VM_SNAPSHOTS_ENABLED=true   开启快照/恢复路径并计时对比
 */

import { existsSync, readdirSync, statSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import * as os from "node:os";
import type { SandboxRecord, SecretProvider } from "../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../src/sandbox/sandbox-store.ts";
import {
    MicrovmSandboxProvider,
    FirecrackerSandboxDriver,
} from "../src/sandbox/microvm/index.ts";
import { unrestrictedPolicy } from "../src/policies/effective-policy.ts";

class MemorySandboxStore {
    readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
    listActive(): SandboxRecord[] {
        return Array.from(this.records.values()).filter((r) => r.status === "ACTIVE");
    }
    listOrphans(): SandboxRecord[] { return []; }
    listUnsettled(): SandboxRecord[] { return this.listActive(); }
}

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
    if (ok) {
        passed++;
        console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
    } else {
        failed++;
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

const runId = (tag: string) => `run-audit-${tag}-${Date.now()}`;

async function main(): Promise<void> {
    console.log("=== microVM 真机深度审计（隔离边界 / 数据落地 / 快照恢复）===");
    console.log(`宿主内核: ${os.release()}  |  KVM: ${existsSync("/dev/kvm") ? "present" : "absent"}`);

    const runtimeRoot = resolve(process.cwd(), "data/audit-vm-runtime");
    const hostWorkspace = resolve(process.cwd(), "data/audit-workspace");
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(hostWorkspace, { recursive: true, force: true });
    mkdirSync(hostWorkspace, { recursive: true, mode: 0o700 });

    const driver = new FirecrackerSandboxDriver({ vmRuntimeRoot: runtimeRoot });
    const store = new MemorySandboxStore();
    const secrets: SecretProvider = {
        get: (_t, name) => (name === "AUDIT_SECRET" ? "s3cr3t-audit-value" : null),
    };
    const provider = new MicrovmSandboxProvider(store as unknown as SandboxStore, secrets, {
        driver,
        vmRuntimeRoot: runtimeRoot,
        ...(process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH !== undefined
            ? { workspaceDiskTemplatePath: process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH }
            : {}),
    });

    const sbxId = `audit-${Date.now()}`;
    console.log(`\n[1] 创建 strict MicroVM (${sbxId})...`);
    const startedAt = performance.now();
    await provider.create({
        id: sbxId,
        runId: runId("main"),
        workspacePath: hostWorkspace,
        policy: {
            ...unrestrictedPolicy,
            id: "policy-audit",
            runId: runId("main"),
            tenantId: "tenant-audit",
            sandboxProfile: "strict",
            layers: [],
            createdAt: new Date().toISOString(),
            workspaceRoots: [hostWorkspace],
            allowNetwork: false,
            allowedSecrets: ["AUDIT_SECRET"],
        },
    });
    const createMs = performance.now() - startedAt;
    const createdRecord = store.get(sbxId);
    console.log(`    创建耗时 ${createMs.toFixed(0)}ms，evidence.verified=${createdRecord?.runtimeEvidence.verified}`);

    // ---- 隔离边界 ----
    console.log("\n[2] 隔离边界验证");
    const uname = await provider.execute(sbxId, ["uname", "-r"]);
    check("guest 内核版本 ≠ 宿主内核版本",
        uname.stdout.trim() !== os.release().trim(),
        `guest=${uname.stdout.trim()} host=${os.release()}`);

    const hostname = await provider.execute(sbxId, ["hostname"]);
    check("guest hostname 独立于宿主", hostname.stdout.trim() !== os.hostname(),
        `guest=${hostname.stdout.trim()} host=${os.hostname()}`);

    const hostDirProbe = await provider.execute(sbxId, ["ls", `/${hostWorkspace.replace(/^\//, "")}`]);
    check("guest 看不到宿主工作区目录（无共享挂载）",
        hostDirProbe.exitCode !== 0 || hostDirProbe.stdout.trim() === "",
        `exit=${hostDirProbe.exitCode} out=${hostDirProbe.stdout.trim().slice(0, 40)}`);

    const markerName = `guest-marker-${Date.now()}`;
    await provider.execute(sbxId, ["sh", "-c", `echo guest-only > /root/${markerName}`]);
    const hostSeesMarker = existsSync(join(hostWorkspace, markerName));
    check("guest 内写入不落到宿主文件系统（rootfs 为独立副本）", !hostSeesMarker);

    // guest 内核命令行（证明是独立内核 + 我们的 boot args）
    const cmdline = await provider.execute(sbxId, ["sh", "-c", "tr '\\0' ' ' < /proc/cmdline"]);
    check("guest cmdline 含我们的 boot args（console=ttyS0 pci=off）",
        cmdline.stdout.includes("console=ttyS0") && cmdline.stdout.includes("pci=off"),
        cmdline.stdout.trim());

    // 磁盘设备：root + workspace 两块盘
    const blockDev = await provider.execute(sbxId, ["sh", "-c", "ls /dev/vd* 2>/dev/null | tr '\\n' ' '"]);
    check("guest 可见 rootfs + 工作区盘（vda + vdb）",
        blockDev.stdout.includes("vda") && blockDev.stdout.includes("vdb"),
        blockDev.stdout.trim());

    // ---- 凭据 ----
    console.log("\n[3] 凭据注入");
    const secret = await provider.execute(sbxId, ["sh", "-c", "echo $AUDIT_SECRET"]);
    check("secret 通过 env 注入且值正确",
        secret.stdout.includes("s3cr3t-audit-value"), secret.stdout.trim());
    const secretLeak = await provider.execute(sbxId, ["sh", "-c", "env | grep -c AUDIT_SECRET"]);
    check("env 中仅该 secret 存在（无宿主其他凭据）",
        secretLeak.stdout.trim() === "1", `count=${secretLeak.stdout.trim()}`);

    // ---- 工作区数据落地 ----
    console.log("\n[4] 工作区数据落地（写入 → 终止 → 导出）");
    await provider.execute(sbxId, ["sh", "-c", "mkdir -p /workspace/out && echo 'result-line-1' > /workspace/report.txt && echo 'nested' > /workspace/out/deep.txt"]);
    check("VM 存活期间宿主看不到工作区文件（产物在 VM 磁盘内）",
        !existsSync(join(hostWorkspace, "report.txt")));

    await provider.execute(sbxId, ["sh", "-c", "ln -sf /etc/passwd /workspace/evil-link"]);
    await provider.execute(sbxId, ["sh", "-c", "ln -sf ../../escape.txt /workspace/evil-escape"]);

    const beforeTerminateFiles = readdirSync(hostWorkspace);
    console.log(`    terminate 前宿主工作区内容: [${beforeTerminateFiles.join(", ")}]`);

    await provider.terminate(sbxId);

    const exportedReport = join(hostWorkspace, "report.txt");
    const exportedDeep = join(hostWorkspace, "out", "deep.txt");
    check("产物 report.txt 已导出到宿主工作区", existsSync(exportedReport));
    check("子目录产物 out/deep.txt 已导出", existsSync(exportedDeep));
    if (existsSync(exportedReport)) {
        check("导出内容正确",
            readFileSync(exportedReport, "utf8").trim() === "result-line-1",
            JSON.stringify(readFileSync(exportedReport, "utf8").trim()));
    }
    check("符号链接未被导出（防逃逸）", !existsSync(join(hostWorkspace, "evil-link")));
    check("指向宿主外层的 evil-escape 未被导出", !existsSync(join(hostWorkspace, "escape.txt")));
    const finalFiles = readdirSync(hostWorkspace);
    check("导出后无临时目录残留", !finalFiles.some((f) => f.startsWith(".tmp-")),
        finalFiles.join(", "));

    // ---- 残留 ----
    console.log("\n[5] 生命周期残留");
    const record = store.get(sbxId);
    check("沙箱状态为 TERMINATED", record?.status === "TERMINATED", String(record?.status));
    check("VM 私有运行目录已删除", !existsSync(join(runtimeRoot, sbxId)));
    const tmpFc = existsSync("/tmp") ? readdirSync("/tmp").filter((f) => f.startsWith("fc-")) : [];
    check("/tmp 下无 fc-* 残留", tmpFc.length === 0, tmpFc.join(", "));
    const runtimeEntries = existsSync(runtimeRoot) ? readdirSync(runtimeRoot) : [];
    check("运行根目录为空", runtimeEntries.length === 0, runtimeEntries.join(", "));

    // ---- 快照 / 预热 ----
    if (process.env.HARNESS_VM_SNAPSHOTS_ENABLED === "true") {
        console.log("\n[6] 快照恢复路径（第二次创建应显著快于冷启动）");
        const sbx2 = `audit-snap-${Date.now()}`;
        const t2 = performance.now();
        const h2 = await provider.create({
            id: sbx2,
            runId: runId("snap"),
            workspacePath: hostWorkspace,
            policy: {
                ...unrestrictedPolicy,
                id: "policy-audit-snap",
                runId: runId("snap"),
                tenantId: "tenant-audit",
                sandboxProfile: "strict",
                layers: [],
                createdAt: new Date().toISOString(),
                workspaceRoots: [hostWorkspace],
                allowNetwork: false,
                allowedSecrets: ["AUDIT_SECRET"],
            },
        });
        const restoreMs = performance.now() - t2;
        console.log(`    第二次创建耗时 ${restoreMs.toFixed(0)}ms（首次 ${createMs.toFixed(0)}ms）`);
        const uname2 = await provider.execute(sbx2, ["uname", "-r"]);
        check("快照恢复后的 VM 仍能执行命令（agent 可用）", uname2.stdout.trim() === uname.stdout.trim(),
            uname2.stdout.trim());
        check("恢复路径耗时未劣化（≤ 冷启动）", restoreMs <= createMs + 50,
            `${restoreMs.toFixed(0)}ms vs ${createMs.toFixed(0)}ms`);
        check("acquisition 耗时如实记录", typeof h2.acquisition?.durationMs === "number",
            `${h2.acquisition?.durationMs}ms, warmHit=${h2.acquisition?.warmHit}`);
        await provider.terminate(sbx2);
    } else {
        console.log("\n[6] 快照路径未启用（HARNESS_VM_SNAPSHOTS_ENABLED!=true），跳过");
    }

    // ---- 非特权边界 ----
    console.log("\n[7] 宿主侧权限边界");
    const runtimeRootStat = existsSync(runtimeRoot) ? statSync(runtimeRoot).mode & 0o777 : -1;
    check("运行根目录为 0700（其他宿主用户不可进入）", runtimeRootStat === 0o700,
        `mode=${runtimeRootStat.toString(8)}`);

    console.log(`\n=== 审计完成：${passed} 项通过，${failed} 项失败 ===`);
    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("审计异常终止：", err);
    process.exit(1);
});
