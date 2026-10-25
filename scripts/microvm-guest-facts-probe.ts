/**
 * microVM guest 内事实探针（一次性）。
 *
 * 目的：攻击烟测里多条断言此前是"猜"的（以为 guest 没有 /home、没有
 * /root/.ssh），结果写出无法成立的断言。这里把 guest 内真实可见的事实
 * 一次性打印出来，后续断言只允许基于这些事实编写。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FirecrackerSandboxDriver, MicrovmSandboxProvider } from "../src/sandbox/microvm/index.ts";
import { unrestrictedPolicy } from "../src/policies/effective-policy.ts";
import type { SandboxRecord, SecretProvider } from "../src/sandbox/sandbox-provider.ts";

class MemorySandboxStore {
    private readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
    listActive(): SandboxRecord[] {
        return Array.from(this.records.values()).filter((r) => r.status === "ACTIVE");
    }
    listOrphans(): SandboxRecord[] { return []; }
    listUnsettled(): SandboxRecord[] { return this.listActive(); }
}

const root = mkdtempSync(join(tmpdir(), "harness-guest-probe-"));
const store = new MemorySandboxStore();
const secrets: SecretProvider = { get: () => null };
const diskTemplate = process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH;
const driverConfig = diskTemplate !== undefined ? { workspaceDiskTemplatePath: diskTemplate } : {};
const driver = new FirecrackerSandboxDriver(driverConfig);
const provider = new MicrovmSandboxProvider(store as never, secrets, {
    driver,
    ...driverConfig,
});
const sandboxId = "probe";

const PROBES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["root_mount", ["sh", "-c", "grep -E ' / / ' /proc/mounts || awk '$2==\"/\"{print}' /proc/mounts"]],
    ["all_block_devs", ["sh", "-c", "ls /dev/vd* /dev/nvme* /dev/sd* 2>&1"]],
    ["pci_devices", ["sh", "-c", "ls /sys/bus/pci/devices 2>/dev/null | wc -l"]],
    ["home_listing", ["sh", "-c", "ls -A /home 2>&1"]],
    ["root_ssh_listing", ["sh", "-c", "ls -A /root/.ssh 2>&1"]],
    ["root_listing", ["sh", "-c", "ls -A /root 2>&1"]],
    ["host_ssh_names_present", ["sh", "-c",
        "for n in authorized_keys id_ed25519 known_hosts; do test -e /root/.ssh/$n && echo \"HIT:$n\"; done; echo DONE"]],
    ["modules_disabled", ["sh", "-c", "cat /proc/sys/kernel/modules_disabled 2>&1"]],
    ["core_pattern_writable", ["sh", "-c", "test -w /proc/sys/kernel/core_pattern && echo WRITABLE || echo READONLY"]],
    ["kernel_release", ["uname", "-r"]],
    ["workspace_mount", ["sh", "-c", "grep -E '/workspace' /proc/mounts || echo NOMOUNT"]],
    ["workspace_df", ["sh", "-c", "df -h /workspace 2>&1 | tail -2"]],
    ["net_ifaces", ["sh", "-c", "ls /sys/class/net 2>&1"]],
    ["metadata_addr", ["sh", "-c", "ip -o addr 2>/dev/null | grep -c 169.254.169.254 || echo 0"]],
    ["pid_max", ["sh", "-c", "cat /proc/sys/kernel/pid_max 2>&1"]],
    ["mount_count", ["sh", "-c", "wc -l < /proc/mounts"]],
    ["dev_root", ["sh", "-c", "ls -la /dev/root 2>&1"]],
];

async function main(): Promise<void> {
    await provider.create({
        id: sandboxId,
        runId: "run-probe",
        workspacePath: root,
        policy: {
            ...unrestrictedPolicy,
            layers: [],
            id: "policy-probe",
            runId: "run-probe",
            userId: "probe-user",
            createdAt: new Date().toISOString(),
            workspaceRoots: [root],
            allowNetwork: false,
            allowedSecrets: [],
            resourceLimits: { cpuCores: 2, memoryMiB: 256, diskMiB: null },
        },
    });

    for (const [name, cmd] of PROBES) {
        try {
            const r = await provider.execute(sandboxId, cmd, { timeoutMs: 20000 });
            console.log(`\n### ${name} (exit=${r.exitCode})`);
            console.log(r.stdout.trim() || "(empty)");
            if (r.stderr.trim()) console.log(`[stderr] ${r.stderr.trim()}`);
        } catch (e) {
            console.log(`\n### ${name} -> THREW: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

main()
    .then(async () => {
        await provider.terminate(sandboxId).catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
        process.exit(0);
    })
    .catch(async (e) => {
        console.error("probe failed:", e);
        await provider.terminate(sandboxId).catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
        process.exit(1);
    });