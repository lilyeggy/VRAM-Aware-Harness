import type { Database } from "bun:sqlite";
import type { HarnessInstance } from "./harness-instance.ts";

/**
 * N2：实例尚未就绪时 acquireRun 的可识别异常。
 *
 * 控制面 kill -9 后重启对账窗口里，DB 中实例行仍是旧的 actual_state
 * （READY/ACTIVE 之外），第一批排队 Run 的启动尝试会失败——这是瞬态，
 * 不是调度错误。抛出专用类型让协调器识别并按 DEFERRED 处理（下一轮
 * pump 重试），而不是把异常栈打满日志、把可恢复竞争当成事故。
 */
export class InstanceSlotUnavailableError extends Error {
    constructor(readonly instanceId: string) {
        super(`HarnessInstance 无法获取执行槽位：${instanceId}`);
        this.name = "InstanceSlotUnavailableError";
    }
}

export class HarnessInstanceStore {
    constructor(private readonly db: Database) {}

    create(instance: HarnessInstance): void {
        this.db.query<unknown, HarnessInstanceBindings>(`
            INSERT INTO harness_instances (
                id, tenant_id, template_version_id, capability_profile_id,
                runtime_kind, desired_state, actual_state, failure_reason,
                active_run_count, created_at, updated_at
            ) VALUES (
                $id, $tenantId, $templateVersionId, $capabilityProfileId,
                $runtimeKind, $desiredState, $actualState, $failureReason,
                $activeRunCount, $createdAt, $updatedAt
            );
        `).run({ ...instance });
    }

    get(id: string): HarnessInstance | null {
        return this.db.query<HarnessInstance, { id: string }>(`
            SELECT id, tenant_id AS tenantId,
                template_version_id AS templateVersionId,
                capability_profile_id AS capabilityProfileId,
                runtime_kind AS runtimeKind,
                desired_state AS desiredState,
                actual_state AS actualState,
                failure_reason AS failureReason,
                active_run_count AS activeRunCount,
                created_at AS createdAt, updated_at AS updatedAt
            FROM harness_instances WHERE id = $id;
        `).get({ id });
    }

    listForTenant(tenantId: string): HarnessInstance[] {
        return this.db.query<HarnessInstance, { tenantId: string }>(`
            SELECT id, tenant_id AS tenantId,
                template_version_id AS templateVersionId,
                capability_profile_id AS capabilityProfileId,
                runtime_kind AS runtimeKind,
                desired_state AS desiredState,
                actual_state AS actualState,
                failure_reason AS failureReason,
                active_run_count AS activeRunCount,
                created_at AS createdAt, updated_at AS updatedAt
            FROM harness_instances
            WHERE tenant_id = $tenantId
            ORDER BY updated_at DESC, id DESC;
        `).all({ tenantId });
    }

    update(instance: HarnessInstance, previousActualState: string): void {
        const parameters = { ...instance, previousActualState };
        const result = this.db.query<unknown, typeof parameters>(`
            UPDATE harness_instances SET
                desired_state = $desiredState,
                actual_state = $actualState,
                failure_reason = $failureReason,
                updated_at = $updatedAt
            WHERE id = $id AND actual_state = $previousActualState;
        `).run(parameters);
        if (result.changes !== 1) {
            throw new Error(`HarnessInstance 状态已变化：${instance.id}`);
        }
    }

    acquireRun(id: string): HarnessInstance {
        const result = this.db.query<unknown, { id: string; updatedAt: string }>(`
            UPDATE harness_instances
            SET active_run_count = active_run_count + 1,
                actual_state = 'ACTIVE', updated_at = $updatedAt
            WHERE id = $id AND desired_state = 'RUNNING'
                AND actual_state IN ('READY', 'ACTIVE');
        `).run({ id, updatedAt: new Date().toISOString() });
        if (result.changes !== 1) throw new InstanceSlotUnavailableError(id);
        return this.get(id)!;
    }

    releaseRun(id: string): HarnessInstance {
        const result = this.db.query<unknown, { id: string; updatedAt: string }>(`
            UPDATE harness_instances
            SET active_run_count = active_run_count - 1,
                actual_state = CASE
                    WHEN actual_state = 'FAILED' THEN 'FAILED'
                    WHEN active_run_count <= 1 THEN 'READY'
                    ELSE 'ACTIVE'
                END,
                updated_at = $updatedAt
            WHERE id = $id AND active_run_count > 0
                AND actual_state IN ('ACTIVE', 'FAILED');
        `).run({ id, updatedAt: new Date().toISOString() });
        if (result.changes !== 1) throw new Error(`HarnessInstance 无法释放执行槽位：${id}`);
        return this.get(id)!;
    }

    /**
     * N19：启动对账——清掉上一次进程留下的实例槽位残留。
     *
     * 为什么必须做：进程刚起来时**没有任何 Run 在跑**，所以此刻任何
     * `active_run_count > 0` 都是上次异常退出（被 SIGTERM / kill）留下的脏值。
     * 更要命的是 `acquireRun` 只在 `actual_state IN ('READY','ACTIVE')` 放行，
     * 而 `releaseRun` 遇到 FAILED 会把 FAILED 保持住——于是「执行中被杀 →
     * 实例停在 FAILED 且计数为 1」之后再也没人拿得到槽位：
     *
     *   RESUME_FAILED: HarnessInstance 无法获取执行槽位
     *   → 协调器按 INSTANCE_NOT_READY 重新入队 → 下一轮再失败 …… 无限活锁。
     *
     * 真机实证（R11）：活锁期间每轮失败的 RESUME 还会真实创建并泄漏一个沙箱。
     *
     * 处置：计数归零；`desired_state='RUNNING'` 的实例回到 READY 重新参与调度
     * （它本来就应该是可服务的）；`desired_state='STOPPED'` 的实例只清计数、
     * 保留停机意图，不会被误唤醒。
     *
     * @returns 被修正的实例，供启动日志交代"修了什么"——不静默改状态。
     */
    reconcileStaleSlotsForStartup(): HarnessInstance[] {
        const stale = this.db.query<HarnessInstance, Record<string, never>>(`
            SELECT id, tenant_id AS tenantId,
                template_version_id AS templateVersionId,
                capability_profile_id AS capabilityProfileId,
                runtime_kind AS runtimeKind,
                desired_state AS desiredState,
                actual_state AS actualState,
                failure_reason AS failureReason,
                active_run_count AS activeRunCount,
                created_at AS createdAt, updated_at AS updatedAt
            FROM harness_instances
            WHERE active_run_count > 0
                OR (desired_state = 'RUNNING'
                    AND actual_state NOT IN ('READY', 'ACTIVE'));
        `).all({});

        if (stale.length === 0) {
            return [];
        }

        const updatedAt = new Date().toISOString();
        const update = this.db.query<unknown, {
            id: string;
            actualState: string;
            failureReason: string | null;
            updatedAt: string;
        }>(`
            UPDATE harness_instances
            SET active_run_count = 0,
                actual_state = $actualState,
                failure_reason = $failureReason,
                updated_at = $updatedAt
            WHERE id = $id;
        `);

        const reconciled: HarnessInstance[] = [];
        for (const instance of stale) {
            const serviceable = instance.desiredState === "RUNNING";
            update.run({
                id: instance.id,
                actualState: serviceable ? "READY" : instance.actualState,
                failureReason: serviceable ? null : instance.failureReason,
                updatedAt,
            });
            const current = this.get(instance.id);
            if (current !== null) {
                reconciled.push(current);
            }
        }
        return reconciled;
    }
}

type HarnessInstanceBindings = {
    [K in keyof HarnessInstance]: HarnessInstance[K];
};
