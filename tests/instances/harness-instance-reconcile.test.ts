import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
    createHarnessInstance,
    type HarnessInstanceActualState,
} from "../../src/instances/harness-instance.ts";
import {
    HarnessInstanceStore,
} from "../../src/instances/harness-instance-store.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

/**
 * N19 回归：启动对账必须清掉上次进程留下的实例槽位残留。
 *
 * 缺陷链条（R11 真机实证）：
 *   执行中被 SIGTERM → 实例停在 `actual_state=FAILED, active_run_count=1`。
 *   `acquireRun` 只在 READY/ACTIVE 时放行，而 `releaseRun` 会把 FAILED 保持住
 *   → 该实例**永远**拿不到槽位 → 每个恢复任务都是
 *   `RESUME_FAILED: HarnessInstance 无法获取执行槽位` → 协调器按
 *   INSTANCE_NOT_READY 重排 → 下一轮再失败 …… INTERRUPTED↔QUEUED 活锁，
 *   并且每轮失败的 RESUME 都真实创建/泄漏一个沙箱。
 *
 * 关键前提：进程刚启动时**没有任何 Run 在跑**，所以 `active_run_count > 0`
 * 一定是脏值。
 */

/**
 * 本文件只验证实例槽位对账 SQL。实例行引用的模板版本/能力档在测试里没有建，
 * 因此按 tests/workspaces/run-workspace-result.test.ts 的既有做法临时关闭外键
 * 校验（生产连接默认是 `PRAGMA foreign_keys = ON`）。
 */
function openDb(): Database {
    const db = openHarnessDatabase(":memory:");
    db.exec("PRAGMA foreign_keys = OFF;");
    return db;
}

function seedInstance(
    db: Database,
    overrides: {
        id: string;
        desiredState?: "RUNNING" | "STOPPED";
        actualState?: HarnessInstanceActualState;
        activeRunCount?: number;
    },
): void {
    const store = new HarnessInstanceStore(db);
    store.create(createHarnessInstance({
        id: overrides.id,
        tenantId: "tenant-1",
        templateVersionId: "template-version-1",
        capabilityProfileId: "capability-profile-1",
        runtimeKind: "PI",
        createdAt: "2026-09-11T00:00:00.000Z",
    }));
    // 直接改库模拟"上次进程执行中被杀"的现场，绕开状态机（状态机本就不允许
    // 从 PROVISIONING 一步到 FAILED 且带活跃计数，这正是脏状态的来源）。
    db.query(`
        UPDATE harness_instances
        SET desired_state = $desiredState,
            actual_state = $actualState,
            active_run_count = $activeRunCount,
            failure_reason = $failureReason,
            updated_at = $updatedAt
        WHERE id = $id;
    `).run({
        id: overrides.id,
        desiredState: overrides.desiredState ?? "RUNNING",
        actualState: overrides.actualState ?? "PROVISIONING",
        activeRunCount: overrides.activeRunCount ?? 0,
        failureReason: overrides.actualState === "FAILED"
            ? "上次进程异常退出"
            : null,
        updatedAt: "2026-09-11T01:00:00.000Z",
    });
}

test("N19：执行中被杀留下的 FAILED+计数1 会被重置为 READY 并可再次获取槽位", () => {
    const db = openDb();
    try {
        seedInstance(db, {
            id: "instance-crashed",
            actualState: "FAILED",
            activeRunCount: 1,
        });
        const store = new HarnessInstanceStore(db);

        // 修复前：FAILED 实例永远 acquire 不到 → 活锁起点。
        expect(() => store.acquireRun("instance-crashed"))
            .toThrow(/无法获取执行槽位/);

        const reconciled = store.reconcileStaleSlotsForStartup();

        expect(reconciled).toHaveLength(1);
        expect(reconciled[0]).toMatchObject({
            id: "instance-crashed",
            actualState: "READY",
            activeRunCount: 0,
            failureReason: null,
        });

        // 核心断言：对账之后恢复任务真的能拿到槽位了（活锁被打破）。
        const acquired = store.acquireRun("instance-crashed");
        expect(acquired.actualState).toBe("ACTIVE");
        expect(acquired.activeRunCount).toBe(1);
    } finally {
        db.close();
    }
});

test("N19：ACTIVE 但计数残留同样归零（启动时不可能有 Run 在跑）", () => {
    const db = openDb();
    try {
        seedInstance(db, {
            id: "instance-active-stale",
            actualState: "ACTIVE",
            activeRunCount: 3,
        });
        const store = new HarnessInstanceStore(db);

        const reconciled = store.reconcileStaleSlotsForStartup();

        expect(reconciled).toHaveLength(1);
        expect(reconciled[0]).toMatchObject({
            id: "instance-active-stale",
            actualState: "READY",
            activeRunCount: 0,
        });
    } finally {
        db.close();
    }
});

test("N19：STOPPED 的实例只清计数，不被误唤醒", () => {
    const db = openDb();
    try {
        seedInstance(db, {
            id: "instance-stopped",
            desiredState: "STOPPED",
            actualState: "STOPPED",
            activeRunCount: 2,
        });
        const store = new HarnessInstanceStore(db);

        const reconciled = store.reconcileStaleSlotsForStartup();

        expect(reconciled).toHaveLength(1);
        expect(reconciled[0]).toMatchObject({
            id: "instance-stopped",
            desiredState: "STOPPED",
            // 停机意图保留：不会被"修好"成 READY 去接任务。
            actualState: "STOPPED",
            activeRunCount: 0,
        });
    } finally {
        db.close();
    }
});

test("N19：健康实例不被触碰，对账是幂等的", () => {
    const db = openDb();
    try {
        seedInstance(db, {
            id: "instance-healthy",
            actualState: "READY",
            activeRunCount: 0,
        });
        seedInstance(db, {
            id: "instance-crashed-2",
            actualState: "FAILED",
            activeRunCount: 1,
        });
        const store = new HarnessInstanceStore(db);

        const first = store.reconcileStaleSlotsForStartup();
        expect(first.map((item) => item.id)).toEqual(["instance-crashed-2"]);

        // 幂等：再跑一次没有可修的东西，不会反复改库。
        expect(store.reconcileStaleSlotsForStartup()).toHaveLength(0);
        expect(store.get("instance-healthy")?.updatedAt)
            .toBe("2026-09-11T01:00:00.000Z");
    } finally {
        db.close();
    }
});
