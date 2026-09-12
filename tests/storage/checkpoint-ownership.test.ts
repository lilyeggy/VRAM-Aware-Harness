import { expect, test } from "bun:test";

import { openHarnessDatabase } from "../../src/storage/database.ts";

/**
 * D8（改判记录）：审计原判"Checkpoint 归属校验只在应用层，数据库无 FK 兜底"
 * 系误判——schema 中 checkpoints 已有 run_id → agent_runs 与
 * (tool_execution_id, run_id) → tool_executions 两组复合外键，
 * 且 openHarnessDatabase 连接默认 PRAGMA foreign_keys = ON。
 * 本测试把该行为钉住：绕过应用直写数据库也无法制造归属错乱的 Checkpoint。
 */
test("checkpoint 归属在数据库层被 FK 兜底：孤儿 run 与跨 run 的工具执行都被拒绝", () => {
    const db = openHarnessDatabase(":memory:");

    try {
        db.query(`
            INSERT INTO agent_runs (
                id, tenant_id, harness_session_id, status, user_input,
                workspace_path, created_at, updated_at,
                started_at, finished_at, checkpoint_id, failure_reason
            ) VALUES (
                'run-1', 'tenant-a', 'session-a', 'RUNNING', '合法 Run',
                '/tmp/ws', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
                NULL, NULL, NULL, NULL
            );
        `).run();
        db.query(`
            INSERT INTO tool_executions (
                id, run_id, tool_call_id, tool_name, arguments_json,
                effect, status, result_json, error_message,
                created_at, finished_at
            ) VALUES (
                'pe-1', 'run-1', 'tc-1', 'read', '{}',
                'READ_ONLY', 'PREPARED', NULL, NULL,
                '2026-01-01T00:00:00Z', NULL
            );
        `).run();

        // 1) checkpoint 指向不存在的 run → 拒绝。
        expect(() =>
            db.query(`
                INSERT INTO checkpoints (
                    id, run_id, tool_execution_id, runtime_session_ref,
                    last_event_sequence, created_at
                ) VALUES (
                    'cp-orphan', 'run-ghost', 'pe-1', '/tmp/s', 1,
                    '2026-01-01T00:00:00Z'
                );
            `).run(),
        ).toThrow();

        // 2) tool_execution 属于另一个 run → 复合 FK 拒绝。
        db.query(`
            INSERT INTO agent_runs (
                id, tenant_id, harness_session_id, status, user_input,
                workspace_path, created_at, updated_at,
                started_at, finished_at, checkpoint_id, failure_reason
            ) VALUES (
                'run-other', 'tenant-a', 'session-a', 'RUNNING', '另一个 Run',
                '/tmp/ws', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
                NULL, NULL, NULL, NULL
            );
        `).run();
        db.query(`
            INSERT INTO tool_executions (
                id, run_id, tool_call_id, tool_name, arguments_json,
                effect, status, result_json, error_message,
                created_at, finished_at
            ) VALUES (
                'pe-2', 'run-other', 'tc-2', 'read', '{}',
                'READ_ONLY', 'PREPARED', NULL, NULL,
                '2026-01-01T00:00:00Z', NULL
            );
        `).run();
        expect(() =>
            db.query(`
                INSERT INTO checkpoints (
                    id, run_id, tool_execution_id, runtime_session_ref,
                    last_event_sequence, created_at
                ) VALUES (
                    'cp-mismatch', 'run-1', 'pe-2', '/tmp/s', 1,
                    '2026-01-01T00:00:00Z'
                );
            `).run(),
        ).toThrow();

        // 3) 合法归属 → 写入成功。
        expect(() =>
            db.query(`
                INSERT INTO checkpoints (
                    id, run_id, tool_execution_id, runtime_session_ref,
                    last_event_sequence, created_at
                ) VALUES (
                    'cp-ok', 'run-1', 'pe-1', '/tmp/s', 1,
                    '2026-01-01T00:00:00Z'
                );
            `).run(),
        ).not.toThrow();
    } finally {
        db.close();
    }
});
