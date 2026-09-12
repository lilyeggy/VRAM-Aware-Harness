/**
 * G10 验收器：容器 warm pool 的冷/热启动延迟、跨租户不重用、以及无残留。
 *
 * 通过标准：
 *  - 冷启动与热启动耗时都要报出，热启动必须显著更快且 warmHit=true；
 *  - 另一租户/另一 Workspace 不能租用到别人的热容器（跨租户不重用）；
 *  - 租到的热容器里看不到上一次使用留下的文件 / 环境变量 / Secret；
 *  - 结束后不遗留 agent-harness-warm-* 容器（按 TTL 或显式清理）。
 *
 * 用法：
 *   HARNESS_CONTAINER_IMAGE=alpine:3.20 HARNESS_CONTAINER_USER_ID=1000 \
 *     bun run scripts/e2-warm-pool.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerSandboxProvider } from "../src/sandbox/container-sandbox-provider.ts";
import { EnvironmentSecretProvider } from "../src/sandbox/managed-local-sandbox.ts";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../src/policies/effective-policy.ts";
import type { SandboxRecord } from "../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../src/sandbox/sandbox-store.ts";

class MemorySandboxStore {
    readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
}

const root = mkdtempSync(join(tmpdir(), "harness-e2-warm-"));
const uid = configuredUid();
const image = process.env.HARNESS_CONTAINER_IMAGE ?? "alpine:3.20";
const store = new MemorySandboxStore();
const provider = new ContainerSandboxProvider(
    store as unknown as SandboxStore,
    new EnvironmentSecretProvider({}),
    { image, profile: "default", sandboxRuntime: "runsc", userId: uid, warmPoolSize: 2, warmPoolOwner: "e2warm" },
);

async function docker(args: readonly string[]): Promise<string> {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
}

async function warmContainerNames(): Promise<string[]> {
    const out = await docker(["ps", "-a", "--filter", "label=agent-harness.warm-owner=e2warm", "--format", "{{.Names}}"]);
    return out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

function policy(workspacePath: string, tenantId: string): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: crypto.randomUUID(), runId: crypto.randomUUID(), tenantId,
        templateVersionId: "e2-warm", layers: [], createdAt: new Date().toISOString(),
        workspaceRoots: [workspacePath], allowNetwork: false, allowedSecrets: [],
        resourceLimits: { cpuCores: null, memoryMiB: null, diskMiB: null },
    };
}

function workspace(name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
}

async function create(path: string, tenantId: string) {
    return provider.create({
        id: crypto.randomUUID(), runId: crypto.randomUUID(), instanceId: crypto.randomUUID(),
        workspacePath: path, policy: policy(path, tenantId),
    });
}

const created: string[] = [];
try {
    const wsA = workspace("tenant-a-ws");
    const wsB = workspace("tenant-b-ws");

    // 1) 冷启动：池中无匹配项
    const coldStart = Date.now();
    const cold = await create(wsA, "tenant-a");
    const coldMs = Date.now() - coldStart;
    created.push(cold.id);
    const coldWarmHit = cold.acquisition?.warmHit ?? null;

    // 第一次 lease 时留下的 /tmp 痕迹，用于验证后续热容器无残留
    const leaf = await provider.execute(cold.id, ["sh", "-lc", "printf RESIDUE > /tmp/residue.txt; ls /tmp"]);
    await provider.terminate(cold.id);

    // 等待池内补充（terminate 触发 replenishment）
    let warmed: string[] = [];
    for (let i = 0; i < 40 && warmed.length === 0; i += 1) {
        await Bun.sleep(250);
        warmed = await warmContainerNames();
    }

    // 2) 热启动：同一 Workspace + 同一租户，应命中池
    const hotStart = Date.now();
    const hot = await create(wsA, "tenant-a");
    const hotMs = Date.now() - hotStart;
    created.push(hot.id);
    const hotWarmHit = hot.acquisition?.warmHit ?? null;

    // 3) 无残留：热容器里不应看到上一次 lease 写的 /tmp/residue.txt
    const residue = await provider.execute(hot.id, ["sh", "-lc", "ls -la /tmp 2>&1; echo ---; env | sort"]);
    const residueSeen = residue.stdout.includes("residue.txt");
    const envLeakSeen = /HARNESS_SECRET|TOKEN=/.test(residue.stdout);

    // 4) 跨租户/跨 Workspace 不得重用别人的热容器
    const foreign = await create(wsB, "tenant-b");
    created.push(foreign.id);
    const foreignWarmHit = foreign.acquisition?.warmHit ?? null;

    await provider.terminate(hot.id);
    await provider.terminate(foreign.id);
    await provider.close();

    // 5) 池冷却后不得残留 warm 容器
    let leftover: string[] = await warmContainerNames();
    for (let i = 0; i < 40 && leftover.length > 0; i += 1) {
        await Bun.sleep(500);
        leftover = await warmContainerNames();
    }

    const checks = {
        cold_start_not_from_pool: coldWarmHit === false,
        hot_start_from_pool: hotWarmHit === true,
        hot_start_faster: hotMs < coldMs,
        no_residue_from_previous_lease: !residueSeen,
        no_env_or_secret_residue: !envLeakSeen,
        no_cross_tenant_warm_reuse: foreignWarmHit === false,
        warm_pool_emptied: leftover.length === 0,
    };
    const required = Object.keys(checks) as (keyof typeof checks)[];
    const failed = required.filter((key) => !checks[key]);

    console.log(JSON.stringify({
        result: failed.length === 0 ? "PASS" : "FAIL",
        checks, failedChecks: failed,
        observations: {
            coldMs, hotMs,
            speedup: coldMs > 0 ? Number((coldMs / Math.max(1, hotMs)).toFixed(2)) : null,
            warmContainersAvailableBeforeHotLease: warmed.length,
            firstLeaseTmpListing: leaf.stdout.trim(),
            hotLeaseTmpAndEnv: residue.stdout.slice(0, 600),
            warmContainersLeftAfterClose: leftover,
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
