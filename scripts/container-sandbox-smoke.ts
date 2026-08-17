import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerSandboxProvider } from "../src/sandbox/container-sandbox-provider.ts";
import { EnvironmentSecretProvider } from "../src/sandbox/managed-local-sandbox.ts";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../src/policies/effective-policy.ts";
import type { SandboxRecord } from "../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../src/sandbox/sandbox-store.ts";

class MemorySandboxStore {
    private readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
}

const root = mkdtempSync(join(tmpdir(), "harness-container-smoke-"));
const workspace = join(root, "workspace");
const uid = configuredUid();
const sandboxId = crypto.randomUUID();
const store = new MemorySandboxStore();
const provider = new ContainerSandboxProvider(
    store as unknown as SandboxStore,
    new EnvironmentSecretProvider({}),
    { image: process.env.HARNESS_CONTAINER_IMAGE ?? "alpine:3.20", userId: uid },
);

try {
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const handle = await provider.create({
        id: sandboxId,
        runId: crypto.randomUUID(),
        instanceId: crypto.randomUUID(),
        workspacePath: workspace,
        policy: policy(workspace),
    });
    const record = store.get(sandboxId);
    assert(record?.runtime === "runsc" && record.runtimeEvidence.verified, "未取得 runsc 实际 runtime 证据");
    const identity = await provider.execute(handle.id, ["sh", "-lc", "id -u"]);
    assert(identity.exitCode === 0 && identity.stdout.trim() === String(uid), "容器 UID 不匹配");
    const write = await provider.execute(handle.id, ["sh", "-lc", "printf smoke > smoke.txt && cat smoke.txt"]);
    assert(write.exitCode === 0 && write.stdout === "smoke", "容器无法写入自己的 Workspace");
    assert(readFileSync(join(workspace, "smoke.txt"), "utf8") === "smoke", "宿主机未看到 Workspace 结果");
    const rootWrite = await provider.execute(handle.id, ["sh", "-lc", "touch /etc/harness-must-not-write"]);
    assert(rootWrite.exitCode !== 0, "只读 RootFS 未阻止 /etc 写入");
    const network = await provider.execute(handle.id, ["sh", "-lc", "wget -T 2 -qO- http://1.1.1.1"]);
    assert(network.exitCode !== 0, "默认网络隔离未阻止外连");
    console.log(JSON.stringify({ result: "PASS", sandboxId, uid, runtime: record.runtime, checks: ["runsc_runtime_evidence", "non_root_uid", "workspace_write", "readonly_rootfs", "network_none"] }, null, 2));
} finally {
    await provider.terminate(sandboxId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
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

function policy(workspacePath: string): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: crypto.randomUUID(), runId: crypto.randomUUID(), tenantId: "SMOKE_TENANT",
        templateVersionId: "smoke-template", layers: [], createdAt: new Date().toISOString(),
        workspaceRoots: [workspacePath], allowNetwork: false,
        resourceLimits: { cpuCores: 0.5, memoryMiB: 128, diskMiB: null },
    };
}

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
