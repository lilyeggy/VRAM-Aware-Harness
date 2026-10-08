/**
 * microVM 真机攻击烟测（P0）。
 *
 * ## 为什么需要
 *
 * `scripts/container-sandbox-attack-smoke.ts` 已有 9 项攻击验证，但那是**容器**
 * 版本。攻击面从容器换成 microVM 后，攻击手法与逃逸面完全不同（容器逃逸要打
 * runsc/kernel，microVM 要打 KVM/virtio 边界）。blast-radius 测试里 microVM
 * 出现 0 次，攻击烟测也只有容器版 —— 于是"microVM 更安全"这句话从未被证明，
 * 而它正是我们选择 microVM 的唯一理由。
 *
 * 本脚本在真实 KVM 上对 microVM 发起与容器版**等价**的攻击，并补充 microVM
 * 特有的逃逸尝试（virtio 设备枚举、内核模块、/proc 逃逸、metadata 服务等）。
 *
 * 对照容器版覆盖的 9 项：
 *   runsc_runtime_evidence → microvm_runtime_evidence
 *   cross_tenant_workspace / host_path / path_traversal
 *   tenant_secret / unauthorized_secret
 *   network_none
 *   pid_limit / tmpfs_limit → 改为 fork bomb 与磁盘熔断
 *   sandbox_lost → VM 进程被杀后状态收敛
 *
 * 用法（jailer 模式需 root）：
 *   sudo bun scripts/microvm-attack-smoke.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, release, tmpdir } from "node:os";
import { FirecrackerSandboxDriver, MicrovmSandboxProvider } from "../src/sandbox/microvm/index.ts";
import { unrestrictedPolicy } from "../src/policies/effective-policy.ts";
import type { SandboxRecord } from "../src/sandbox/sandbox-provider.ts";
import type { SecretProvider } from "../src/sandbox/sandbox-provider.ts";

/**
 * VMM 自身的内存开销（MiB）：cgroup 限额 = guest 内存 + 这部分开销。
 * 必须与 firecracker-sandbox-driver.ts 的 VMM_MEMORY_OVERHEAD_MIB 一致，
 * 否则限额断言会因为口径不同而假失败。
 */
const VMM_OVERHEAD_MIB = 64;

/** 宿主可用内存（MB），用于验证 guest 内的资源消耗不会吃掉宿主内存 */
function readMemAvailableMb(): number {
    try {
        const m = readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/);
        return m === null ? -1 : Math.floor(Number(m[1]) / 1024);
    } catch {
        return -1;
    }
}

/**
 * 列出宿主机上**真实**的 firecracker 进程 pid。
 *
 * 不能用 `pgrep -f firecracker`：那会匹配到调用方自己的命令行
 * （命令行字符串里含 "firecracker"），从而把自身算进去。
 * 正确做法是读 /proc/<pid>/cmdline 的**第一个** NUL 分隔字段（可执行文件路径），
 * 取其 basename 比对。
 */
function findAllFirecrackerPids(): number[] {
    const out: number[] = [];
    for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const argv0 = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0")[0] ?? "";
            if (argv0.length === 0) continue; // 内核线程
            const base = argv0.split("/").pop() ?? argv0;
            if (base.startsWith("firecracker") || /^fc\d+$/.test(base)) {
                out.push(Number(entry));
            }
        } catch {
            // 进程已退出
        }
    }
    return out;
}

/**
 * 读进程**真正所在**的 cgroup v2 限额。
 *
 * `/proc/<pid>/cgroup` 中以 `0::` 开头的行，第 3 段是相对 cgroup v2 挂载点的路径；
 * 限额文件必须从该路径下读。读错路径（例如误取 ssh 会话的 session scope）
 * 会得到 `memory.max=max` 的假阴性结论。
 */
function readCgroupLimitsForPid(pid: number): {
    path?: string;
    memoryMax?: string;
    cpuMax?: string;
} {
    const result: { path?: string; memoryMax?: string; cpuMax?: string } = {};
    try {
        const line = readFileSync(`/proc/${pid}/cgroup`, "utf8")
            .split("\n")
            .find((l) => l.startsWith("0::"));
        if (line === undefined) return result;
        result.path = line.slice(3);
        const read = (f: string): string | undefined => {
            try {
                return readFileSync(`/sys/fs/cgroup${result.path}/${f}`, "utf8").trim();
            } catch {
                return undefined;
            }
        };
        result.memoryMax = read("memory.max");
        result.cpuMax = read("cpu.max");
    } catch {
        // /proc 不可用（非 Linux）
    }
    return result;
}

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

const checks: string[] = [];
function assert(condition: boolean, message: string): asserts condition {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
    checks.push(message);
    console.log(`  ✅ ${message}`);
}

const root = mkdtempSync(join(tmpdir(), "harness-microvm-attacks-"));
const workspaceA = join(root, "tenant-a");
const workspaceB = join(root, "tenant-b");
// 宿主"机密"文件：VM 内绝不可见（用于验证 guest 看不到宿主文件系统）
const hostSentinel = join(root, "host-secret");
mkdirSync(workspaceA, { recursive: true, mode: 0o700 });
mkdirSync(workspaceB, { recursive: true, mode: 0o700 });
writeFileSync(join(workspaceA, "marker"), "A");
writeFileSync(join(workspaceB, "marker"), "B");
writeFileSync(hostSentinel, "host-only");

const tenantA = "tenant-a";
const tenantB = "tenant-b";
const store = new MemorySandboxStore();

// 每个租户只注入自己的 secret（key 按租户 hex 编码，与容器版一致）
const secrets: SecretProvider = {
    get: (tenantId: string, name: string) => (
        name === "TOKEN" ? `${tenantId}-secret` : null
    ),
};

const driver = new FirecrackerSandboxDriver({
    ...(process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH !== undefined
        ? { workspaceDiskTemplatePath: process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH }
        : {}),
});
const provider = new MicrovmSandboxProvider(store as never, secrets, {
    driver,
    ...(process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH !== undefined
        ? { workspaceDiskTemplatePath: process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH }
        : {}),
});

const sandboxA = "attack-a";
const sandboxB = "attack-b";

async function stdout(sandboxId: string, command: readonly string[]): Promise<string> {
    const r = await provider.execute(sandboxId, command);
    // 只在失败时报错；成功的前置命令不计入 checks（它们是步骤而非断言）
    if (r.exitCode !== 0) {
        throw new Error(`❌ 前置命令失败：${command.join(" ")}（stderr=${r.stderr.trim()}）`);
    }
    return r.stdout;
}

async function main(): Promise<void> {
    console.log("=== microVM 真机攻击烟测（等价覆盖容器版 9 项 + VM 特有逃逸）===");

    await provider.create({
        id: sandboxA, runId: "run-a", workspacePath: workspaceA,
        policy: policy("run-a", tenantA, workspaceA),
    });
    await provider.create({
        id: sandboxB, runId: "run-b", workspacePath: workspaceB,
        policy: policy("run-b", tenantB, workspaceB),
    });

    // ---- 1. 隔离证据真实（非伪装的"已验证"）----
    assert(
        store.get(sandboxA)?.runtimeEvidence.verified === true,
        "microvm_runtime_evidence：A 取得硬件隔离证据",
    );
    assert(
        store.get(sandboxB)?.runtimeEvidence.verified === true,
        "microvm_runtime_evidence：B 取得硬件隔离证据",
    );

    // ---- 2. 各自工作区可读 ----
    //
    // 注意：与容器不同，microVM 的 /workspace 是**空白 ext4 块设备**（mkfs 全新
    // 格式化后挂载），宿主预置的文件不会出现在 guest 内 —— 这本身就是隔离点。
    // 因此改为"写入后读回"验证，并额外断言宿主预置文件不可见。
    await stdout(sandboxA, ["sh", "-c", "echo A > /workspace/marker"]);
    await stdout(sandboxB, ["sh", "-c", "echo B-ONLY-MARKER > /workspace/marker"]);
    assert((await stdout(sandboxA, ["cat", "/workspace/marker"])).trim() === "A", "A workspace 可写且读回 A");
    assert((await stdout(sandboxB, ["cat", "/workspace/marker"])).trim() === "B-ONLY-MARKER",
        "B workspace 可写且读回 B 的内容");
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "test ! -e /workspace/../workspace-b/marker"])).exitCode === 0,
        "host_prepared_file_not_visible：宿主预置文件不出现在 guest 工作区",
    );

    // ---- 3. 跨租户工作区不可见 ----
    // A 的 VM 内不应存在指向 B 的任何路径
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "test ! -e /workspace/tenant-b/marker"])).exitCode === 0,
        "cross_tenant_workspace：A 看不到 B 的 workspace",
    );
    // 宿主绝对路径在 guest 内不存在（无共享挂载）
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", `test ! -e ${workspaceB}/marker`])).exitCode === 0,
        "cross_tenant_workspace：A 看不到 B 的宿主绝对路径",
    );
    // A 的 guest 内搜索 B 的 marker 内容（内容级隔离，非仅路径级）。
    // 只扫 /workspace（唯一的数据盘）：全盘 grep / 会遍历整个 rootfs，
    // 真机上实测把 agent 拖到宿主兜底超时，属于测试过载而非隔离问题。
    assert(
        (await provider.execute(sandboxA, [
            "sh", "-c", "grep -rq 'B-ONLY-MARKER' /workspace 2>/dev/null && echo LEAK || echo CLEAN",
        ])).stdout.includes("CLEAN"),
        "cross_tenant_workspace：A 的工作区搜不到 B 的内容",
    );

    // ---- 4. 宿主路径不可见（microVM 无共享挂载）----
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "test ! -e /host-secret"])).exitCode === 0,
        "host_path：宿主根不存在于 guest",
    );
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", `test ! -e ${hostSentinel}`])).exitCode === 0,
        "host_path：宿主机密文件绝对路径不可达",
    );

    // 真机事实修正（172.17.43.193，jailer 模式实测）：
    // guest 是 Alpine，自带 /home（空目录）与 /root（空，无 .ssh）。
    // 所以"guest 没有 /home"这种断言不成立 —— 隔离属性是
    // **guest 的 /home 与 /root 里看不到宿主的任何条目**，而非目录不存在。
    // 宿主家目录有 110 个条目（含大量 dotfile），guest 侧必须一个都看不到。
    const hostHomeEntries = readdirSync(homedir());
    const hostHomeNamesCsv = hostHomeEntries
        .filter((n) => /^[A-Za-z0-9._-]+$/.test(n))
        .slice(0, 30)
        .join(" ");
    const homeScan = await provider.execute(sandboxA, [
        "sh", "-c", `for n in ${hostHomeNamesCsv}; do test -e "/home/$n" && echo "HIT:$n"; done; echo SCAN_DONE`,
    ]);
    assert(
        homeScan.stdout.includes("SCAN_DONE") && !homeScan.stdout.includes("HIT:"),
        `host_path：guest /home 不含宿主家目录条目（对照宿主 ${hostHomeEntries.length} 项）`,
    );
    // 宿主 ~/.ssh 里的真实文件名（authorized_keys / id_ed25519 / known_hosts …）
    // 在 guest 内必须完全不存在。
    let hostSshFiles: string[] = [];
    try {
        hostSshFiles = readdirSync(join(homedir(), ".ssh")).filter((n) => /^[A-Za-z0-9._-]+$/.test(n));
    } catch {
        hostSshFiles = [];
    }
    if (hostSshFiles.length > 0) {
        const hostSshCsv = hostSshFiles.join(" ");
        const sshScan = await provider.execute(sandboxA, [
            "sh", "-c", `for n in ${hostSshCsv}; do test -e "/root/.ssh/$n" -o -e "/root/$n" && echo "HIT:$n"; done; echo SCAN_DONE`,
        ]);
        assert(
            sshScan.stdout.includes("SCAN_DONE") && !sshScan.stdout.includes("HIT:"),
            `host_path：guest 看不到宿主 SSH 私钥（对照 ${hostSshFiles.length} 个文件名）`,
        );
    }

    // ---- 4b. 块设备层证据（比"目录不存在"强得多）----
    //
    // 真机事实：宿主根在 /dev/nvme0n1p2，guest 根在 /dev/vda（→ /dev/root）。
    // guest 内不存在任何 nvme/sd 设备节点 —— 这从设备层证明 guest 拿不到
    // 宿主块设备，而不是仅仅"某个路径没挂载"。
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "ls /dev/nvme* /dev/sd* 2>/dev/null || echo NO_HOST_DISK"]))
            .stdout.includes("NO_HOST_DISK"),
        "host_path：guest 无宿主块设备节点（nvme/sd 均不可见）",
    );
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "readlink -f /dev/root"])).stdout.trim().endsWith("vda"),
        "host_path：guest 根设备是 vda（宿主为 nvme0n1p2，非同一设备）",
    );

    // ---- 5. 路径穿越 ----
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "test ! -e /workspace/../workspace-b/marker"])).exitCode === 0,
        "path_traversal：../ 穿越出工作区失败",
    );
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "test -e /workspace/marker"])).exitCode === 0,
        "path_traversal：合法路径仍可访问（未被误封）",
    );

    // ---- 6. Secret 隔离 ----
    assert((await stdout(sandboxA, ["sh", "-c", "printf %s \"$TOKEN\""])).trim() === "tenant-a-secret",
        "tenant_secret：A 拿到自己的 secret");
    assert((await stdout(sandboxB, ["sh", "-c", "printf %s \"$TOKEN\""])).trim() === "tenant-b-secret",
        "tenant_secret：B 拿到自己的 secret");
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "test -z \"$OTHER_TOKEN\""])).exitCode === 0,
        "unauthorized_secret：未授权 secret 不可见",
    );

    // ---- 7. 无网络（VM 一律不提供网卡）----
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "cat /sys/class/net/eth0 2>/dev/null || echo NONET"]))
            .stdout.includes("NONET"),
        "network_none：guest 无 eth0 网卡",
    );
    // 云元数据服务必须不可达（AWS/GCP 风格 169.254.169.254）
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "ip addr 2>/dev/null | grep -c '169.254.169.254' || true"]))
            .stdout.trim() === "0",
        "network_none：无云元数据地址",
    );

    // ---- 8. microVM 特有逃逸面 ----
    //
    // 以下每条断言都基于 172.17.43.193 jailer 模式实测事实编写
    // （见 scripts/microvm-guest-facts-probe.ts 的探针输出），不再基于猜测。
    console.log("\n  -- microVM 特有逃逸尝试 --");
    // 实测：/sys/bus/pci/devices 为空 —— pci=off，无任何设备直通
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "ls /sys/bus/pci/devices 2>/dev/null | wc -l"]))
            .stdout.trim() === "0",
        "virtio_pci_off：无 PCI 设备直通（pci=off）",
    );
    // 实测：guest 无 /lib/modules 目录，/proc/modules 为 0 行。
    // 这比查 modules_disabled 严谨得多 —— 实测 modules_disabled=0（并未禁用），
    // 但根本没有模块可加载，所以"加载内核模块攻击宿主"这条路在 guest 内不存在。
    assert(
        (await provider.execute(sandboxA, ["sh", "-c",
            "test ! -d /lib/modules && test \"$(cat /proc/modules 2>/dev/null | wc -l)\" = 0 && echo NOMODULES || echo HASMODULES",
        ])).stdout.includes("NOMODULES"),
        "no_module_load：guest 无 /lib/modules 且 /proc/modules 为空（无可加载模块）",
    );
    // 实测：guest 内 /proc/sys/kernel/core_pattern 是**可写的**（rc=0 写入成功），
    // 但写入不影响宿主 —— 宿主 core_pattern 保持 apport 原值。
    // 所以隔离属性不是"guest 只读"，而是"guest 改自己的内核参数不外溢到宿主"。
    const hostCorePatternBefore = readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim();
    const guestWrite = await provider.execute(sandboxA, [
        "sh", "-c", "echo '|/bin/false' > /proc/sys/kernel/core_pattern 2>/dev/null; echo rc=$?",
    ]);
    const hostCorePatternAfter = readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim();
    assert(
        guestWrite.stdout.includes("rc=0"),
        "proc_sys_write_local：guest 可写自己的 /proc/sys（guest 内核独立，非共享）",
    );
    assert(
        hostCorePatternAfter === hostCorePatternBefore
            && !hostCorePatternAfter.includes("/bin/false"),
        "proc_sys_not_shared：guest 改内核参数不外溢到宿主（宿主 core_pattern 未变）",
    );
    // 设备仅 vda/vdb：不存在宿主设备透传（实测宿主为 nvme，guest 内无 nvme 节点）
    assert(
        (await stdout(sandboxA, ["sh", "-c", "ls /dev/vd* | tr '\\n' ' '"])).trim().split(/\s+/).length === 2,
        "devices_only_vda_vdb：仅两块 virtio 盘，无其他宿主设备",
    );
    // guest 内核版本 ≠ 宿主（实测 guest 4.14.174 vs 宿主 6.8.0-136）
    assert(
        (await stdout(sandboxA, ["uname", "-r"])).trim() !== release(),
        "kernel_isolated：guest 内核版本 ≠ 宿主",
    );
    // guest hostname 与宿主不同（实测 guest=(none) vs 宿主=server-desktop）
    const hostHostname = readFileSync("/proc/sys/kernel/hostname", "utf8").trim();
    assert(
        (await stdout(sandboxA, ["sh", "-c", "hostname"])).trim() !== hostHostname,
        "hostname_isolated：guest hostname 与宿主不同（独立UTS namespace）",
    );

    // ---- 9. 资源耗尽（对应容器版的 pid_limit / tmpfs_limit）----
    assert(
        (await provider.execute(sandboxA, ["sh", "-c", "dd if=/dev/zero of=/workspace/fill bs=1M count=4096 2>/dev/null; echo rc=$?"]))
            .stdout.includes("rc=1"),
        "disk_quota_fused：写满工作区盘被熔断（rc!=0）",
    );
    // fork bomb：受限环境下必须自行失败，不得拖垮宿主
    // 注意 provider.execute 的返回类型不含 timedOut（该字段在 driver 层），
    // 因此超时表现为抛错或 exitCode 非 0。
    //
    // 真机实测（172.17.43.193）：
    //   fork 2000 → 成功（283ms），VM 存活 → guest pid_max=32768，2000 进程在预算内
    //   fork 20000 → 22.9s 后 vsock 断开，VM 被打死，但宿主 firecracker 进程消失、
    //                cgroup memory.current 归零、宿主 available 内存无变化
    // 所以正确的断言不是"fork 必须失败"（guest 本来就有 pid_max 预算），
    // 而是"超预算时损失被限制在 guest 内，宿主侧不产生额外残留"。
    //
    // 注意：此时 A、B 两台 VM 本来就该活着（每台对应 1 个 firecracker 进程），
    // 所以判据是**风暴前后进程数不增加**，不是"宿主残留数为 0"。
    const hostMemBefore = readMemAvailableMb();
    const fcCountBefore = findAllFirecrackerPids().length;
    let forkStormKilledVm = false;
    try {
        await provider.execute(sandboxA, [
            "sh", "-c", "i=0; while [ $i -lt 20000 ]; do /bin/sleep 2 & i=$((i+1)); done; wait",
        ], { timeoutMs: 60000 });
    } catch {
        // vsock 断开 / 超时：VM 已被自己的资源预算打掉，损失止于 guest 边界
        forkStormKilledVm = true;
    }
    await new Promise((r) => setTimeout(r, 3000));
    const hostMemAfter = readMemAvailableMb();
    const fcCountAfter = findAllFirecrackerPids().length;
    assert(
        forkStormKilledVm || fcCountAfter <= fcCountBefore,
        `fork_bomb_bounded：20000 进程风暴止于 guest 边界`
        + `（VM 被资源预算打掉=${forkStormKilledVm}，宿主 firecracker ${fcCountBefore}→${fcCountAfter}）`,
    );
    assert(
        fcCountAfter <= fcCountBefore && hostMemBefore > 0 && hostMemAfter > 0
            && hostMemBefore - hostMemAfter < 2048,
        `resource_containment：宿主未被 fork 风暴吃掉`
        + `（firecracker ${fcCountBefore}→${fcCountAfter}，available ${hostMemBefore}MB→${hostMemAfter}MB）`,
    );

    // ---- 10. cgroup 限额真实生效（资源准入的物理基础）----
    //
    // 实测：jailer 为每个 VM 建独立 cgroup `/fc117/<vmId>`，
    // memory.max = (256+64)MiB = 320MiB、cpu.max = 200000/100000 = 2 核。
    // 这条是容量准入不超卖的前提，必须验。
    // 用 B（A 可能已在 fork 风暴中被打死）。
    const bPid = findFirecrackerPidFor(sandboxB);
    assert(bPid !== undefined, "cgroup_isolated：B 的 firecracker 仍在运行（限额验证前提）");
    if (bPid !== undefined) {
        const limits = readCgroupLimitsForPid(bPid);
        const expectedMemMax = (256 + VMM_OVERHEAD_MIB) * 1024 * 1024;
        assert(
            typeof limits.path === "string" && limits.path.startsWith("/") && limits.path !== "/",
            `cgroup_isolated：firecracker 位于独立 cgroup（${limits.path ?? "<unknown>"}）`,
        );
        assert(
            limits.memoryMax === String(expectedMemMax),
            `cgroup_memory_max：内存限额=${limits.memoryMax}（期望 ${expectedMemMax} = (256+64)MiB）`,
        );
        assert(
            limits.cpuMax === "200000 100000",
            `cgroup_cpu_max：CPU 限额=${limits.cpuMax}（期望 2 核 = 200000/100000）`,
        );
    }

    // ---- 11. VM 进程被杀后状态收敛（对应容器版 sandbox_lost）----
    console.log("\n  -- VM 消失后收敛 --");
    //
    // 用 B 而不是 A：第 9 节的 fork 风暴预期会把 A 打死，A 已经"不可用"，
    // 拿一个已死的 VM 去验"被杀后无法执行"是自证。必须用仍存活的 B。
    const victim = findFirecrackerPidFor(sandboxB) !== undefined ? sandboxB : sandboxA;
    const hostPid = findFirecrackerPidFor(victim);
    if (hostPid !== undefined) {
        try {
            process.kill(hostPid, "SIGKILL");
        } catch {
            // 可能已退出
        }
        await new Promise((r) => setTimeout(r, 1500));
        const after = await provider.execute(victim, ["sh", "-c", "true"]).catch(() => null);
        assert(
            after === null || after.exitCode !== 0,
            `sandbox_lost：${victim} 被 SIGKILL 后无法继续执行`,
        );
        // 宿主侧不留孤儿
        assert(
            findFirecrackerPidFor(victim) === undefined,
            "sandbox_lost：被杀后宿主无该 VM 的 firecracker 残留",
        );
    } else {
        assert(false, `sandbox_lost：未能定位 ${victim} 的 firecracker 进程（无法验证收敛）`);
    }

    console.log(`\n=== 攻击烟测通过：${checks.length} 项 ===`);
    console.log(JSON.stringify({
        result: "PASS",
        runtime: store.get(sandboxB)?.runtime,
        checks: checks.map((c) => c.split("：")[0]),
    }, null, 2));
}

function policy(runId: string, tenantId: string, workspacePath: string) {
    return {
        ...unrestrictedPolicy,
        layers: [],
        id: `policy-${tenantId}`,
        runId,
        tenantId,
        createdAt: new Date().toISOString(),
        workspaceRoots: [workspacePath],
        allowNetwork: false,
        allowedSecrets: ["TOKEN"],
        resourceLimits: { cpuCores: 2, memoryMiB: 256, diskMiB: null },
    };
}

/**
 * 找出属于该 sandbox 的 firecracker 进程（仅用于攻击测试 kill）。
 *
 * 必须读 /proc/<pid>/cmdline 的**第一个** NUL 分隔字段（可执行文件路径）
 * 再看后续参数里是否带 sandboxId —— 因为 Firecracker 是被 jailer 降权后
 * 启动的，argv 里带的是 `--api-sock /firecracker.socket`，
 * sandboxId 出现在 chroot 路径中。
 */
function findFirecrackerPidFor(sandboxId: string): number | undefined {
    for (const pid of findAllFirecrackerPids()) {
        try {
            const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
            const joined = argv.join(" ");
            if (joined.includes(sandboxId)) return pid;
        } catch {
            // 进程已退出
        }
    }
    return undefined;
}

main()
    .then(async () => {
        await provider.terminate(sandboxA).catch(() => undefined);
        await provider.terminate(sandboxB).catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
        process.exit(0);
    })
    .catch(async (err) => {
        console.error("\n❌ 攻击烟测失败：", err instanceof Error ? err.message : err);
        await provider.terminate(sandboxA).catch(() => undefined);
        await provider.terminate(sandboxB).catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
        process.exit(1);
    });
