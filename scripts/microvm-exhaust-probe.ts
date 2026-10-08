/**
 * microVM 资源耗尽行为探针（一次性）。
 *
 * 目的：攻击烟测里的 `disk_quota_fused` / `fork_bomb_bounded` / `proc_sys_readonly`
 * 此前同样是"猜"的预期（以为 core_pattern 只读、以为 fork 会被限流）。
 * 真机事实：guest modules_disabled=0、core_pattern 可写、pid_max=32768。
 * 本探针把"资源耗尽时到底发生什么"一次性测清楚，并同时从宿主侧取对照值
 * （cgroup 限额、宿主 hostname 等），用于验证 guest 的写操作不会外溢到宿主。
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, release } from "node:os";
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

/**
 * 定位真实 firecracker 进程的 pid。
 *
 * 注意：不能用 `pgrep -f fc117` —— 那会匹配到调用方自己的 shell 命令行
 * （命令行里含 "fc117" 字符串），从而读到 ssh 会话的 cgroup 而非 VMM 的。
 * 必须逐个读 /proc/<pid>/cmdline 的 **第一个** 字段（可执行文件 basename）比对。
 */
function isRealFirecracker(pid: number): boolean {
    try {
        const first = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
        if (first.length === 0) return false;
        const base = first.split("/").pop() ?? first;
        return base === "fc117" || base === "firecracker";
    } catch {
        return false;
    }
}

function findFirecrackerPid(): number | undefined {
    for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        if (isRealFirecracker(Number(entry))) return Number(entry);
    }
    return undefined;
}

/**
 * 读该进程**真正所在**的 cgroup 限额。
 *
 * cgroup v2 下 `/proc/<pid>/cgroup` 的第 3 段是相对 cgroup v2 挂载点的路径；
 * 必须在该路径下读限额文件。之前误读成 ssh 会话的 session scope，
 * 导致 `memory.max=max` 的假阴性结论。
 */
function hostCgroupLimitsFor(pid: number): Record<string, string> {
    const out: Record<string, string> = {};
    let rel: string;
    try {
        const line = readFileSync(`/proc/${pid}/cgroup`, "utf8")
            .split("\n")
            .find((l) => l.startsWith("0::"));
        rel = line?.slice(3) ?? "/";
    } catch {
        return { error: "<unreadable /proc/pid/cgroup>" };
    }
    out.path = rel;
    for (const key of ["memory.max", "cpu.max", "pids.max", "memory.current"]) {
        try {
            out[key] = readFileSync(`/sys/fs/cgroup${rel}/${key}`, "utf8").trim();
        } catch {
            out[key] = "<unavailable>";
        }
    }
    return out;
}

const root = mkdtempSync(join(tmpdir(), "harness-exhaust-probe-"));
const store = new MemorySandboxStore();
const secrets: SecretProvider = { get: () => null };
const diskTemplate = process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH;
const driverConfig = diskTemplate !== undefined ? { workspaceDiskTemplatePath: diskTemplate } : {};
const driver = new FirecrackerSandboxDriver(driverConfig);
const provider = new MicrovmSandboxProvider(store as never, secrets, { driver, ...driverConfig });
const sandboxId = "exhaust";

async function run(label: string, cmd: readonly string[], timeoutMs = 30000): Promise<void> {
    const started = Date.now();
    try {
        const r = await provider.execute(sandboxId, cmd, { timeoutMs });
        console.log(`\n### ${label} (exit=${r.exitCode}, ${Date.now() - started}ms)`);
        console.log(r.stdout.trim() || "(empty)");
        if (r.stderr.trim()) console.log(`[stderr] ${r.stderr.trim().slice(0, 400)}`);
    } catch (e) {
        console.log(`\n### ${label} -> THREW after ${Date.now() - started}ms: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function main(): Promise<void> {
    await provider.create({
        id: sandboxId,
        runId: "run-exhaust",
        workspacePath: root,
        policy: {
            ...unrestrictedPolicy,
            layers: [],
            id: "policy-exhaust",
            runId: "run-exhaust",
            tenantId: "exhaust-tenant",
            createdAt: new Date().toISOString(),
            workspaceRoots: [root],
            allowNetwork: false,
            allowedSecrets: [],
            resourceLimits: { cpuCores: 2, memoryMiB: 256, diskMiB: null },
        },
    });

    console.log("=== 宿主对照 ===");
    const fcPid = findFirecrackerPid();
    console.log(`host_kernel=${release()}`);
    console.log(`host_firecracker_pid=${fcPid ?? "<none>"}`);
    if (fcPid !== undefined) console.log(`host_cgroup=${JSON.stringify(hostCgroupLimitsFor(fcPid))}`);
    console.log(`host_hostname=${(() => { try { return readFileSync("/proc/sys/kernel/hostname", "utf8").trim(); } catch { return "<unavailable>"; } })()}`);
    console.log(`host_home_entry_count=${readdirSync(process.env.HOME ?? "/root").length}`);

    console.log("\n=== guest 基线 ===");
    await run("guest_hostname_before", ["sh", "-c", "hostname"]);
    await run("guest_core_pattern_before", ["sh", "-c", "cat /proc/sys/kernel/core_pattern"]);
    await run("guest_meminfo_total", ["sh", "-c", "grep MemTotal /proc/meminfo"]);
    await run("guest_lib_modules", ["sh", "-c", "ls /lib/modules 2>&1 || echo NOMODDIR"]);
    await run("guest_procs_modules", ["sh", "-c", "cat /proc/modules 2>&1 | wc -l"]);

    console.log("\n=== guest 写 sysctl（看是否外溢到宿主）===");
    await run("guest_write_core_pattern", [
        "sh", "-c", "echo '|/bin/false' > /proc/sys/kernel/core_pattern 2>&1; echo rc=$?; cat /proc/sys/kernel/core_pattern",
    ]);

    console.log("\n=== 宿主是否被影响 ===");
    console.log(`host_core_pattern_now=${readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim()}`);
    console.log(`host_home_entry_count_now=${readdirSync(process.env.HOME ?? "/root").length}`);

    console.log("\n=== 磁盘耗尽 ===");
    await run("fill_workspace", [
        "sh", "-c", "dd if=/dev/zero of=/workspace/fill bs=1M count=4096 2>/dev/null; echo rc=$?; df -h /workspace | tail -1",
    ]);

    console.log("\n=== 内存耗尽（guest 应 OOM，不应拖垮宿主）===");
    // 注意：guest 是 busybox，`head -c 600M` 会报 "invalid number"（rc=0 是
    // 因为 shell 吞了错误）。必须用纯字节数，否则这一项等于没测。
    await run("mem_hog", [
        "sh", "-c", "head -c 600000000 /dev/zero > /dev/full 2>/dev/null; dd if=/dev/zero of=/dev/null bs=1M count=600 2>&1 | tail -2; echo done",
    ], 60000);
    await run("mem_alloc_in_guest", [
        "sh", "-c", "awk 'BEGIN{s=\"\"; for(i=0;i<4000;i++) s=s sprintf(\"%200000s\",\"x\"); print length(s)}' 2>&1 | tail -1",
    ], 60000);
    await run("alive_after_mem_hog", ["sh", "-c", "echo ALIVE; grep MemAvailable /proc/meminfo"]);

    console.log("\n=== fork 压力 ===");
    await run("fork_2000", [
        "sh", "-c", "i=0; while [ $i -lt 2000 ]; do /bin/true & i=$((i+1)); done; wait; echo rc=$?",
    ], 60000);
    await run("fork_20k", [
        "sh", "-c", "i=0; while [ $i -lt 20000 ]; do /bin/sleep 2 & i=$((i+1)); done; echo spawned=$i; wait",
    ], 90000);
    await run("still_alive_after_fork", ["sh", "-c", "echo ALIVE; grep MemAvailable /proc/meminfo"]);

    console.log("\n=== 宿主是否被拖垮 ===");
    const fcPidAfter = findFirecrackerPid();
    console.log(`fc_still_running=${fcPidAfter !== undefined}`);
    if (fcPidAfter !== undefined) {
        console.log(`host_cgroup_after=${JSON.stringify(hostCgroupLimitsFor(fcPidAfter))}`);
    }
    console.log(`host_home_entry_count_final=${readdirSync(process.env.HOME ?? "/root").length}`);
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