/**
 * Harness 的 schema migration 定义。
 *
 * migration 的作用是描述“数据库从一个版本升级到下一个版本需要执行什么 SQL”。
 * 新数据库一开始没有任何业务表，也没有 migration 记录，所以可以理解为版本 0。
 * 当 database.ts 发现当前版本是 0 时，就会执行这里的 version 1。
 *
 * 当前阶段我们只定义 up migration，不做 down migration。
 * 原因是 MVP 阶段更重要的是稳定创建 schema；回滚数据库结构可以等真正需要
 * 发布/降级流程时再补。
 */
export interface SchemaMigration {
    // 单调递增的 schema 版本号。后续新增 migration 时使用 2、3、4...
    version:number;

    // 给人看的 migration 名称，用于排查数据库当前应用过哪些变更。
    name:string;

    // 需要执行的 SQL。这里通常是 CREATE TABLE、ALTER TABLE、CREATE INDEX 等 DDL。
    up:string;
}

export const migrations: readonly SchemaMigration[] = [
    {
        version: 1,
        name: "create_agent_runs_and_run_events",
        up: `
            -- agent_runs 存储一个 AgentRun 的“当前快照”。
            -- 换句话说，如果我们想知道某个 run 现在是 RUNNING 还是 COMPLETED，
            -- 主要查这张表，而不是每次从事件流重新计算。
            CREATE TABLE agent_runs (
                -- Harness 自己生成的 run ID，作为业务主键。
                id TEXT PRIMARY KEY,

                -- tenant_id 用来支持未来多租户隔离。
                -- 即使 Day 2 还没有真正多租户，先把字段放进 schema 可以避免后续大改。
                tenant_id TEXT NOT NULL,

                -- harness_session_id 表示这个 run 属于哪个 Harness 会话。
                -- 一个 session 里可能会有多个 run。
                harness_session_id TEXT NOT NULL,

                -- status 是 run 的当前状态。
                -- CHECK 约束让数据库层也拒绝非法状态，和 TypeScript 状态机形成双保险。
                status TEXT NOT NULL CHECK (
                    status IN (
                        'QUEUED',
                        'RUNNING',
                        'WAITING_TOOL',
                        'INTERRUPTED',
                        'COMPLETED',
                        'FAILED'
                    )
                ),

                -- 用户最初交给 Harness 的任务输入。
                user_input TEXT NOT NULL,

                -- run 执行时绑定的工作目录。
                workspace_path TEXT NOT NULL,

                -- created_at / updated_at 使用 TEXT 存 ISO 时间字符串。
                -- 这样和 TypeScript 里的 AgentRun 字段保持一致，读写简单。
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,

                -- started_at / finished_at 只有进入对应生命周期后才有值。
                started_at TEXT,
                finished_at TEXT,

                -- checkpoint_id 用来连接未来的恢复/暂停能力。
                checkpoint_id TEXT,

                -- failure_reason 只在 FAILED 时记录错误原因。
                failure_reason TEXT
            );

            -- run_events 存储一个 run 的完整历史事件流。
            -- agent_runs 是“现在是什么状态”，run_events 是“过去发生过什么”。
            CREATE TABLE run_events (
                -- event_id 是事件自己的唯一 ID。
                event_id TEXT PRIMARY KEY,

                -- run_id 指向所属 AgentRun。
                run_id TEXT NOT NULL,

                -- sequence 是同一个 run 内的事件顺序。
                -- 它从 1 开始，方便按 sequence 排序还原执行过程。
                sequence INTEGER NOT NULL CHECK (sequence > 0),

                -- type 对应 TypeScript 里的 RunEventType。
                type TEXT NOT NULL,

                -- timestamp 是事件发生时间。
                timestamp TEXT NOT NULL,

                -- payload_version 给事件 payload 留演进空间。
                -- 将来某个事件 payload 结构升级时，可以靠这个字段区分解析方式。
                payload_version INTEGER NOT NULL
                    CHECK (payload_version > 0),

                -- payload_json 存事件附加数据。
                -- SQLite 这里先用 TEXT，不引入复杂 JSON 查询能力。
                payload_json TEXT NOT NULL,

                -- 开启 PRAGMA foreign_keys 后，这个约束会阻止孤儿事件。
                FOREIGN KEY (run_id)
                    REFERENCES agent_runs(id),

                -- 同一个 run 里不允许两个事件拥有相同 sequence。
                -- 这保证事件流顺序不会出现歧义。
                UNIQUE (run_id, sequence)
            );

            -- 常见查询：按租户和状态列出 run。
            -- 例如“查看某个 tenant 当前 RUNNING / FAILED 的任务”。
            CREATE INDEX idx_agent_runs_tenant_status
                ON agent_runs(tenant_id, status);

            -- 常见查询：按 Harness session 找到相关 run。
            CREATE INDEX idx_agent_runs_session
                ON agent_runs(harness_session_id);
        `,
    },
    {
        version: 2,
        name: "add_run_event_dedupe_key",
        up: `
            -- Day 2 的生命周期事件没有来源事件去重键，因此允许为 NULL。
            -- Day 3 由 RuntimeEventBridge 产生的模型/工具事件会提供稳定 key。
            ALTER TABLE run_events
                ADD COLUMN dedupe_key TEXT;

            -- 部分唯一索引只约束拥有 dedupe_key 的事件。
            -- 同一个 Runtime 事实重复投递时，第二次写入会命中此约束。
            CREATE UNIQUE INDEX idx_run_events_run_dedupe_key
                ON run_events(run_id, dedupe_key)
                WHERE dedupe_key IS NOT NULL;
        `,
    },
    {
        version: 3,
        name: "create_tool_executions_and_checkpoints",
        up: `
            -- tool_executions 记录“某次工具调用是否真正完成”。
            -- 它和 run_events 中的 TOOL_STARTED / TOOL_COMPLETED 不重复：
            -- run_events 用于解释时间线；tool_executions 用于控制重放和恢复。
            CREATE TABLE tool_executions (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,

                -- tool_call_id 来自 Runtime。相同 Run 内同一个调用只允许一条记录，
                -- 这是 ToolGateway 复用历史结果时使用的稳定业务键。
                tool_call_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                arguments_json TEXT NOT NULL,

                -- effect 决定 PREPARED 记录在进程重启后是否允许自动重放。
                effect TEXT NOT NULL CHECK (
                    effect IN (
                        'READ_ONLY',
                        'IDEMPOTENT_WRITE',
                        'UNKNOWN_EFFECT'
                    )
                ),

                -- PREPARED 表示执行意图已经持久化，但系统无法证明副作用是否发生；
                -- SUCCEEDED / FAILED 表示已经拿到确定结果。
                status TEXT NOT NULL CHECK (
                    status IN (
                        'PREPARED',
                        'SUCCEEDED',
                        'FAILED'
                    )
                ),
                result_json TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                finished_at TEXT,

                FOREIGN KEY (run_id)
                    REFERENCES agent_runs(id),

                UNIQUE (run_id, tool_call_id),
                UNIQUE (id, run_id),

                -- 用数据库约束拒绝明显矛盾的状态组合。
                CHECK (
                    (
                        status = 'PREPARED'
                        AND result_json IS NULL
                        AND error_message IS NULL
                        AND finished_at IS NULL
                    )
                    OR (
                        status = 'SUCCEEDED'
                        AND result_json IS NOT NULL
                        AND error_message IS NULL
                        AND finished_at IS NOT NULL
                    )
                    OR (
                        status = 'FAILED'
                        AND error_message IS NOT NULL
                        AND finished_at IS NOT NULL
                    )
                )
            );

            -- checkpoints 保存 Harness 已确认的安全恢复边界，而不是进程内存快照。
            -- Day 4 的第一种边界是“工具结果已经持久化”。
            CREATE TABLE checkpoints (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                tool_execution_id TEXT NOT NULL,
                runtime_session_ref TEXT NOT NULL,
                last_event_sequence INTEGER NOT NULL
                    CHECK (last_event_sequence > 0),
                created_at TEXT NOT NULL,

                FOREIGN KEY (run_id)
                    REFERENCES agent_runs(id),
                FOREIGN KEY (tool_execution_id, run_id)
                    REFERENCES tool_executions(id, run_id),

                -- 一次工具执行只形成一个完成 Checkpoint。
                UNIQUE (tool_execution_id)
            );

            CREATE INDEX idx_tool_executions_run_status
                ON tool_executions(run_id, status);

            CREATE INDEX idx_checkpoints_run_created
                ON checkpoints(run_id, created_at);
        `,
    },
    {
        version: 4,
        name: "create_resource_snapshots_and_policy_decisions",
        up: `
            -- resource_snapshots 保存准入决策真正使用的资源事实。
            -- PolicyDecision 不能只保存一个悬空 snapshotId，否则进程重启后
            -- 无法解释当时为什么把 Run 启动或排队。
            CREATE TABLE resource_snapshots (
                snapshot_id TEXT PRIMARY KEY,
                observed_at TEXT NOT NULL,

                -- 一个快照可能合并 vLLM、nvidia-smi 或 Fake 的读数。
                -- SQLite MVP 不需要按来源做复杂查询，因此保留为 JSON 数组。
                sources_json TEXT NOT NULL,

                gpu_total_memory_mib REAL,
                gpu_used_memory_mib REAL,
                gpu_free_memory_mib REAL,
                gpu_utilization_percent REAL,
                running_requests INTEGER,
                waiting_requests INTEGER,
                kv_cache_usage_percent REAL,
                input_tokens_per_second REAL,
                output_tokens_per_second REAL,

                CHECK (
                    gpu_total_memory_mib IS NULL
                    OR gpu_total_memory_mib >= 0
                ),
                CHECK (
                    gpu_used_memory_mib IS NULL
                    OR gpu_used_memory_mib >= 0
                ),
                CHECK (
                    gpu_free_memory_mib IS NULL
                    OR gpu_free_memory_mib >= 0
                ),
                CHECK (
                    running_requests IS NULL
                    OR running_requests >= 0
                ),
                CHECK (
                    waiting_requests IS NULL
                    OR waiting_requests >= 0
                )
            );

            -- policy_decisions 是追加式决策历史。
            -- 同一个 Run 可以经历 CRITICAL -> BUSY -> NORMAL，并分别留下
            -- QUEUE、QUEUE、START 三条记录，不能只覆盖保存最后一次结果。
            CREATE TABLE policy_decisions (
                decision_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK (
                    action IN ('START', 'QUEUE')
                ),
                reason_code TEXT NOT NULL CHECK (
                    reason_code IN (
                        'RESOURCE_NORMAL',
                        'GLOBAL_CONCURRENCY_LIMIT',
                        'RESOURCE_BUSY_TENANT_AVAILABLE',
                        'RESOURCE_BUSY_TENANT_LIMIT',
                        'RESOURCE_CRITICAL',
                        'RESOURCE_UNKNOWN',
                        'RESOURCE_OBSERVATION_FAILED'
                    )
                ),
                resource_snapshot_id TEXT,
                pressure TEXT NOT NULL CHECK (
                    pressure IN (
                        'NORMAL',
                        'BUSY',
                        'CRITICAL',
                        'UNKNOWN'
                    )
                ),
                observation_failure_reason TEXT CHECK (
                    observation_failure_reason IS NULL
                    OR observation_failure_reason IN (
                        'TIMEOUT',
                        'UNAVAILABLE',
                        'INVALID_RESPONSE'
                    )
                ),
                decided_at TEXT NOT NULL,

                FOREIGN KEY (run_id)
                    REFERENCES agent_runs(id),
                FOREIGN KEY (resource_snapshot_id)
                    REFERENCES resource_snapshots(snapshot_id),

                -- 观测失败没有 Snapshot，必须 fail-closed；成功观测产生的
                -- 决策则必须引用 Snapshot，且不能携带失败原因。
                CHECK (
                    (
                        reason_code = 'RESOURCE_OBSERVATION_FAILED'
                        AND resource_snapshot_id IS NULL
                        AND pressure = 'UNKNOWN'
                        AND action = 'QUEUE'
                        AND observation_failure_reason IS NOT NULL
                    )
                    OR (
                        reason_code <> 'RESOURCE_OBSERVATION_FAILED'
                        AND resource_snapshot_id IS NOT NULL
                        AND observation_failure_reason IS NULL
                    )
                )
            );

            CREATE INDEX idx_policy_decisions_run_decided
                ON policy_decisions(run_id, decided_at);
        `,
    },
    {
        version: 5,
        name: "create_harness_templates_and_versions",
        up: `
            -- harness_templates 保存模板的稳定身份和租户归属。
            -- 具体运行配置不放在这里，避免修改稳定对象时覆盖历史配置。
            CREATE TABLE harness_templates (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            -- harness_template_versions 保存已经发布的不可变期望配置。
            -- runtime_kind 单独保留，控制面无需解析 JSON 就能筛选 Runtime；
            -- spec_json 保存该 Runtime 对应的完整版本化配置。
            CREATE TABLE harness_template_versions (
                id TEXT PRIMARY KEY,
                template_id TEXT NOT NULL,
                version INTEGER NOT NULL CHECK (version > 0),
                runtime_kind TEXT NOT NULL,
                spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
                created_at TEXT NOT NULL,

                FOREIGN KEY (template_id)
                    REFERENCES harness_templates(id),

                -- 同一模板内一个版本号只能代表一份配置。
                UNIQUE (template_id, version)
            );

            CREATE INDEX idx_harness_templates_tenant
                ON harness_templates(tenant_id, created_at);

            CREATE INDEX idx_harness_template_versions_template
                ON harness_template_versions(template_id, version);
        `,
    },
    {
        version: 6,
        name: "create_instance_session_attempt_and_capability",
        up: `
            CREATE TABLE runtime_capability_profiles (
                id TEXT PRIMARY KEY,
                runtime_kind TEXT NOT NULL,
                deployment_key TEXT NOT NULL,
                supported_json TEXT NOT NULL CHECK (json_valid(supported_json)),
                audit_completeness TEXT NOT NULL CHECK (
                    audit_completeness IN ('FULL', 'PARTIAL')
                ),
                reported_at TEXT NOT NULL,
                UNIQUE (runtime_kind, deployment_key)
            );

            CREATE TABLE harness_instances (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                template_version_id TEXT NOT NULL,
                capability_profile_id TEXT NOT NULL,
                runtime_kind TEXT NOT NULL,
                desired_state TEXT NOT NULL CHECK (
                    desired_state IN ('RUNNING', 'STOPPED')
                ),
                actual_state TEXT NOT NULL CHECK (
                    actual_state IN (
                        'PROVISIONING', 'READY', 'ACTIVE', 'STOPPED', 'FAILED'
                    )
                ),
                failure_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (template_version_id)
                    REFERENCES harness_template_versions(id),
                FOREIGN KEY (capability_profile_id)
                    REFERENCES runtime_capability_profiles(id),
                CHECK (
                    (actual_state = 'FAILED' AND failure_reason IS NOT NULL)
                    OR (actual_state <> 'FAILED' AND failure_reason IS NULL)
                )
            );

            CREATE TABLE harness_sessions (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                instance_id TEXT NOT NULL,
                runtime_session_ref TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (instance_id)
                    REFERENCES harness_instances(id)
            );

            -- 旧 MVP Run 允许这些列为 NULL；Stage 1 正式应用入口创建的新 Run
            -- 必须写入三项引用，避免破坏已有数据库和历史测试数据。
            ALTER TABLE agent_runs
                ADD COLUMN template_version_id TEXT
                    REFERENCES harness_template_versions(id);
            ALTER TABLE agent_runs
                ADD COLUMN harness_instance_id TEXT
                    REFERENCES harness_instances(id);

            CREATE TABLE run_attempts (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
                kind TEXT NOT NULL CHECK (kind IN ('START', 'RESUME')),
                instance_id TEXT NOT NULL,
                template_version_id TEXT NOT NULL,
                capability_profile_id TEXT NOT NULL,
                policy_snapshot_id TEXT,
                sandbox_id TEXT,
                status TEXT NOT NULL CHECK (
                    status IN (
                        'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED',
                        'INTERRUPTED', 'REJECTED'
                    )
                ),
                created_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                failure_reason TEXT,
                FOREIGN KEY (run_id) REFERENCES agent_runs(id),
                FOREIGN KEY (instance_id) REFERENCES harness_instances(id),
                FOREIGN KEY (template_version_id)
                    REFERENCES harness_template_versions(id),
                FOREIGN KEY (capability_profile_id)
                    REFERENCES runtime_capability_profiles(id),
                UNIQUE (run_id, attempt_number)
            );

            CREATE INDEX idx_harness_instances_tenant_state
                ON harness_instances(tenant_id, actual_state);
            CREATE INDEX idx_harness_sessions_instance
                ON harness_sessions(instance_id, created_at);
            CREATE INDEX idx_run_attempts_run_number
                ON run_attempts(run_id, attempt_number);
        `,
    },
    {
        version: 7,
        name: "create_effective_policy_and_sandbox_evidence",
        up: `
            ALTER TABLE agent_runs
                ADD COLUMN run_policy_json TEXT CHECK (
                    run_policy_json IS NULL OR json_valid(run_policy_json)
                );

            CREATE TABLE effective_policy_snapshots (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                template_version_id TEXT NOT NULL,
                layers_json TEXT NOT NULL CHECK (json_valid(layers_json)),
                effective_json TEXT NOT NULL CHECK (json_valid(effective_json)),
                created_at TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES agent_runs(id),
                FOREIGN KEY (template_version_id)
                    REFERENCES harness_template_versions(id)
            );

            CREATE TABLE policy_compilations (
                id TEXT PRIMARY KEY,
                snapshot_id TEXT NOT NULL,
                runtime_kind TEXT NOT NULL,
                status TEXT NOT NULL CHECK (
                    status IN ('APPLIED', 'REJECTED', 'DEGRADED')
                ),
                compiled_json TEXT CHECK (
                    compiled_json IS NULL OR json_valid(compiled_json)
                ),
                reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
                created_at TEXT NOT NULL,
                FOREIGN KEY (snapshot_id)
                    REFERENCES effective_policy_snapshots(id)
            );

            CREATE TABLE tool_policy_decisions (
                id TEXT PRIMARY KEY,
                snapshot_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                tool_call_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN ('ALLOW', 'DENY')),
                reason TEXT NOT NULL,
                decided_at TEXT NOT NULL,
                FOREIGN KEY (snapshot_id)
                    REFERENCES effective_policy_snapshots(id),
                FOREIGN KEY (run_id) REFERENCES agent_runs(id),
                UNIQUE (run_id, tool_call_id)
            );

            CREATE TABLE sandboxes (
                id TEXT PRIMARY KEY,
                instance_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                policy_snapshot_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                status TEXT NOT NULL CHECK (
                    status IN (
                        'PROVISIONING', 'ACTIVE', 'TERMINATED', 'LOST', 'FAILED'
                    )
                ),
                workspace_path TEXT NOT NULL,
                secret_names_json TEXT NOT NULL CHECK (json_valid(secret_names_json)),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                failure_reason TEXT,
                FOREIGN KEY (instance_id) REFERENCES harness_instances(id),
                FOREIGN KEY (run_id) REFERENCES agent_runs(id),
                FOREIGN KEY (policy_snapshot_id)
                    REFERENCES effective_policy_snapshots(id)
            );

            CREATE INDEX idx_policy_snapshots_run
                ON effective_policy_snapshots(run_id, created_at);
            CREATE INDEX idx_policy_compilations_snapshot
                ON policy_compilations(snapshot_id, created_at);
            CREATE INDEX idx_sandboxes_run_status
                ON sandboxes(run_id, status);
        `,
    },
    {
        version: 8,
        name: "create_tenant_credentials_and_managed_workspaces",
        up: `
            -- API key 只保存不可逆摘要；明文只在创建时交给操作者一次。
            CREATE TABLE api_credentials (
                id TEXT PRIMARY KEY,
                key_digest TEXT NOT NULL UNIQUE,
                subject_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
                created_at TEXT NOT NULL,
                revoked_at TEXT
            );

            -- Workspace 的宿主路径由服务端生成，HTTP 客户端永远不提交 host path。
            CREATE TABLE workspaces (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                name TEXT NOT NULL,
                root_path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                UNIQUE (tenant_id, name)
            );

            CREATE INDEX idx_api_credentials_tenant
                ON api_credentials(tenant_id, revoked_at);
            CREATE INDEX idx_workspaces_tenant
                ON workspaces(tenant_id, created_at);
        `,
    },
    {
        version: 9,
        name: "create_access_audit_events",
        up: `
            CREATE TABLE access_audit_events (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                action TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK (outcome IN ('ALLOW', 'DENY')),
                subject_id TEXT,
                tenant_id TEXT,
                resource_type TEXT,
                resource_id TEXT,
                reason TEXT NOT NULL
            );
            CREATE INDEX idx_access_audit_tenant_timestamp
                ON access_audit_events(tenant_id, timestamp);
        `,
    },
    {
        version: 10,
        name: "create_run_output_chunks",
        up: `
            CREATE TABLE run_output_chunks (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                sequence INTEGER NOT NULL CHECK (sequence > 0),
                delta TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES agent_runs(id),
                UNIQUE (run_id, sequence)
            );
            CREATE INDEX idx_run_output_chunks_run_sequence
                ON run_output_chunks(run_id, sequence);
        `,
    },
    {
        version: 11,
        name: "create_persisted_run_workspace_results",
        up: `
            -- 两个不可变 manifest 让任务完成后仍可解释 Agent 对受管目录做了什么。
            CREATE TABLE run_workspace_snapshots (
                run_id TEXT NOT NULL,
                phase TEXT NOT NULL CHECK (phase IN ('BEFORE', 'AFTER')),
                manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
                captured_at TEXT NOT NULL,
                PRIMARY KEY (run_id, phase),
                FOREIGN KEY (run_id) REFERENCES agent_runs(id)
            );

            -- diff 是面向用户读取的物化结果；保留两个 manifest 以便复盘时重新验证它。
            CREATE TABLE run_workspace_diffs (
                run_id TEXT PRIMARY KEY,
                diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
                created_at TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES agent_runs(id)
            );
        `,
    },
    {
        version: 12,
        name: "create_immutable_run_artifacts",
        up: `
            CREATE TABLE run_artifacts (
                run_id TEXT NOT NULL,
                path TEXT NOT NULL,
                hash TEXT NOT NULL,
                size INTEGER NOT NULL CHECK (size >= 0),
                created_at TEXT NOT NULL,
                PRIMARY KEY (run_id, path),
                FOREIGN KEY (run_id) REFERENCES agent_runs(id)
            );
            CREATE INDEX idx_run_artifacts_run ON run_artifacts(run_id, path);
        `,
    },
    {
        version: 13,
        name: "add_sandbox_profile_runtime_evidence",
        up: `
            -- Existing rows are historical ManagedLocal records. They remain
            -- readable, but new runtime evidence is required for P0.5 rows.
            ALTER TABLE sandboxes ADD COLUMN profile TEXT NOT NULL DEFAULT 'development'
                CHECK (profile IN ('development', 'default', 'restricted-egress', 'strict'));
            ALTER TABLE sandboxes ADD COLUMN runtime TEXT NOT NULL DEFAULT 'managed-local';
            ALTER TABLE sandboxes ADD COLUMN spec_json TEXT NOT NULL DEFAULT '{}'
                CHECK (json_valid(spec_json));
            ALTER TABLE sandboxes ADD COLUMN runtime_evidence_json TEXT NOT NULL DEFAULT '{}'
                CHECK (json_valid(runtime_evidence_json));
        `,
    },
    {
        version: 14,
        name: "allow_tenant_budget_reason_code",
        up: `
            -- Rebuild policy_decisions so the reason_code CHECK also accepts the
            -- tenant-budget layer's TENANT_BUDGET_EXCEEDED (clone + copy is the
            -- SQLite way to change a CHECK).
            CREATE TABLE policy_decisions_v14 (
                decision_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK (
                    action IN ('START', 'QUEUE')
                ),
                reason_code TEXT NOT NULL CHECK (
                    reason_code IN (
                        'RESOURCE_NORMAL',
                        'GLOBAL_CONCURRENCY_LIMIT',
                        'RESOURCE_BUSY_TENANT_AVAILABLE',
                        'RESOURCE_BUSY_TENANT_LIMIT',
                        'RESOURCE_CRITICAL',
                        'RESOURCE_UNKNOWN',
                        'RESOURCE_OBSERVATION_FAILED',
                        'TENANT_BUDGET_EXCEEDED'
                    )
                ),
                resource_snapshot_id TEXT,
                pressure TEXT NOT NULL CHECK (
                    pressure IN ('NORMAL', 'BUSY', 'CRITICAL', 'UNKNOWN')
                ),
                observation_failure_reason TEXT CHECK (
                    observation_failure_reason IS NULL
                    OR observation_failure_reason IN (
                        'TIMEOUT', 'UNAVAILABLE', 'INVALID_RESPONSE'
                    )
                ),
                decided_at TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES agent_runs(id),
                FOREIGN KEY (resource_snapshot_id) REFERENCES resource_snapshots(snapshot_id),
                CHECK (
                    (
                        reason_code = 'RESOURCE_OBSERVATION_FAILED'
                        AND resource_snapshot_id IS NULL
                        AND pressure = 'UNKNOWN'
                        AND action = 'QUEUE'
                        AND observation_failure_reason IS NOT NULL
                    )
                    OR (
                        reason_code <> 'RESOURCE_OBSERVATION_FAILED'
                        AND resource_snapshot_id IS NOT NULL
                        AND observation_failure_reason IS NULL
                    )
                )
            );
            INSERT INTO policy_decisions_v14
                SELECT decision_id, run_id, action, reason_code,
                    resource_snapshot_id, pressure,
                    observation_failure_reason, decided_at
                FROM policy_decisions;
            DROP TABLE policy_decisions;
            ALTER TABLE policy_decisions_v14 RENAME TO policy_decisions;
        `,
    },
    {
        version: 15,
        name: "drop_tenant_user_subject_id",
        up: `
            -- tenant = 用户（产品决定）：subjectId 与 tenantId 一一对应，冗余去除。
            -- SQLite 改列用“建新表→复制→删旧→改名”，保留原约束与索引。

            -- api_credentials：去掉 subject_id
            CREATE TABLE api_credentials_v15 (
                id TEXT PRIMARY KEY,
                key_digest TEXT NOT NULL UNIQUE,
                tenant_id TEXT NOT NULL,
                scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
                created_at TEXT NOT NULL,
                revoked_at TEXT
            );
            INSERT INTO api_credentials_v15 (id, key_digest, tenant_id, scopes_json, created_at, revoked_at)
                SELECT id, key_digest, tenant_id, scopes_json, created_at, revoked_at
                FROM api_credentials;
            DROP TABLE api_credentials;
            ALTER TABLE api_credentials_v15 RENAME TO api_credentials;
            CREATE INDEX idx_api_credentials_tenant
                ON api_credentials(tenant_id, revoked_at);

            -- access_audit_events：去掉 subject_id
            CREATE TABLE access_audit_events_v15 (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                action TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK (outcome IN ('ALLOW', 'DENY')),
                tenant_id TEXT,
                resource_type TEXT,
                resource_id TEXT,
                reason TEXT NOT NULL
            );
            INSERT INTO access_audit_events_v15 (id, timestamp, action, outcome, tenant_id, resource_type, resource_id, reason)
                SELECT id, timestamp, action, outcome, tenant_id, resource_type, resource_id, reason
                FROM access_audit_events;
            DROP TABLE access_audit_events;
            ALTER TABLE access_audit_events_v15 RENAME TO access_audit_events;
            CREATE INDEX idx_access_audit_tenant_timestamp
                ON access_audit_events(tenant_id, timestamp);
        `,
    },
    {
        version: 16,
        name: "create_users_and_sessions",
        up: `
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE user_sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                token_digest TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                revoked_at TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE INDEX idx_user_sessions_token
                ON user_sessions(token_digest, revoked_at, expires_at);
        `,
    },
    {
        version: 17,
        name: "create_workspace_conversations",
        up: `
            -- Conversation 是用户可见的持续对话；HarnessSession 仍是 Runtime 绑定。
            -- 两者共享 ID，但 Conversation 可以在第一个 Run 之前创建。
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
            );
            CREATE INDEX idx_conversations_workspace_updated
                ON conversations(tenant_id, workspace_id, updated_at DESC);
        `,
    },
    {
        version: 18,
        name: "add_run_output_channels",
        up: `
            ALTER TABLE run_output_chunks ADD COLUMN channel TEXT NOT NULL DEFAULT 'answer'
                CHECK (channel IN ('answer', 'thinking'));
        `,
    },
    {
        version: 19,
        name: "add_run_thinking_level",
        up: `
            ALTER TABLE agent_runs ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off'
                CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium', 'high'));
        `,
    },
    {
        version: 20,
        name: "add_harness_instance_active_run_count",
        up: `
            ALTER TABLE harness_instances
                ADD COLUMN active_run_count INTEGER NOT NULL DEFAULT 0
                CHECK (active_run_count >= 0);
        `,
    },
];
