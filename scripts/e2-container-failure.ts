/**
 * G09 验收器（Provider 边界）：镜像缺失 / 容器创建失败 / 运行中容器消失。
 *
 * 通过标准：
 *  - 镜像缺失或创建失败：create 必须抛错，Sandbox 记录收敛为 FAILED，不留残留容器；
 *  - 运行中容器消失：execute 必须识别为 LOST 并发事件，而不是当成普通工具失败；
 *  - 失败之后同一个 Provider 仍能正常创建新沙箱（主进程可继续服务）。
 *
 * 用法：
 *   HARNESS_CONTAINER_IMAGE=alpine:3.20 HARNESS_CONTAINER_USER_ID=1000 \
 *     bun run scripts/e2-container-failure.ts
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

const root = mkdtempSync(join(tmpdir(), "harness-e2-g09-"));
const uid = configuredUid();
const image = process.env.HARNESS_CONTAINER_IMAGE ?? "alpine:3.20";
const store = new MemorySandboxStore();
const provider = new ContainerSandboxProvider(
    store as unknown as SandboxStore,
    new EnvironmentSecretProvider({}),
    { image, profile: "default", sandboxRuntime: "runsc", userId: uid },
);
const events: string[] = [];
provider.subscribe((event) => events.push(`${event.sandboxId}:${event.status}`));

async function docker(args: readonly string[]): Promise<string> {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
}

function policy(workspacePath: string): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: crypto.randomUUID(), runId: crypto.randomUUID(), tenantId: "tenant-g09",
        templateVersionId: "e2-g09", layers: [], createdAt: new Date().toISOString(),
        workspaceRoots: [workspacePath], allowNetwork: false, allowedSecrets: [],
        resourceLimits: { cpuCores: null, memoryMiB: null, diskMiB: null },
    };
}

function workspace(name: string): string {
    const path = join(root, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
}

const created: string[] = [];
const missingImageId = crypto.randomUUID();
const observed: Record<string, unknown> = {};
try {
    // 1) 镜像缺失
    const missingWs = workspace("missing-image");
    const missingImageProvider = new ContainerSandboxProvider(
        store as unknown as SandboxStore,
        new EnvironmentSecretProvider({}),
        { image: "agent-harness-image-that-does-not-exist:0.0.0", profile: "default", sandboxRuntime: "runsc", userId: uid },
    );
    let missingImageError: string | null = null;
    try {
        await missingImageProvider.create({
            id: missingImageId, runId: crypto.randomUUID(), instanceId: crypto.randomUUID(),
            workspacePath: missingWs, policy: policy(missingWs),
        });
    } catch (error) {
        missingImageError = error instanceof Error ? error.message : String(error);
    }
    const missingRecord = store.get(missingImageId);
    observed.missingImage = { error: missingImageError, status: missingRecord?.status ?? null,
                              reason: missingRecord?.failureReason ?? null };
    const missingLeftover = (await docker(["ps", "-a", "--filter", `name=agent-harness-${missingImageId}`, "--format", "{{.Names}}"]))
        .trim();

    // 2) 正常沙箱创建后，移除容器 -> 必须收敛为 LOST
    const victimWs = workspace("victim");
    const victim = await provider.create({
        id: crypto.randomUUID(), runId: crypto.randomUUID(), instanceId: crypto.randomUUID(),
        workspacePath: victimWs, policy: policy(victimWs),
    });
    created.push(victim.id);
    await docker(["rm", "--force", `agent-harness-${victim.id}`]);
    const afterRemoval = await provider.execute(victim.id, ["sh", "-lc", "true"]);
    const victimStatus = store.get(victim.id)?.status ?? null;
    observed.containerRemoved = {
        exitCode: afterRemoval.exitCode,
        stderr: afterRemoval.stderr.slice(0, 200),
        status: victimStatus,
        lostEventEmitted: events.includes(`${victim.id}:LOST`),
    };

    // 3) 失败之后仍能继续服务
    const recoveryWs = workspace("recovery");
    const recovery = await provider.create({
        id: crypto.randomUUID(), runId: crypto.randomUUID(), instanceId: crypto.randomUUID(),
        workspacePath: recoveryWs, policy: policy(recoveryWs),
    });
    created.push(recovery.id);
    const recoveryExec = await provider.execute(recovery.id, ["sh", "-lc", "echo RECOVERED"]);
    observed.afterFailure = { exitCode: recoveryExec.exitCode, stdout: recoveryExec.stdout.trim() };

    const checks = {
        missing_image_create_rejected: missingImageError !== null,
        missing_image_record_failed: missingRecord?.status === "FAILED",
        missing_image_no_leftover_container: missingLeftover === "",
        removed_container_detected_as_lost: victimStatus === "LOST",
        lost_lifecycle_event_emitted: events.includes(`${victim.id}:LOST`),
        provider_still_serves_after_failure: recoveryExec.exitCode === 0 && recoveryExec.stdout.includes("RECOVERED"),
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);

    console.log(JSON.stringify({
        result: failed.length === 0 ? "PASS" : "FAIL",
        checks, failedChecks: failed, observations: observed,
        lifecycle: events,
    }, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
} finally {
    for (const id of created) await provider.terminate(id).catch(() => undefined);
    await provider.terminate(missingImageId).catch(() => undefined);
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
