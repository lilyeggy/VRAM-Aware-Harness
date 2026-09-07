import { expect, test } from "bun:test";

import type { HarnessInstance } from "../../src/instances/harness-instance.ts";
import type { HarnessInstanceStore } from "../../src/instances/harness-instance-store.ts";
import type { RunAttempt } from "../../src/runs/run-attempt.ts";
import type { RunAttemptStore } from "../../src/runs/run-attempt-store.ts";
import type { SandboxProvider, SandboxRecord } from "../../src/sandbox/sandbox-provider.ts";
import { SandboxStartupReconciler } from "../../src/sandbox/sandbox-startup-reconciler.ts";
import type { SandboxStore } from "../../src/sandbox/sandbox-store.ts";

function fixture(cleanupFails = false) {
    let record = sandboxRecord();
    let attempt = runAttempt();
    let instance = harnessInstance();
    const cleanupCalls: string[] = [];
    const sandboxes = {
        listUnsettled: () => ["ACTIVE", "PROVISIONING"].includes(record.status) ? [record] : [],
        update: (next: SandboxRecord, previous: string) => {
            if (record.status !== previous) throw new Error("stale sandbox update");
            record = next;
        },
    } as unknown as SandboxStore;
    const attempts = {
        getBySandboxId: (id: string) => id === record.id ? attempt : null,
        update: (next: RunAttempt, previous: string) => {
            if (attempt.status !== previous) throw new Error("stale attempt update");
            attempt = next;
        },
    } as unknown as RunAttemptStore;
    const instances = {
        get: (id: string) => id === instance.id ? instance : null,
        update: (next: HarnessInstance, previous: string) => {
            if (instance.actualState !== previous) throw new Error("stale instance update");
            instance = next;
        },
    } as unknown as HarnessInstanceStore;
    const provider = {
        async cleanupStale(stale: SandboxRecord) {
            cleanupCalls.push(stale.id);
            if (cleanupFails) throw new Error("runtime unavailable");
        },
    } as unknown as SandboxProvider;
    return {
        reconciler: new SandboxStartupReconciler(sandboxes, provider, attempts, instances),
        cleanupCalls,
        state: () => ({ record, attempt, instance }),
    };
}

test("启动对账回收遗留环境并收敛 Sandbox、Attempt 和 Instance", async () => {
    const value = fixture();
    await value.reconciler.reconcile();
    expect(value.cleanupCalls).toEqual(["sandbox-1"]);
    expect(value.state().record).toMatchObject({
        status: "LOST",
        failureReason: "PROCESS_RESTART:遗留执行环境已回收",
    });
    expect(value.state().attempt).toMatchObject({ status: "INTERRUPTED" });
    expect(value.state().instance).toMatchObject({
        actualState: "FAILED",
        failureReason: expect.stringContaining("SANDBOX_RECONCILE"),
    });

    await value.reconciler.reconcile();
    expect(value.cleanupCalls).toEqual(["sandbox-1"]);
});

test("遗留环境无法确认清理时保持待对账并阻止每次服务启动", async () => {
    const value = fixture(true);
    await expect(value.reconciler.reconcile()).rejects.toThrow("拒绝启动");
    expect(value.state().record).toMatchObject({
        status: "ACTIVE",
        failureReason: expect.stringContaining("STARTUP_CLEANUP_FAILED"),
    });
    expect(value.state().attempt.status).toBe("INTERRUPTED");
    expect(value.state().instance.actualState).toBe("FAILED");
    await expect(value.reconciler.reconcile()).rejects.toThrow("拒绝启动");
    expect(value.cleanupCalls).toEqual(["sandbox-1", "sandbox-1"]);
});

function sandboxRecord(): SandboxRecord {
    return {
        id: "sandbox-1", instanceId: "instance-1", runId: "run-1",
        policySnapshotId: "policy-1", provider: "CONTAINER", profile: "default",
        runtime: "runsc", spec: {} as SandboxRecord["spec"],
        runtimeEvidence: {} as SandboxRecord["runtimeEvidence"], status: "ACTIVE",
        workspacePath: "/srv/workspace", secretNames: [],
        createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
        failureReason: null,
    };
}

function runAttempt(): RunAttempt {
    return {
        id: "attempt-1", runId: "run-1", attemptNumber: 1, kind: "START",
        instanceId: "instance-1", templateVersionId: "version-1",
        capabilityProfileId: "capability-1", policySnapshotId: "policy-1",
        sandboxId: "sandbox-1", status: "RUNNING",
        createdAt: "2026-08-22T00:00:00.000Z", startedAt: "2026-08-22T00:00:01.000Z",
        finishedAt: null, failureReason: null,
    };
}

function harnessInstance(): HarnessInstance {
    return {
        id: "instance-1", tenantId: "tenant-1", templateVersionId: "version-1",
        capabilityProfileId: "capability-1", runtimeKind: "PI",
        desiredState: "RUNNING", actualState: "ACTIVE", activeRunCount: 1, failureReason: null,
        createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:01.000Z",
    };
}
