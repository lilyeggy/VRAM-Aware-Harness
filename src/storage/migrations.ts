import { readFileSync } from "node:fs";

export interface SchemaMigration {
    readonly version: number;
    readonly name: string;
    readonly up: string;
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
 * - agent_runs.priority：提交时可选的调度优先级（越大越先调度）。
 * - run_attempts 的 lease_owner / lease_expires_at / heartbeat_at：
 *   Worker/执行器的租约与心跳事实，供崩溃后回收过期 Attempt。
 */
const queueLeaseFields = `
ALTER TABLE agent_runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

ALTER TABLE run_attempts ADD COLUMN lease_owner TEXT;
ALTER TABLE run_attempts ADD COLUMN lease_expires_at TEXT;
ALTER TABLE run_attempts ADD COLUMN heartbeat_at TEXT;
`;

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
];
