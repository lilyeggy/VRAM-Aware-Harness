import { readFileSync } from "node:fs";

import type { Database } from "bun:sqlite";

export interface SchemaMigration {
    readonly version: number;
    readonly name: string;
    /** 多数迁移是一段 DDL 字符串；需要按列存在性判断的迁移写成函数。 */
    readonly up: string | ((db: Database) => void);
}

const initialSchema = readFileSync(
    new URL("./schema.sql", import.meta.url),
    "utf8",
);

/**
 * 精简后的数据库保留一版初始 schema，以及 §9.7 v1.3 第 4 项新增的
 * 不可变审计链 migration。旧项目的 22 个增量 migration 已在简历项目
 * 阶段压平。
 */
const immutableAuditChain = `
ALTER TABLE access_audit_events ADD COLUMN prev_hash TEXT;
ALTER TABLE access_audit_events ADD COLUMN hash TEXT;

CREATE TRIGGER access_audit_events_no_update
BEFORE UPDATE ON access_audit_events
BEGIN
    SELECT RAISE(ABORT, 'access_audit_events 是只追加审计存储，禁止 UPDATE');
END;

CREATE TRIGGER access_audit_events_no_delete
BEFORE DELETE ON access_audit_events
BEGIN
    SELECT RAISE(ABORT, 'access_audit_events 是只追加审计存储，禁止 DELETE');
END;
`;

/**
 * v2：把访问审计表升级为“只追加 + hash 链”的不可变审计存储（§9.7 v1.3 第 4 项）。
 *
 * - prev_hash/hash 由 AccessAuditStore 在写入时计算，旧库中已存在的历史行
 *   hash 为 NULL，verifyChain() 会把它们当作 pre-chain legacy 行跳过。
 * - 触发器拒绝任何 UPDATE/DELETE，保证正常路径无法改写或删除审计事实；
 *   即使攻击者绕过触发器直接改库，hash 链校验也能发现篡改。
 */
/**
 * v3：§9.8 v1.4 Phase 2（队列/Worker）所需的最小持久化字段。
 *
 * - agent_runs.priority 已于 v1.6（2026-10-21）随「等权」定位移除；
 *   旧库仍保留该列，但代码不再读写。
 * - run_attempts 的 lease_owner / lease_expires_at / heartbeat_at：
 *   Worker/执行器的租约与心跳事实，供崩溃后回收过期 Attempt。
 */
const queueLeaseFields = `
ALTER TABLE run_attempts ADD COLUMN lease_owner TEXT;
ALTER TABLE run_attempts ADD COLUMN lease_expires_at TEXT;
ALTER TABLE run_attempts ADD COLUMN heartbeat_at TEXT;
`;

/**
 * v4：§9.8 v1.4 Phase 3（Durable Execution / Retry / 幂等）。
 *
 * - agent_runs.idempotency_key：提交方可选的幂等键；同一用户内唯一，
 *   重复提交返回既有 Run，避免弱网重试造成重复执行/重复计费。
 * - agent_runs.retry_count / retry_at：可重试失败的次数与下次重试时间；
 *   只有副作用安全的失败才会回到 QUEUED 等待重试。
 */
const runIdempotencyAndRetry = `
ALTER TABLE agent_runs ADD COLUMN idempotency_key TEXT;
ALTER TABLE agent_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN retry_at TEXT;

CREATE UNIQUE INDEX agent_runs_user_idempotency_key
    ON agent_runs(user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
`;

/**
 * v5：把隔离域列统一改名为 user_id。
 *
 * 背景：隔离边界从来不是独立实体，没有组织表，旧 tenantId 恒等于 users.id。
 * v1.7 起统一叫 user：新库由 schema.sql 直接建出 user_id，本迁移按 pragma 判断后跳过；
 * 旧库原地改名，SQLite 的 RENAME COLUMN 会同步更新索引与触发器里的列引用。
 */
const USER_SCOPE_TABLES = [
    "agent_runs",
    "workspaces",
    "harness_sessions",
    "api_credentials",
    "access_audit_events",
    "effective_policy_snapshots",
] as const;

const LEGACY_SCOPE_COLUMN = "tenant_id";

function renameScopeColumnToUserId(db: Database): void {
    for (const table of USER_SCOPE_TABLES) {
        const columns = db
            .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
            .all(table);
        if (columns.some((column) => column.name === LEGACY_SCOPE_COLUMN)) {
            db.exec("ALTER TABLE " + table + " RENAME COLUMN " + LEGACY_SCOPE_COLUMN + " TO user_id;");
        }
    }
}

function addRunWorkspaceIdentity(db: Database): void {
    const columns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('agent_runs')").all();
    if (!columns.some((column) => column.name === "workspace_id")) {
        db.exec("ALTER TABLE agent_runs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)");
    }
    db.exec(`UPDATE agent_runs AS r SET workspace_id = (
        SELECT w.id FROM workspaces AS w
        WHERE w.user_id = r.user_id AND w.root_path = r.workspace_path LIMIT 1
    ) WHERE r.workspace_id IS NULL AND (
        SELECT COUNT(*) FROM workspaces AS w
        WHERE w.user_id = r.user_id AND w.root_path = r.workspace_path
    ) = 1`);
    // A queued legacy Run could predate creation of its Session. Recreate it only
    // when every historical Run agrees on one user and one managed Workspace.
    db.exec(`INSERT INTO harness_sessions
        (id, user_id, workspace_id, title, runtime_session_ref, created_at, updated_at)
        SELECT r.harness_session_id, MIN(r.user_id), MIN(r.workspace_id), NULL, NULL,
               MIN(r.created_at), MAX(r.updated_at)
        FROM agent_runs AS r
        WHERE NOT EXISTS (SELECT 1 FROM harness_sessions AS s WHERE s.id = r.harness_session_id)
        GROUP BY r.harness_session_id
        HAVING COUNT(DISTINCT r.user_id) = 1 AND COUNT(DISTINCT r.workspace_id) = 1
           AND COUNT(r.workspace_id) = COUNT(*)`);
    db.exec(`UPDATE harness_sessions AS s SET workspace_id = (
        SELECT MIN(r.workspace_id) FROM agent_runs AS r WHERE r.harness_session_id = s.id
    ) WHERE s.workspace_id IS NULL
      AND EXISTS (SELECT 1 FROM agent_runs AS r WHERE r.harness_session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM agent_runs AS r WHERE r.harness_session_id = s.id
        AND (r.user_id <> s.user_id OR r.workspace_id IS NULL))
      AND (SELECT COUNT(DISTINCT r.workspace_id) FROM agent_runs AS r
           WHERE r.harness_session_id = s.id) = 1`);
}


export const migrations: readonly SchemaMigration[] = [
    {
        version: 1,
        name: "initial_schema",
        up: initialSchema,
    },
    {
        version: 2,
        name: "immutable_audit_chain",
        up: immutableAuditChain,
    },
    {
        version: 3,
        name: "queue_priority_and_run_lease",
        up: queueLeaseFields,
    },
    {
        version: 4,
        name: "run_idempotency_and_retry",
        up: runIdempotencyAndRetry,
    },
    {
        version: 5,
        name: "scope_column_user_id",
        up: renameScopeColumnToUserId,
    },
    {
        version: 6,
        name: "run_workspace_identity",
        up: addRunWorkspaceIdentity,
    },
];
