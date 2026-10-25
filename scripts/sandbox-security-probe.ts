import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { EnvironmentSecretProvider } from "../src/sandbox/managed-local-sandbox.ts";
import { FirecrackerSandboxDriver } from "../src/sandbox/microvm/firecracker-sandbox-driver.ts";
import { MicrovmSandboxProvider } from "../src/sandbox/microvm/microvm-sandbox-provider.ts";
import { InMemorySandboxStore } from "../src/sandbox/broker/in-memory-sandbox-store.ts";
import type { SandboxStore } from "../src/sandbox/sandbox-store.ts";
import type { EffectivePolicySnapshot } from "../src/policies/effective-policy.ts";

/**
 * 沙箱隔离性真机探针（§9.9 v1.5 / §9.6 维护）。
 *
 * 为什么需要它：模型会出于安全考虑拒绝执行"探测凭据与出网能力"的命令
 * （真机实测：deepseek-v4.1-flash 直接拒绝并给出替代命令），所以
 * "guest 无网卡 / 看不到宿主与其他用户 / 模型 key 不进沙箱"这些平台级断言
 * 不能靠 Agent 走工具链验证，必须在平台侧（provider.execute）直接下探。
 *
 * 覆盖：guest 网络设备与出网、宿主文件系统可见性、进程身份、rootfs 可写性、
 * secret 注入的用户作用域、跨沙箱工作区隔离。
 */

const ROOT = process.env.HARNESS_PROBE_ROOT ?? "/data/harness/security-probe";
const USER_A = "probe-a";
const USER_B = "probe-b";
const PLANTED_SECRET = "planted-secret-value";
const FAKE_MODEL_KEY = "should-never-reach-guest-model-key";
const workspaceDiskTemplatePath = process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH;
const vmRuntimeRoot = process.env.HARNESS_VM_RUNTIME_ROOT ?? join(ROOT, "runtime");

const secretHex = Buffer.from(USER_A, "utf8").toString("hex").toUpperCase();
const environment: Record<string, string | undefined> = { ...process.env };
environment["HARNESS_SECRET_" + secretHex + "_PROBE_TOKEN"] = PLANTED_SECRET;
environment.OPENCODE_API_KEY = FAKE_MODEL_KEY;
environment.PI_AUTH_TOKEN = FAKE_MODEL_KEY;

const driver = new FirecrackerSandboxDriver({
    binaryPath: process.env.FIRECRACKER_BINARY_PATH,
    jailerPath: process.env.FIRECRACKER_JAILER_PATH,
    kernelPath: process.env.FIRECRACKER_KERNEL_PATH,
    rootfsPath: process.env.FIRECRACKER_ROOTFS_PATH,
    workspaceDiskTemplatePath,
    vmRuntimeRoot,
    socketRoot: process.env.HARNESS_VM_SOCKET_ROOT,
    vsockPort: process.env.HARNESS_VSOCK_PORT === undefined
        ? undefined
        : Number(process.env.HARNESS_VSOCK_PORT),
    useJailer: process.env.HARNESS_USE_JAILER === "true",
    snapshotsEnabled: process.env.HARNESS_VM_SNAPSHOTS_ENABLED === "true",
    snapshotPoolDir: process.env.HARNESS_VM_SNAPSHOT_POOL_DIR,
    guestAgentVersion: process.env.HARNESS_GUEST_AGENT_VERSION,
});

// 与生产 Broker 同一构造方式（broker-main.ts:136-138）：Broker 侧只在内存里持有
// "当前由我持有"的映射，真实审计记录在 Master 的 SQLite。
const store = new InMemorySandboxStore();
const provider = new MicrovmSandboxProvider(
    store as unknown as SandboxStore,
    new EnvironmentSecretProvider(environment),
    { driver, workspaceDiskTemplatePath, vmRuntimeRoot },
);

const failures: string[] = [];
const report: Record<string, unknown> = {};

function check(name: string, ok: boolean, detail: string): void {
    if (ok === false) {
        failures.push(name);
    }
    console.log((ok ? "PASS " : "FAIL ") + name + " :: " + detail.slice(0, 300));
}

function policy(id: string, userId: string, allowedSecrets: readonly string[]): EffectivePolicySnapshot {
    return {
        id,
        runId: id,
        userId,
        layers: [],
        createdAt: new Date().toISOString(),
        sandboxProfile: "strict",
        allowedTools: null,
        allowedSkills: null,
        allowedModels: null,
        workspaceRoots: null,
        allowNetwork: false,
        allowProcess: true,
        allowedSecrets,
        resourceLimits: { cpuCores: 2, memoryMiB: Number(process.env.HARNESS_PROBE_MEMORY_MB ?? "256"), diskMiB: null },
    };
}

async function run(sandboxId: string, label: string, script: string): Promise<string> {
    const result = await provider.execute(sandboxId, ["/bin/sh", "-c", script]);
    const text = [
        "exitCode=" + String(result.exitCode),
        result.timedOut === undefined ? "" : " timedOut=" + String(result.timedOut),
        result.truncated === undefined ? "" : " truncated=" + String(result.truncated),
        "\n-- stdout --\n" + result.stdout,
        result.stderr.length === 0 ? "" : "\n-- stderr --\n" + result.stderr,
    ].join("");
    console.log("\n===== " + label + " (" + sandboxId + ") =====\n" + text);
    return result.stdout + "\n" + result.stderr;
}

async function main(): Promise<void> {
    mkdirSync(join(ROOT, "ws-a"), { recursive: true, mode: 0o700 });
    mkdirSync(join(ROOT, "ws-b"), { recursive: true, mode: 0o700 });

    const handleA = await provider.create({
        id: "security-probe-a",
        runId: "security-probe-a",
        workspacePath: join(ROOT, "ws-a"),
        policy: policy("policy-probe-a", USER_A, ["PROBE_TOKEN"]),
    });
    const handleB = await provider.create({
        id: "security-probe-b",
        runId: "security-probe-b",
        workspacePath: join(ROOT, "ws-b"),
        policy: policy("policy-probe-b", USER_B, []),
    });
    report.acquisitionA = handleA.acquisition;
    report.acquisitionB = handleB.acquisition;
    console.log("ACQUISITION A=" + JSON.stringify(handleA.acquisition ?? null)
        + " B=" + JSON.stringify(handleB.acquisition ?? null));

    try {
        const net = await run("security-probe-a", "guest-network", [
            "echo '== nics'; ls /sys/class/net",
            "echo '== iface'; ip -o link 2>/dev/null || ifconfig -a 2>/dev/null || echo NO_IP_TOOL",
            "echo '== route'; ip route 2>/dev/null || echo NO_ROUTE",
            "echo '== dns'; cat /etc/resolv.conf 2>/dev/null || echo NO_RESOLV",
            "echo '== egress'; (curl -s -m 4 http://1.1.1.1 && echo CURL_OK) || echo CURL_FAIL",
            "(wget -q -T 4 -O - http://1.1.1.1 && echo WGET_OK) || echo WGET_FAIL",
            "(nc -z -w 3 1.1.1.1 80 && echo NC_OK) || echo NC_FAIL",
            "(ping -c 1 -W 3 1.1.1.1 && echo PING_OK) || echo PING_FAIL",
        ].join("; "));
        const nics = (net.match(/== nics\n([^\n]*)/) ?? [])[1] ?? "";
        check("guest.只有 lo 网卡", nics.trim() === "lo", "nics=" + nics.trim());
        check("guest.无出网成功标记",
            net.includes("CURL_OK") === false
            && net.includes("WGET_OK") === false
            && net.includes("NC_OK") === false
            && net.includes("PING_OK") === false,
            "curl/wget/nc/ping 全失败");
        report.guestNetwork = net;

        const env = await run("security-probe-a", "guest-env-and-secrets", [
            "echo '== identity'; id; uname -a; echo '-- pid1'; cat /proc/1/comm",
            "echo '== granted-secret'; echo \"PROBE_TOKEN=${PROBE_TOKEN}\"",
            "echo '== all-env'; env | sort",
            "echo '== model-key-scan'; env | grep -c '" + FAKE_MODEL_KEY + "' || echo 0",
            "echo '== credentialish-names'; env | grep -iE 'OPENCODE|PI_AUTH|API_KEY|TOKEN' || echo NO_CREDENTIALISH_ENV",
        ].join("; "));
        check("guest.uid=0（guest 内 root）", env.includes("uid=0"), (env.match(/uid=[^\n]*/) ?? [""])[0]);
        check("guest.kernel 4.14.174", env.includes("4.14.174"), (env.match(/Linux[^\n]*/) ?? [""])[0]);
        check("guest.被授权的 secret 注入成功", env.includes("PROBE_TOKEN=" + PLANTED_SECRET), "PROBE_TOKEN 已注入");
        check("guest.宿主模型 key 未进入沙箱", env.includes(FAKE_MODEL_KEY) === false, "未出现 " + FAKE_MODEL_KEY);
        report.guestEnv = env;

        const host = await run("security-probe-a", "host-visibility", [
            "echo '== /home/cxr'; ls /home/cxr 2>&1 | head -3",
            "echo '== harness data'; ls /home/cxr/agent-harness-mt/data 2>&1 | head -3",
            "echo '== worker home'; ls /var/lib/harness-worker 2>&1 | head -3",
            "echo '== sqlite scan'; find / -maxdepth 4 -name 'harness.sqlite' 2>/dev/null | head -3; echo SCAN_DONE",
            "echo '== token files'; ls /etc/harness 2>&1 | head -3",
        ].join("; "));
        check("guest.看不到宿主家目录", host.includes("No such file") || host.includes("not found"), "ls /home/cxr 失败");
        check("guest.找不到宿主数据库", (host.split("SCAN_DONE")[0] ?? "").includes("harness.sqlite") === false, "find 未命中");
        report.hostVisibility = host;

        const fs = await run("security-probe-a", "filesystem", [
            "echo '== rootfs'; (touch /usr/local/probe-write && echo ROOTFS_WRITABLE) || echo ROOTFS_READ_ONLY",
            "echo '== etc'; (touch /etc/probe-write && echo ETC_WRITABLE) || echo ETC_READ_ONLY",
            "echo '== tmp'; (touch /tmp/probe-write && echo TMP_WRITABLE) || echo TMP_READ_ONLY",
            "echo '== workspace'; (echo marker-a > /workspace/marker-a.txt && echo WORKSPACE_WRITABLE) || echo WORKSPACE_READ_ONLY",
            "echo '== df'; df -h / /tmp /workspace 2>/dev/null",
            "echo '== mounts'; mount | head -12",
        ].join("; "));
        check("guest.rootfs 只读", fs.includes("ROOTFS_READ_ONLY"), "touch /usr/local 被拒");
        check("guest./tmp 可写（tmpfs）", fs.includes("TMP_WRITABLE"), "tmpfs 生效");
        check("guest./workspace 可写", fs.includes("WORKSPACE_WRITABLE"), "独立工作区磁盘");
        report.filesystem = fs;

        const cross = await run("security-probe-b", "cross-sandbox-isolation", [
            "echo '== own workspace'; ls -a /workspace",
            "echo '== peer marker'; cat /workspace/marker-a.txt 2>&1 | head -2",
            "echo '== peer user secret'; echo \"PROBE_TOKEN=${PROBE_TOKEN}\"",
            "echo '== other-user-workspaces'; ls /data/harness 2>&1 | head -3",
            "echo '== running VMs visible'; ls /proc | grep -c firecracker || echo 0",
        ].join("; "));
        // 注意：探针命令/报错文本里本身会出现 marker-a.txt，不能直接全串搜索；
        // 用"自己的 workspace 列表"判断可见性，并要求 cat 对方文件确实失败。
        const ownListing = (cross.match(/== own workspace\n([\s\S]*?)== peer marker/) ?? [])[1] ?? "";
        check(
            "跨沙箱.看不到对方工作区文件",
            ownListing.includes("marker-a") === false && cross.includes("can't open") === true,
            "own workspace 仅 lost+found，读对方文件失败",
        );
        check("跨沙箱.未获授权的 secret 未注入", cross.includes(PLANTED_SECRET) === false, "PROBE_TOKEN 为空");
        report.crossSandbox = cross;

        const limits = await run("security-probe-a", "resource-limits", [
            "echo '== cpu'; nproc; grep -c processor /proc/cpuinfo",
            "echo '== mem'; grep MemTotal /proc/meminfo",
            "echo '== cgroup'; cat /proc/self/cgroup 2>/dev/null | head -3",
        ].join("; "));
        report.limits = limits;
    } finally {
        await provider.terminate(handleA.id).catch(() => undefined);
        await provider.terminate(handleB.id).catch(() => undefined);
        rmSync(join(ROOT, "ws-a"), { recursive: true, force: true });
        rmSync(join(ROOT, "ws-b"), { recursive: true, force: true });
    }

    console.log("\nSANDBOX_SECURITY_PROBE_" + (failures.length === 0 ? "OK" : "FAIL")
        + " failed=" + JSON.stringify(failures));
}

await main();
