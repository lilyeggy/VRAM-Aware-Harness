import type { Database } from "bun:sqlite";
import type { HarnessInstance } from "./harness-instance.ts";

export class HarnessInstanceStore {
    constructor(private readonly db: Database) {}

    create(instance: HarnessInstance): void {
        this.db.query<unknown, HarnessInstanceBindings>(`
            INSERT INTO harness_instances (
                id, tenant_id, template_version_id, capability_profile_id,
                runtime_kind, desired_state, actual_state, failure_reason,
                created_at, updated_at
            ) VALUES (
                $id, $tenantId, $templateVersionId, $capabilityProfileId,
                $runtimeKind, $desiredState, $actualState, $failureReason,
                $createdAt, $updatedAt
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
}

type HarnessInstanceBindings = {
    [K in keyof HarnessInstance]: HarnessInstance[K];
};
