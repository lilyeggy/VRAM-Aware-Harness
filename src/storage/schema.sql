CREATE TABLE "access_audit_events" (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                action TEXT NOT NULL,
                outcome TEXT NOT NULL CHECK (outcome IN ('ALLOW', 'DENY')),
                tenant_id TEXT,
                resource_type TEXT,
                resource_id TEXT,
                reason TEXT NOT NULL
            , attempted_key_digest TEXT);

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
                failure_reason TEXT,

                -- 兼容列：RunExecutor 不再使用，保留为空以兼容旧查询/旧数据形态。

                run_policy_json TEXT CHECK (
                    run_policy_json IS NULL OR json_valid(run_policy_json)
                ),
                thinking_level TEXT NOT NULL DEFAULT 'off'
                    CHECK (
                        thinking_level IN ('off', 'minimal', 'low', 'medium', 'high')
                    )
            );

CREATE TABLE "api_credentials" (
                id TEXT PRIMARY KEY,
                key_digest TEXT NOT NULL UNIQUE,
                tenant_id TEXT NOT NULL,
                scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
                created_at TEXT NOT NULL,
                revoked_at TEXT
            );

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

CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
            );

CREATE TABLE effective_policy_snapshots (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                layers_json TEXT NOT NULL CHECK (json_valid(layers_json)),
                effective_json TEXT NOT NULL CHECK (json_valid(effective_json)),
                created_at TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES agent_runs(id)
            );

CREATE TABLE harness_sessions (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                runtime_session_ref TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

CREATE TABLE "policy_decisions" (
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

CREATE TABLE run_artifacts (
                run_id TEXT NOT NULL,
                path TEXT NOT NULL,
                hash TEXT NOT NULL,
                size INTEGER NOT NULL CHECK (size >= 0),
                created_at TEXT NOT NULL,
                PRIMARY KEY (run_id, path),
                FOREIGN KEY (run_id) REFERENCES agent_runs(id)
            );

CREATE TABLE run_attempts (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
                kind TEXT NOT NULL CHECK (kind IN ('START', 'RESUME')),
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
                UNIQUE (run_id, attempt_number)
            );

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
                payload_json TEXT NOT NULL, dedupe_key TEXT,

                -- 开启 PRAGMA foreign_keys 后，这个约束会阻止孤儿事件。
                FOREIGN KEY (run_id)
                    REFERENCES agent_runs(id),

                -- 同一个 run 里不允许两个事件拥有相同 sequence。
                -- 这保证事件流顺序不会出现歧义。
                UNIQUE (run_id, sequence)
            );

CREATE TABLE run_output_chunks (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                sequence INTEGER NOT NULL CHECK (sequence > 0),
                delta TEXT NOT NULL,
                created_at TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'answer'
                CHECK (channel IN ('answer', 'thinking')),
                FOREIGN KEY (run_id) REFERENCES agent_runs(id),
                UNIQUE (run_id, sequence)
            );

CREATE TABLE run_workspace_diffs (
                run_id TEXT PRIMARY KEY,
                diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
                created_at TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES agent_runs(id)
            );

CREATE TABLE run_workspace_snapshots (
                run_id TEXT NOT NULL,
                phase TEXT NOT NULL CHECK (phase IN ('BEFORE', 'AFTER')),
                manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
                captured_at TEXT NOT NULL,
                PRIMARY KEY (run_id, phase),
                FOREIGN KEY (run_id) REFERENCES agent_runs(id)
            );

CREATE TABLE sandboxes (
                id TEXT PRIMARY KEY,
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
                failure_reason TEXT, profile TEXT NOT NULL DEFAULT 'development'
                CHECK (profile IN ('development', 'default', 'restricted-egress', 'strict')), runtime TEXT NOT NULL DEFAULT 'managed-local', spec_json TEXT NOT NULL DEFAULT '{}'
                CHECK (json_valid(spec_json)), runtime_evidence_json TEXT NOT NULL DEFAULT '{}'
                CHECK (json_valid(runtime_evidence_json)),
                FOREIGN KEY (run_id) REFERENCES agent_runs(id),
                FOREIGN KEY (policy_snapshot_id)
                    REFERENCES effective_policy_snapshots(id)
            );

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

CREATE TABLE user_sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                token_digest TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                revoked_at TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );

CREATE TABLE users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

CREATE TABLE workspaces (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                name TEXT NOT NULL,
                root_path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                UNIQUE (tenant_id, name)
            );;

CREATE INDEX idx_access_audit_tenant_timestamp
                ON access_audit_events(tenant_id, timestamp);

CREATE INDEX idx_agent_runs_session
                ON agent_runs(harness_session_id);

CREATE INDEX idx_agent_runs_tenant_status
                ON agent_runs(tenant_id, status);

CREATE INDEX idx_api_credentials_tenant
                ON api_credentials(tenant_id, revoked_at);

CREATE INDEX idx_checkpoints_run_created
                ON checkpoints(run_id, created_at);

CREATE INDEX idx_conversations_workspace_updated
                ON conversations(tenant_id, workspace_id, updated_at DESC);

CREATE INDEX idx_policy_snapshots_run
                ON effective_policy_snapshots(run_id, created_at);

CREATE INDEX idx_run_artifacts_run ON run_artifacts(run_id, path);

CREATE INDEX idx_run_attempts_run_number
                ON run_attempts(run_id, attempt_number);

CREATE UNIQUE INDEX idx_run_events_run_dedupe_key
                ON run_events(run_id, dedupe_key)
                WHERE dedupe_key IS NOT NULL;

CREATE INDEX idx_run_output_chunks_run_sequence
                ON run_output_chunks(run_id, sequence);

CREATE INDEX idx_sandboxes_run_status
                ON sandboxes(run_id, status);

CREATE INDEX idx_tool_executions_run_status
                ON tool_executions(run_id, status);

CREATE INDEX idx_user_sessions_token
                ON user_sessions(token_digest, revoked_at, expires_at);

CREATE INDEX idx_workspaces_tenant
                ON workspaces(tenant_id, created_at);
