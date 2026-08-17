import type { Database } from "bun:sqlite";

import type { Checkpoint } from "./checkpoint.ts";

/**
 * CheckpointStore 只提供恢复点查询。
 *
 * Checkpoint 的写入必须和 ToolExecution 成功结果在同一个事务中完成，
 * 因此写方法放在 ToolExecutionStore.completeWithCheckpoint 中，避免调用方
 * 先写成功结果、随后才写 Checkpoint，制造无法安全恢复的中间状态。
 */
export class CheckpointStore {
    constructor(private readonly db: Database) {}

    get(checkpointId: string): Checkpoint | null {
        return this.db
            .query<Checkpoint, { checkpointId: string }>(`
                SELECT
                    id,
                    run_id AS runId,
                    tool_execution_id AS toolExecutionId,
                    runtime_session_ref AS runtimeSessionRef,
                    last_event_sequence AS lastEventSequence,
                    created_at AS createdAt
                FROM checkpoints
                WHERE id = $checkpointId;
            `)
            .get({ checkpointId });
    }

    /**
     * 读取一个 Run 最新的恢复点。
     *
     * created_at 理论上可能相同，所以再用 rowid 做稳定的倒序兜底。
     */
    getLatestForRun(runId: string): Checkpoint | null {
        return this.db
            .query<Checkpoint, { runId: string }>(`
                SELECT
                    id,
                    run_id AS runId,
                    tool_execution_id AS toolExecutionId,
                    runtime_session_ref AS runtimeSessionRef,
                    last_event_sequence AS lastEventSequence,
                    created_at AS createdAt
                FROM checkpoints
                WHERE run_id = $runId
                ORDER BY created_at DESC, rowid DESC
                LIMIT 1;
            `)
            .get({ runId });
    }
}
