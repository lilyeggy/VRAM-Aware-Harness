import { expect, test } from "bun:test";

import {
    createRunAttempt,
    startRunAttempt,
} from "../../src/runs/run-attempt.ts";
import { RunAttemptStore } from "../../src/runs/run-attempt-store.ts";
import { RunLeaseManager } from "../../src/runs/run-lease-manager.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

function createRunRow(db: ReturnType<typeof openHarnessDatabase>): void {
    db.run(`
        INSERT INTO agent_runs (
            id, tenant_id, harness_session_id, status, user_input,
            workspace_path, created_at, updated_at, started_at, finished_at,
            checkpoint_id, failure_reason, run_policy_json, thinking_level, priority
        ) VALUES (
            'run-1', 'tenant-1', 'session-1', 'QUEUED', 'input',
            '/tmp/run-1', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z',
            NULL, NULL, NULL, NULL, NULL, 'off', 0
        );
    `);
}

function createAttempt() {
    return createRunAttempt({
        id: "attempt-1",
        runId: "run-1",
        attemptNumber: 1,
        kind: "START",
        policySnapshotId: null,
        sandboxId: null,
        createdAt: "2026-10-11T00:00:00.000Z",
    });
}

test("RunLeaseManager acquire/release 维护租约字段且幂等", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new RunAttemptStore(db);
        createRunRow(db);
        const attempt = createAttempt();
        store.create(attempt);

        let now = Date.parse("2026-10-11T00:00:00.000Z");
        const manager = new RunLeaseManager(store, {
            owner: "instance-a",
            leaseTtlMs: 60_000,
            heartbeatIntervalMs: 10_000,
            now: () => now,
        });

        const leased = manager.acquire(attempt);
        expect(leased.leaseOwner).toBe("instance-a");
        expect(leased.leaseExpiresAt).toBe("2026-10-11T00:01:00.000Z");
        expect(store.get(attempt.id)?.leaseOwner).toBe("instance-a");

        manager.release(attempt.id);
        expect(store.get(attempt.id)?.leaseOwner).toBeNull();
        manager.release(attempt.id);
        expect(store.get(attempt.id)?.leaseOwner).toBeNull();
    } finally {
        db.close();
    }
});

test("reapExpired 回收过期 RUNNING Attempt 并回调", () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new RunAttemptStore(db);
        createRunRow(db);
        let now = Date.parse("2026-10-11T00:00:00.000Z");
        const expired: string[] = [];
        const manager = new RunLeaseManager(store, {
            owner: "instance-a",
            leaseTtlMs: 1_000,
            heartbeatIntervalMs: 100,
            now: () => now,
            onExpired: (attempt) => {
                expired.push(attempt.id);
            },
        });
        const attempt = createAttempt();
        store.create(attempt);
        const leased = manager.acquire(attempt);
        store.update(leased, "PENDING");
        const running = startRunAttempt(
            leased,
            "2026-10-11T00:00:00.000Z",
            "policy-1",
            "sandbox-1",
        );
        store.update(running, "PENDING");

        expect(manager.reapExpired()).toEqual([]);

        now += 2_000;
        const reaped = manager.reapExpired();
        expect(reaped.map((item) => item.id)).toEqual([attempt.id]);
        expect(reaped[0]?.status).toBe("INTERRUPTED");
        expect(store.get(attempt.id)?.status).toBe("INTERRUPTED");
        expect(store.get(attempt.id)?.leaseOwner).toBeNull();
        expect(expired).toEqual([attempt.id]);
    } finally {
        db.close();
    }
});
