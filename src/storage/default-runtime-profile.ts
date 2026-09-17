import type { Database } from "bun:sqlite";

export const DEFAULT_RUNTIME_PROFILE_ID = "runtime:default";

/**
 * 精简控制面过渡期：RunExecutor 不再创建 Template / Instance /
 * CapabilityProfile，但旧的 Session / Attempt / PolicySnapshot / Sandbox
 * 表仍带有 legacy 外键。这里在数据库打开后写入一条默认控制面行，
 * 让这些旧外键约束继续可满足。等 schema 收敛 PR 后可以删除。
 */
export function ensureDefaultRuntimeProfile(db: Database): void {
    const now = new Date().toISOString();
    const id = DEFAULT_RUNTIME_PROFILE_ID;

    db.query(`
        INSERT OR IGNORE INTO harness_templates (id, tenant_id, created_at)
        VALUES ($id, 'runtime', $createdAt);
    `).run({ id, createdAt: now });

    db.query(`
        INSERT OR IGNORE INTO harness_template_versions (
            id, template_id, version, runtime_kind, spec_json, created_at
        ) VALUES ($id, $id, 1, 'PI', '{}', $createdAt);
    `).run({ id, createdAt: now });

    db.query(`
        INSERT OR IGNORE INTO runtime_capability_profiles (
            id, runtime_kind, deployment_key, supported_json,
            audit_completeness, reported_at
        ) VALUES ($id, 'PI', $id, '[]', 'FULL', $createdAt);
    `).run({ id, createdAt: now });

    db.query(`
        INSERT OR IGNORE INTO harness_instances (
            id, tenant_id, template_version_id, capability_profile_id,
            runtime_kind, desired_state, actual_state, failure_reason,
            created_at, updated_at, active_run_count
        ) VALUES (
            $id, 'runtime', $id, $id, 'PI',
            'RUNNING', 'READY', NULL, $createdAt, $createdAt, 0
        );
    `).run({ id, createdAt: now });
}
