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
}

type HarnessInstanceBindings = {
    [K in keyof HarnessInstance]: HarnessInstance[K];
};
