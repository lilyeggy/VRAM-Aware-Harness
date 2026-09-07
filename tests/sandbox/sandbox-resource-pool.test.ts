import { expect, test } from "bun:test";
import { ManagedSandboxResourcePool, SandboxResourcePool } from "../../src/sandbox/sandbox-resource-pool.ts";

const profile = {
    image: "python:3.12-slim-bookworm",
    runtime: "runsc" as const,
    profile: "default" as const,
};

test("Resource 不携带租户身份，Lease 才绑定 Run、租户和授权上下文", () => {
    const pool = new SandboxResourcePool();
    const resource = pool.register({ id: "resource-1", profile });
    const acquired = pool.acquire({
        runId: "run-a",
        tenantId: "tenant-a",
        workspacePath: "/workspaces/tenant-a/w1",
        policySnapshotId: "policy-a",
        secretNames: ["MODEL_KEY"],
        profile,
    });

    expect(resource).not.toHaveProperty("tenantId");
    expect(resource).not.toHaveProperty("runId");
    expect(acquired?.lease).toMatchObject({
        runId: "run-a",
        tenantId: "tenant-a",
        workspacePath: "/workspaces/tenant-a/w1",
        policySnapshotId: "policy-a",
        secretNames: ["MODEL_KEY"],
    });
});

test("一个 Resource 同时只能分配一个 Lease", () => {
    const pool = new SandboxResourcePool();
    pool.register({ id: "resource-1", profile });
    const first = pool.acquire({ runId: "run-a", tenantId: "tenant-a", workspacePath: "/a", policySnapshotId: "p-a", secretNames: [], profile });
    const second = pool.acquire({ runId: "run-b", tenantId: "tenant-b", workspacePath: "/b", policySnapshotId: "p-b", secretNames: [], profile });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
});

test("只有所属租户可以读取和释放 Lease", () => {
    const pool = new SandboxResourcePool();
    pool.register({ id: "resource-1", profile });
    const acquired = pool.acquire({ runId: "run-a", tenantId: "tenant-a", workspacePath: "/a", policySnapshotId: "p-a", secretNames: ["TOKEN"], profile })!;

    expect(pool.getLease(acquired.lease.id, "tenant-b")).toBeNull();
    expect(() => pool.release(acquired.lease.id, "tenant-b", { scrubbed: true })).toThrow("无权释放");
    expect(pool.getLease(acquired.lease.id, "tenant-a")).not.toBeNull();
});

test("清理失败时 Resource 进入 QUARANTINED，不会带脏状态回池", () => {
    const pool = new SandboxResourcePool();
    pool.register({ id: "resource-1", profile });
    const acquired = pool.acquire({ runId: "run-a", tenantId: "tenant-a", workspacePath: "/a", policySnapshotId: "p-a", secretNames: [], profile })!;

    const quarantined = pool.release(acquired.lease.id, "tenant-a", { scrubbed: false, reason: "workspace cleanup failed" });
    expect(quarantined.state).toBe("QUARANTINED");
    expect(pool.acquire({ runId: "run-b", tenantId: "tenant-b", workspacePath: "/b", policySnapshotId: "p-b", secretNames: [], profile })).toBeNull();
});

test("释放并完成清理后 Resource 才能被下一个租户重新领取", () => {
    const pool = new SandboxResourcePool();
    pool.register({ id: "resource-1", profile });
    const first = pool.acquire({ runId: "run-a", tenantId: "tenant-a", workspacePath: "/a", policySnapshotId: "p-a", secretNames: [], profile })!;
    pool.release(first.lease.id, "tenant-a", { scrubbed: true });

    const second = pool.acquire({ runId: "run-b", tenantId: "tenant-b", workspacePath: "/b", policySnapshotId: "p-b", secretNames: [], profile });
    expect(second?.resource.id).toBe("resource-1");
    expect(second?.lease.tenantId).toBe("tenant-b");
});

test("异步资源池可以预热、等待 Lease，并在清理失败时隔离资源", async () => {
    let created = 0;
    let destroyed = 0;
    const pool = new ManagedSandboxResourcePool({
        async createResource() { created += 1; return { id: `resource-${created}` }; },
        async destroyResource() { destroyed += 1; },
    }, 1);
    expect(await pool.warm(profile)).toBe(1);
    const first = await pool.acquire({ runId: "run-a", tenantId: "tenant-a", workspacePath: "/a", policySnapshotId: "p-a", secretNames: [], profile });
    expect(first?.resource.state).toBe("LEASED");
    const waiting = pool.acquire({ runId: "run-b", tenantId: "tenant-b", workspacePath: "/b", policySnapshotId: "p-b", secretNames: [], profile }, { timeoutMs: 10 });
    expect(await waiting).toBeNull();
    pool.release(first!.lease.id, "tenant-a", { scrubbed: false });
    expect(await pool.destroyQuarantined()).toBe(1);
    expect(destroyed).toBe(1);
});
