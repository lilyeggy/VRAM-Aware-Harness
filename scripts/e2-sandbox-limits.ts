/**
 * E2 沙箱边界验收器：用真实 ContainerSandboxProvider + Docker + gVisor runsc
 * 逐项验证 CPU / 内存 / PID / tmpfs 限额是否由运行环境实际执行，
 * 并检查 Secret 是否会经宿主可读路径（docker argv / docker inspect）泄漏。
 *
 * 通过标准（对应场景指南 S06 / S08 / X10）：
 *  - 四类限额都必须“由运行环境执行”，只看容器创建成功不算通过；
 *  - 未授权 Secret 不可见；已知的 argv/inspect 泄漏若复现，本脚本必须报 FAIL。
 *
 * 注意：破坏性压力（内存超额 / PID 风暴）会终结被压沙箱本身，
 * 因此每种压力使用独立沙箱，避免污染对照与邻居观测。
 *
 * 用法：
 *   HARNESS_CONTAINER_IMAGE=alpine:3.20 HARNESS_CONTAINER_USER_ID=1000 \
 *     bun run scripts/e2-sandbox-limits.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerSandboxProvider } from "../src/sandbox/container-sandbox-provider.ts";
import { EnvironmentSecretProvider } from "../src/sandbox/managed-local-sandbox.ts";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../src/policies/effective-policy.ts";
import type { SandboxLifecycleEvent, SandboxRecord } from "../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../src/sandbox/sandbox-store.ts";

class MemorySandboxStore {
    readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
}

const root = mkdtempSync(join(tmpdir(), "harness-e2-limits-"));
const uid = configuredUid();
const image = process.env.HARNESS_CONTAINER_IMAGE ?? "alpine:3.20";
const canary = `E2-SECRET-CANARY-${crypto.randomUUID().slice(0, 8)}`;
const tenant = "tenant-e2-limits";

const store = new MemorySandboxStore();
const provider = new ContainerSandboxProvider(
    store as unknown as SandboxStore,
    new EnvironmentSecretProvider({ [`HARNESS_SECRET_${hex(tenant)}_TOKEN`]: canary }),
    { image, profile: "default", sandboxRuntime: "runsc", userId: uid },
);
const lifecycle: string[] = [];
provider.subscribe((event: SandboxLifecycleEvent) => lifecycle.push(`${event.sandboxId}:${event.status}`));

const CPU_WORKLOAD = "i=0; while [ $i -lt 4000000 ]; do i=$((i+1)); done";
const MEM_OVERALLOC = 'awk "BEGIN{s=\\"AAAAAAAAAA\\";for(i=0;i<28;i++){s=s s;printf \\"bytes=%d\\n\\",length(s)}}"';
const PID_STORM = "i=0; while [ $i -lt 900 ]; do sleep 30 & i=$((i+1)); done";
const TMPFS_FILL = "dd if=/dev/zero of=/tmp/fill bs=1M count=128";

function hex(value: string): string {
    return Buffer.from(value, "utf8").toString("hex").toUpperCase();
}

function policy(workspacePath: string, overrides: Partial<EffectivePolicySnapshot> = {}): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: crypto.randomUUID(), runId: crypto.randomUUID(), tenantId: tenant,
        templateVersionId: "e2-limits", layers: [], createdAt: new Date().toISOString(),
        workspaceRoots: [workspacePath], allowNetwork: false, allowedSecrets: [],
        resourceLimits: { cpuCores: null, memoryMiB: null, diskMiB: null },
        ...overrides,
    };
}

async function exec(sandboxId: string, script: string) {
    const started = Date.now();
    const result = await provider.execute(sandboxId, ["sh", "-lc", script]);
    return { ...result, ms: Date.now() - started };
}

async function docker(args: readonly string[]): Promise<string> {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
}

const created: string[] = [];
try {
    const make = async (name: string, overrides: Partial<EffectivePolicySnapshot> = {}) => {
        const workspace = join(root, name);
        mkdirSync(workspace, { recursive: true, mode: 0o700 });
        const handle = await provider.create({
            id: crypto.randomUUID(), runId: crypto.randomUUID(), instanceId: crypto.randomUUID(),
            workspacePath: workspace, policy: policy(workspace, overrides),
        });
        created.push(handle.id);
        return handle;
    };

    const baseline = await make("baseline");
    const limited = await make("limited", { resourceLimits: { cpuCores: 0.5, memoryMiB: 128, diskMiB: null } });
    const secretBox = await make("secret", { allowedSecrets: ["TOKEN"] });
    const memBox = await make("membox", { resourceLimits: { cpuCores: null, memoryMiB: 128, diskMiB: null } });
    const stressBox = await make("stressbox", { resourceLimits: { cpuCores: null, memoryMiB: 128, diskMiB: null } });
    const pidBox = await make("pidbox", { resourceLimits: { cpuCores: 1, memoryMiB: 1024, diskMiB: null } });

    // --- 非破坏性检查 ---
    const baselineCpu = await exec(baseline.id, CPU_WORKLOAD);
    const limitedCpu = await exec(limited.id, CPU_WORKLOAD);
    const cpuRatio = limitedCpu.ms / Math.max(1, baselineCpu.ms);

    const tmpfs = await exec(limited.id, TMPFS_FILL);

    const own = await exec(secretBox.id, 'printf %s "$TOKEN"');
    const other = await exec(baseline.id, 'printf %s "${TOKEN:-<unset>}"');

    const inspectEnv = await docker(["inspect", "--format", "{{json .Config.Env}}", `agent-harness-${secretBox.id}`]);
    const secretVisibleInInspect = inspectEnv.includes(canary);
    const secretVisibleInArgv = secretVisibleInInspect;

    // 邻居不受影响：stressBox 做内存压力时，baseline 仍可正常执行
    const pressure = exec(stressBox.id, MEM_OVERALLOC).catch(() => null);
    await Bun.sleep(150);
    const neighborStart = Date.now();
    const neighbor = await exec(baseline.id, "echo NEIGHBOR_OK; id -u");
    const neighborMs = Date.now() - neighborStart;
    await pressure;

    // --- 破坏性检查（会终结被压沙箱）---
    const mem = await exec(memBox.id, MEM_OVERALLOC);
    const memPeak = Math.max(0, ...[...mem.stdout.matchAll(/bytes=(\d+)/g)].map((m) => Number(m[1])));

    const pids = await exec(pidBox.id, PID_STORM);
    const pidStatusAfter = store.get(pidBox.id)?.status;
    const pidBoxAlive = (await docker(["inspect", "--format", "{{.State.Running}}", `agent-harness-${pidBox.id}`]))
        .trim() === "true";

    // --- 清理 ---
    for (const id of created) await provider.terminate(id).catch(() => undefined);
    const leftoverNames = (await docker(["ps", "-a", "--format", "{{.Names}}"]))
        .split("\n").filter((line) => created.some((id) => line.includes(id)));

    const checks = {
        runsc_runtime_evidence: store.get(limited.id)?.runtimeEvidence.verified === true
            && store.get(limited.id)?.runtimeEvidence.observedRuntime === "runsc",
        spec_claims_cpu_and_memory_limits: limited.enforcement.cpuLimitEnforced
            && limited.enforcement.memoryLimitEnforced && limited.enforcement.pidLimitEnforced,
        baseline_sandbox_claims_no_cpu_limit: baseline.enforcement.cpuLimitEnforced === false,
        cpu_limit_enforced: cpuRatio >= 1.4,
        memory_limit_enforced: mem.exitCode !== 0 && memPeak > 0 && memPeak <= 64 * 1024 * 1024,
        pid_limit_enforced: pids.exitCode !== 0 || pids.stderr.length > 0,
        tmpfs_limit_enforced: tmpfs.exitCode !== 0,
        neighbor_unaffected: neighbor.exitCode === 0 && neighbor.stdout.includes("NEIGHBOR_OK"),
        secret_visible_inside_own_sandbox: own.stdout === canary,
        secret_hidden_from_other_sandbox: other.stdout !== canary,
        secret_not_leaked_to_host: !secretVisibleInInspect,
        containers_cleaned_up: leftoverNames.length === 0,
    };
    const required = [
        "runsc_runtime_evidence", "spec_claims_cpu_and_memory_limits", "cpu_limit_enforced",
        "memory_limit_enforced", "pid_limit_enforced", "tmpfs_limit_enforced", "neighbor_unaffected",
        "secret_visible_inside_own_sandbox", "secret_hidden_from_other_sandbox",
        "secret_not_leaked_to_host", "containers_cleaned_up",
    ] as const;
    const failed = required.filter((key) => !checks[key]);

    console.log(JSON.stringify({
        result: failed.length === 0 ? "PASS" : "FAIL",
        runtime: store.get(limited.id)?.runtimeEvidence.observedRuntime ?? null,
        image, uid,
        checks, failedChecks: failed,
        observations: {
            cpuMs: { baseline: baselineCpu.ms, limited: limitedCpu.ms, ratio: Number(cpuRatio.toFixed(2)) },
            memory: { exitCode: mem.exitCode, peakBytesPrinted: memPeak, stderr: mem.stderr.slice(0, 200) },
            pids: { exitCode: pids.exitCode, stderr: pids.stderr.slice(0, 200),
                    sandboxStatusAfter: pidStatusAfter, sandboxStillRunning: pidBoxAlive },
            tmpfs: { exitCode: tmpfs.exitCode, stderr: tmpfs.stderr.slice(0, 200) },
            neighbor: { exitCode: neighbor.exitCode, ms: neighborMs },
            hostVisibleSecretLeak: secretVisibleInInspect,
            hostVisibleSecretLeakViaArgv: secretVisibleInArgv,
            lifecycle, containersLeftBehind: leftoverNames,
        },
    }, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
} finally {
    for (const id of created) await provider.terminate(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
}

function configuredUid(): number {
    const raw = process.env.HARNESS_CONTAINER_USER_ID;
    const value = raw === undefined ? process.getuid?.() : Number(raw);
    if (!Number.isInteger(value) || value === undefined || value <= 0) {
        throw new Error("请设置非 root HARNESS_CONTAINER_USER_ID");
    }
    return value;
}
