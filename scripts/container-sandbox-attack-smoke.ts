import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContainerSandboxProvider } from "../src/sandbox/container-sandbox-provider.ts";
import { EnvironmentSecretProvider } from "../src/sandbox/managed-local-sandbox.ts";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../src/policies/effective-policy.ts";
import type { SandboxRecord } from "../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../src/sandbox/sandbox-store.ts";

/**
 * Linux/Docker + gVisor attack smoke. This is intentionally a real-daemon
 * command: a fake Docker runtime cannot prove any of these boundaries.
 */
class MemorySandboxStore {
    private readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
}

const root = mkdtempSync(join(tmpdir(), "harness-sandbox-attacks-"));
const workspaceA = join(root, "tenant-a");
const workspaceB = join(root, "tenant-b");
const hostSentinel = join(root, "host-secret");
mkdirSync(workspaceA, { recursive: true, mode: 0o700 });
mkdirSync(workspaceB, { recursive: true, mode: 0o700 });
chmodSync(workspaceA, 0o700);
chmodSync(workspaceB, 0o700);
writeFileSync(join(workspaceA, "marker"), "A");
writeFileSync(join(workspaceB, "marker"), "B");
writeFileSync(hostSentinel, "host-only");

const tenantA = "tenant-a";
const tenantB = "tenant-b";
const store = new MemorySandboxStore();
const provider = new ContainerSandboxProvider(
    store as unknown as SandboxStore,
    new EnvironmentSecretProvider({
        [secretKey(tenantA, "TOKEN")]: "tenant-a-secret",
        [secretKey(tenantB, "TOKEN")]: "tenant-b-secret",
    }),
    {
        image: process.env.HARNESS_CONTAINER_IMAGE ?? "alpine:3.20",
        profile: "default",
        sandboxRuntime: "runsc",
        userId: configuredUid(),
    },
);
const events: string[] = [];
provider.subscribe((event) => events.push(`${event.sandboxId}:${event.status}`));
const sandboxA = crypto.randomUUID();
const sandboxB = crypto.randomUUID();

try {
    const handleA = await provider.create({
        id: sandboxA, runId: "run-a", instanceId: "instance-a",
        workspacePath: workspaceA,
        policy: policy("run-a", tenantA, workspaceA),
    });
    const handleB = await provider.create({
        id: sandboxB, runId: "run-b", instanceId: "instance-b",
        workspacePath: workspaceB,
        policy: policy("run-b", tenantB, workspaceB),
    });

    assert(store.get(sandboxA)?.runtimeEvidence.verified === true, "A 未取得 runsc 证据");
    assert(store.get(sandboxB)?.runtimeEvidence.verified === true, "B 未取得 runsc 证据");
    assert(await stdout(provider, sandboxA, ["sh", "-lc", "cat /workspace/marker"]) === "A", "A Workspace 不可读");
    assert(await stdout(provider, sandboxB, ["sh", "-lc", "cat /workspace/marker"]) === "B", "B Workspace 不可读");
    assert((await provider.execute(handleA.id, ["sh", "-lc", "test ! -e /workspace-b/marker"])).exitCode === 0, "跨 Tenant Workspace 可见");
    assert((await provider.execute(handleA.id, ["sh", "-lc", "test ! -e /host-secret"])).exitCode === 0, "宿主路径可见");
    assert((await provider.execute(handleA.id, ["sh", "-lc", "test ! -e /workspace/../workspace-b/marker"])).exitCode === 0, "Workspace 路径穿越成功");
    assert(await stdout(provider, sandboxA, ["sh", "-lc", "printf %s \"$TOKEN\""]) === "tenant-a-secret", "A Secret 不匹配");
    assert(await stdout(provider, sandboxB, ["sh", "-lc", "printf %s \"$TOKEN\""]) === "tenant-b-secret", "B Secret 不匹配");
    assert((await provider.execute(handleA.id, ["sh", "-lc", "test -z \"$OTHER_TOKEN\""])).exitCode === 0, "未授权 Secret 可见");
    assert((await provider.execute(handleA.id, ["sh", "-lc", "wget -T 2 -qO- http://1.1.1.1"])).exitCode !== 0, "默认网络可外连");

    // Bounded process pressure: pids-limit must stop the attempt from creating
    // an unbounded process tree; the command is bounded by one-second children.
    const pressure = await provider.execute(sandboxA, [
        "sh", "-lc", "i=0; while [ $i -lt 1000 ]; do sleep 1 & i=$((i+1)); done; wait",
    ]);
    assert(pressure.exitCode !== 0 || pressure.stderr.length > 0, "PID 耗尽没有返回受限结果");
    const fill = await provider.execute(sandboxA, [
        "sh", "-lc", "dd if=/dev/zero of=/tmp/fill bs=1m count=128 2>/dev/null",
    ]);
    assert(fill.exitCode !== 0, "tmpfs 资源耗尽没有被限制");

    // Simulate an unexpected container kill and verify the Provider emits LOST.
    await runDocker(["rm", "--force", `agent-harness-${sandboxB}`]);
    await provider.execute(sandboxB, ["sh", "-lc", "true"]);
    assert(store.get(sandboxB)?.status === "LOST", "容器消失没有收敛为 LOST");
    assert(events.some((event) => event === `${sandboxB}:LOST`), "没有 LOST 生命周期事件");

    console.log(JSON.stringify({
        result: "PASS",
        runtime: store.get(sandboxA)?.runtime,
        checks: [
            "runsc_runtime_evidence", "cross_tenant_workspace", "host_path",
            "path_traversal", "tenant_secret", "network_none", "pid_limit",
            "tmpfs_limit", "sandbox_lost",
        ],
    }, null, 2));
} finally {
    await provider.terminate(sandboxA).catch(() => undefined);
    await provider.terminate(sandboxB).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
}

function policy(runId: string, tenantId: string, workspacePath: string): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: crypto.randomUUID(), runId, tenantId,
        templateVersionId: "attack-smoke-template", layers: [],
        createdAt: new Date().toISOString(),
        workspaceRoots: [workspacePath], allowNetwork: false,
        allowedSecrets: ["TOKEN"],
        resourceLimits: { cpuCores: 0.5, memoryMiB: 128, diskMiB: null },
    };
}

async function stdout(
    provider: ContainerSandboxProvider,
    sandboxId: string,
    command: readonly string[],
): Promise<string> {
    const result = await provider.execute(sandboxId, command);
    assert(result.exitCode === 0, `命令失败：${result.stderr}`);
    return result.stdout;
}

async function runDocker(args: readonly string[]): Promise<void> {
    const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    await process.exited;
}

function secretKey(tenantId: string, name: string): string {
    return `HARNESS_SECRET_${Buffer.from(tenantId, "utf8").toString("hex").toUpperCase()}_${name}`;
}

function configuredUid(): number {
    const raw = process.env.HARNESS_CONTAINER_USER_ID;
    const fallback = process.getuid?.();
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value === undefined || value <= 0) {
        throw new Error("请设置非 root HARNESS_CONTAINER_USER_ID；smoke 不以 root 验证隔离");
    }
    return value;
}

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
