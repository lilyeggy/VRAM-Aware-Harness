import type { Database } from "bun:sqlite";

import type { Checkpoint } from "../checkpoints/checkpoint.ts";
import type {
    ToolEffect,
    ToolExecution,
    ToolExecutionStatus,
} from "./tool-execution.ts";

interface ToolExecutionRow {
    id: string;
    run_id: string;
    tool_call_id: string;
    tool_name: string;
    arguments_json: string;
    effect: ToolEffect;
    status: ToolExecutionStatus;
    result_json: string | null;
    error_message: string | null;
    created_at: string;
    finished_at: string | null;
}

/**
 * ToolExecutionStore 是 ToolGateway 与 SQLite 之间的持久化边界。
 *
 * 它不执行真实工具，也不决定工具能否重放；这些属于 ToolGateway。
 * Store 只保证执行意图、结果和 Checkpoint 按正确事务边界保存。
 */
export class ToolExecutionStore {
    constructor(private readonly db: Database) {}

    /**
     * 在真实工具执行前保存 PREPARED。
     *
     * 如果这一步失败，ToolGateway 必须停止，不能继续调用真实工具；
     * 否则可能发生副作用，但数据库里完全没有该次调用的记录。
     */
    prepare(execution: ToolExecution): void {
        if (
            execution.status !== "PREPARED"
            || execution.result !== null
            || execution.errorMessage !== null
            || execution.finishedAt !== null
        ) {
            throw new Error(
                "prepare 需要没有结果和完成时间的 PREPARED ToolExecution",
            );
        }

        const parameters = {
            id: execution.id,
            runId: execution.runId,
            toolCallId: execution.toolCallId,
            toolName: execution.toolName,
            argumentsJson: JSON.stringify(
                execution.arguments ?? null,
            ),
            effect: execution.effect,
            status: execution.status,
            createdAt: execution.createdAt,
        };

        this.db
            .query<unknown, typeof parameters>(`
                INSERT INTO tool_executions (
                    id,
                    run_id,
                    tool_call_id,
                    tool_name,
                    arguments_json,
                    effect,
                    status,
                    result_json,
                    error_message,
                    created_at,
                    finished_at
                )
                VALUES (
                    $id,
                    $runId,
                    $toolCallId,
                    $toolName,
                    $argumentsJson,
                    $effect,
                    $status,
                    NULL,
                    NULL,
                    $createdAt,
                    NULL
                );
            `)
            .run(parameters);
    }

    getById(executionId: string): ToolExecution | null {
        const row = this.db
            .query<ToolExecutionRow, { executionId: string }>(`
                SELECT
                    id,
                    run_id,
                    tool_call_id,
                    tool_name,
                    arguments_json,
                    effect,
                    status,
                    result_json,
                    error_message,
                    created_at,
                    finished_at
                FROM tool_executions
                WHERE id = $executionId;
            `)
            .get({ executionId });

        return row === null ? null : this.fromRow(row);
    }

    /**
     * 通过 Runtime 提供的稳定 toolCallId 查找历史调用。
     * ToolGateway 会先调用它，决定复用结果、自动重放或停止恢复。
     */
    getByToolCall(
        runId: string,
        toolCallId: string,
    ): ToolExecution | null {
        const row = this.db
            .query<
                ToolExecutionRow,
                { runId: string; toolCallId: string }
            >(`
                SELECT
                    id,
                    run_id,
                    tool_call_id,
                    tool_name,
                    arguments_json,
                    effect,
                    status,
                    result_json,
                    error_message,
                    created_at,
                    finished_at
                FROM tool_executions
                WHERE run_id = $runId
                  AND tool_call_id = $toolCallId;
            `)
            .get({ runId, toolCallId });

        return row === null ? null : this.fromRow(row);
    }

    /**
     * 保存确定失败的工具结果。
     *
     * 只有 PREPARED 能进入 FAILED。WHERE status = 'PREPARED'
     * 同时提供并发保护，避免晚到的失败结果覆盖已经保存的成功结果。
     */
    fail(execution: ToolExecution): void {
        if (
            execution.status !== "FAILED"
            || execution.errorMessage === null
            || execution.finishedAt === null
        ) {
            throw new Error(
                "fail 需要完整的 FAILED ToolExecution",
            );
        }

        const parameters = {
            id: execution.id,
            runId: execution.runId,
            resultJson: execution.result === null
                ? null
                : JSON.stringify(execution.result),
            errorMessage: execution.errorMessage,
            finishedAt: execution.finishedAt,
        };

        const result = this.db
            .query<unknown, typeof parameters>(`
                UPDATE tool_executions
                SET
                    status = 'FAILED',
                    result_json = $resultJson,
                    error_message = $errorMessage,
                    finished_at = $finishedAt
                WHERE id = $id
                  AND run_id = $runId
                  AND status = 'PREPARED';
            `)
            .run(parameters);

        if (result.changes !== 1) {
            throw new Error(
                `ToolExecution 不存在或已完成：${execution.id}`,
            );
        }
    }

    /**
     * 原子地保存成功结果、Checkpoint，并更新 AgentRun 的最新 checkpointId。
     *
     * 三个写入必须一起成功或一起失败。否则可能出现：
     * - 工具显示 SUCCEEDED，但没有可用恢复点；
     * - Checkpoint 已存在，但 AgentRun 仍指向旧恢复点。
     */
    completeWithCheckpoint(
        execution: ToolExecution,
        checkpoint: Checkpoint,
    ): void {
        this.assertCompletionMatchesCheckpoint(
            execution,
            checkpoint,
        );

        const completeTransaction = this.db.transaction(() => {
            const executionParameters = {
                id: execution.id,
                runId: execution.runId,
                resultJson: JSON.stringify(
                    execution.result ?? null,
                ),
                finishedAt: execution.finishedAt,
            };

            const executionResult = this.db
                .query<unknown, typeof executionParameters>(`
                    UPDATE tool_executions
                    SET
                        status = 'SUCCEEDED',
                        result_json = $resultJson,
                        error_message = NULL,
                        finished_at = $finishedAt
                    WHERE id = $id
                      AND run_id = $runId
                      AND status = 'PREPARED';
                `)
                .run(executionParameters);

            if (executionResult.changes !== 1) {
                throw new Error(
                    `ToolExecution 不存在或已完成：${execution.id}`,
                );
            }

            const checkpointParameters = {
                id: checkpoint.id,
                runId: checkpoint.runId,
                toolExecutionId: checkpoint.toolExecutionId,
                runtimeSessionRef: checkpoint.runtimeSessionRef,
                lastEventSequence: checkpoint.lastEventSequence,
                createdAt: checkpoint.createdAt,
            };

            this.db
                .query<unknown, typeof checkpointParameters>(`
                    INSERT INTO checkpoints (
                        id,
                        run_id,
                        tool_execution_id,
                        runtime_session_ref,
                        last_event_sequence,
                        created_at
                    )
                    VALUES (
                        $id,
                        $runId,
                        $toolExecutionId,
                        $runtimeSessionRef,
                        $lastEventSequence,
                        $createdAt
                    );
                `)
                .run(checkpointParameters);

            const runResult = this.db
                .query<
                    unknown,
                    { runId: string; checkpointId: string }
                >(`
                    UPDATE agent_runs
                    SET checkpoint_id = $checkpointId
                    WHERE id = $runId;
                `)
                .run({
                    runId: execution.runId,
                    checkpointId: checkpoint.id,
                });

            if (runResult.changes !== 1) {
                throw new Error(
                    `找不到 AgentRun：${execution.runId}`,
                );
            }
        });

        completeTransaction();
    }

    /**
     * 启动恢复扫描时读取所有结果不确定的工具调用。
     */
    listPrepared(): ToolExecution[] {
        return this.db
            .query<ToolExecutionRow, []>(`
                SELECT
                    id,
                    run_id,
                    tool_call_id,
                    tool_name,
                    arguments_json,
                    effect,
                    status,
                    result_json,
                    error_message,
                    created_at,
                    finished_at
                FROM tool_executions
                WHERE status = 'PREPARED'
                ORDER BY created_at ASC, rowid ASC;
            `)
            .all()
            .map((row) => this.fromRow(row));
    }

    /**
     * 读取指定 Run 中结果仍不确定的工具调用。
     * RecoveryService 用它判断该 Run 是否包含不能自动重放的副作用。
     */
    listPreparedForRun(runId: string): ToolExecution[] {
        return this.db
            .query<ToolExecutionRow, { runId: string }>(`
                SELECT
                    id,
                    run_id,
                    tool_call_id,
                    tool_name,
                    arguments_json,
                    effect,
                    status,
                    result_json,
                    error_message,
                    created_at,
                    finished_at
                FROM tool_executions
                WHERE run_id = $runId
                  AND status = 'PREPARED'
                ORDER BY created_at ASC, rowid ASC;
            `)
            .all({ runId })
            .map((row) => this.fromRow(row));
    }

    private assertCompletionMatchesCheckpoint(
        execution: ToolExecution,
        checkpoint: Checkpoint,
    ): void {
        if (
            execution.status !== "SUCCEEDED"
            || execution.finishedAt === null
            || execution.errorMessage !== null
        ) {
            throw new Error(
                "completeWithCheckpoint 需要完整的 SUCCEEDED ToolExecution",
            );
        }

        if (
            checkpoint.runId !== execution.runId
            || checkpoint.toolExecutionId !== execution.id
        ) {
            throw new Error(
                "Checkpoint 必须属于同一个 Run 和 ToolExecution",
            );
        }
    }

    private fromRow(row: ToolExecutionRow): ToolExecution {
        return {
            id: row.id,
            runId: row.run_id,
            toolCallId: row.tool_call_id,
            toolName: row.tool_name,
            arguments: JSON.parse(row.arguments_json) as unknown,
            effect: row.effect,
            status: row.status,
            result: row.result_json === null
                ? null
                : JSON.parse(row.result_json) as unknown,
            errorMessage: row.error_message,
            createdAt: row.created_at,
            finishedAt: row.finished_at,
        };
    }
}
