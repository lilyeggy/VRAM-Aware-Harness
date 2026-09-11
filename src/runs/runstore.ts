/**
 * RunStore 负责 AgentRun 和 RunEvent 的持久化。
 *
 * agent_runs 保存 Run 的当前快照，run_events 保存 Run 的历史事实。
 * 当 Run 状态变化时，这两部分必须在同一个 SQLite 事务里写入，
 * 避免“当前状态已经改变，但历史事件没有记录”的不一致。
 */

import type { Database } from "bun:sqlite";

import type {
    AgentRun,
    AgentRunStatus,
    RunEvent,
    RunEventType,
} from "./agent-run.ts";
import { assertValidTransition } from "./run-state-machine.ts";

/**
 * run_events 表里的 payload 使用 JSON 字符串保存。
 * 因此事件不能像 AgentRun 一样只靠 SQL 别名直接返回，
 * 读取后还需要把 payload_json 解析成 RunEvent.payload。
 */
interface RunEventRow {
    event_id: string;
    run_id: string;
    sequence: number;
    type: RunEventType;
    timestamp: string;
    payload_version: number;
    payload_json: string;
    dedupe_key: string | null;
}

interface LastEventSequenceRow {
    sequence: number;
}

interface AgentRunRow {
    id: string;
    tenantId: string;
    harnessSessionId: string;
    status: AgentRunStatus;
    userInput: string;
    workspacePath: string;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    checkpointId: string | null;
    failureReason: string | null;
    templateVersionId: string | null;
    harnessInstanceId: string | null;
    runPolicyJson: string | null;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
}

export type DeduplicatedRunEvent = RunEvent & {
    dedupeKey: string;
};

export class RunStore {
    constructor(private readonly db: Database) {}

    /**
     * 创建一个新的 Run，并写入它的第一条事件。
     *
     * 两次 INSERT 放在同一个事务里：
     * - 如果 Run 写入失败，不会出现孤立事件；
     * - 如果事件写入失败，刚插入的 Run 也会回滚。
     */
    create(run: AgentRun, initialEvent: RunEvent): void {
        this.assertEventBelongsToRun(run.id, initialEvent);

        if (initialEvent.sequence !== 1) {
            throw new Error("AgentRun 的第一条事件 sequence 必须是 1");
        }

        const parameters = {
            id: run.id,
            tenantId: run.tenantId,
            harnessSessionId: run.harnessSessionId,
            status: run.status,
            userInput: run.userInput,
            workspacePath: run.workspacePath,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            checkpointId: run.checkpointId,
            failureReason: run.failureReason,
            templateVersionId: run.templateVersionId ?? null,
            harnessInstanceId: run.harnessInstanceId ?? null,
            runPolicyJson: run.runPolicy === undefined
                ? null
                : JSON.stringify(run.runPolicy),
            thinkingLevel: run.thinkingLevel ?? "off",
        };

        const createRunAndInitialEvent = this.db.transaction(() => {
            this.db
                .query<unknown, typeof parameters>(`
                    INSERT INTO agent_runs (
                        id,
                        tenant_id,
                        harness_session_id,
                        status,
                        user_input,
                        workspace_path,
                        created_at,
                        updated_at,
                        started_at,
                        finished_at,
                        checkpoint_id,
                        failure_reason,
                        template_version_id,
                        harness_instance_id,
                        run_policy_json,
                        thinking_level
                    )
                    VALUES (
                        $id,
                        $tenantId,
                        $harnessSessionId,
                        $status,
                        $userInput,
                        $workspacePath,
                        $createdAt,
                        $updatedAt,
                        $startedAt,
                        $finishedAt,
                        $checkpointId,
                        $failureReason,
                        $templateVersionId,
                        $harnessInstanceId,
                        $runPolicyJson,
                        $thinkingLevel
                    );
                `)
                .run(parameters);

            this.insertEvent(initialEvent);
        });

        createRunAndInitialEvent();
    }

    /**
     * 按 runId 读取一个 AgentRun。
     *
     * 数据库列使用 snake_case，而 AgentRun 使用 camelCase。
     * 在 SELECT 中使用 AS 做字段别名后，查询结果可以直接符合
     * AgentRun 的结构，因此不需要再维护一份重复的 AgentRunRow。
     */
    get(runId: string): AgentRun | null {
        const row = this.db
            .query<AgentRunRow, { runId: string }>(`
                SELECT
                    id,
                    tenant_id AS tenantId,
                    harness_session_id AS harnessSessionId,
                    status,
                    user_input AS userInput,
                    workspace_path AS workspacePath,
                    created_at AS createdAt,
                    updated_at AS updatedAt,
                    started_at AS startedAt,
                    finished_at AS finishedAt,
                    checkpoint_id AS checkpointId,
                    failure_reason AS failureReason,
                    template_version_id AS templateVersionId,
                    harness_instance_id AS harnessInstanceId,
                    run_policy_json AS runPolicyJson,
                    thinking_level AS thinkingLevel
                FROM agent_runs
                WHERE id = $runId;
            `)
            .get({ runId });
        return row === null ? null : this.runFromRow(row);
    }

    /** Product-facing history read; callers must supply the authenticated Tenant. */
    listForTenant(tenantId: string, limit = 50): AgentRun[] {
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
            throw new Error("Run 列表 limit 必须在 1 到 200 之间");
        }
        return this.db.query<AgentRunRow, { tenantId: string; limit: number }>(`
            SELECT
                id, tenant_id AS tenantId, harness_session_id AS harnessSessionId,
                status, user_input AS userInput, workspace_path AS workspacePath,
                created_at AS createdAt, updated_at AS updatedAt, started_at AS startedAt,
                finished_at AS finishedAt, checkpoint_id AS checkpointId,
                failure_reason AS failureReason, template_version_id AS templateVersionId,
                harness_instance_id AS harnessInstanceId, run_policy_json AS runPolicyJson,
                thinking_level AS thinkingLevel
            FROM agent_runs
            WHERE tenant_id = $tenantId
            ORDER BY created_at DESC, rowid DESC
            LIMIT $limit;
        `).all({ tenantId, limit }).map((row) => this.runFromRow(row));
    }

    /** Conversation history in message order. */
    listForSession(tenantId: string, harnessSessionId: string): AgentRun[] {
        return this.db.query<AgentRunRow, { tenantId: string; harnessSessionId: string }>(`
            SELECT
                id, tenant_id AS tenantId, harness_session_id AS harnessSessionId,
                status, user_input AS userInput, workspace_path AS workspacePath,
                created_at AS createdAt, updated_at AS updatedAt, started_at AS startedAt,
                finished_at AS finishedAt, checkpoint_id AS checkpointId,
                failure_reason AS failureReason, template_version_id AS templateVersionId,
                harness_instance_id AS harnessInstanceId, run_policy_json AS runPolicyJson,
                thinking_level AS thinkingLevel
            FROM agent_runs
            WHERE tenant_id = $tenantId AND harness_session_id = $harnessSessionId
            ORDER BY created_at ASC, rowid ASC;
        `).all({ tenantId, harnessSessionId }).map((row) => this.runFromRow(row));
    }

    /**
     * B6：返回该 harness 会话已被哪个租户使用过（以最早一条 Run 为准）。
     * null 表示会话尚未被任何租户使用——首次使用即认领。
     * 会话归属以服务端持久化事实为准，客户端自选的 sessionId 不能抢注。
     */
    findSessionOwner(harnessSessionId: string): string | null {
        const row = this.db
            .query<Pick<AgentRunRow, "tenantId">, { harnessSessionId: string }>(`
                SELECT tenant_id AS tenantId
                FROM agent_runs
                WHERE harness_session_id = $harnessSessionId
                ORDER BY created_at ASC, rowid ASC
                LIMIT 1;
            `)
            .get({ harnessSessionId });

        return row?.tenantId ?? null;
    }

    /**
     * 服务启动时查找旧进程遗留的活跃 Run。
     *
     * 新进程中不存在这些 Run 对应的 Runtime/Session 实例，因此数据库中的
     * RUNNING / WAITING_TOOL 只是过期快照，必须先转成 INTERRUPTED 再决定恢复。
     */
    listActiveRuns(): AgentRun[] {
        return this.db
            .query<AgentRunRow, []>(`
                SELECT
                    id,
                    tenant_id AS tenantId,
                    harness_session_id AS harnessSessionId,
                    status,
                    user_input AS userInput,
                    workspace_path AS workspacePath,
                    created_at AS createdAt,
                    updated_at AS updatedAt,
                    started_at AS startedAt,
                    finished_at AS finishedAt,
                    checkpoint_id AS checkpointId,
                    failure_reason AS failureReason,
                    template_version_id AS templateVersionId,
                    harness_instance_id AS harnessInstanceId,
                    run_policy_json AS runPolicyJson,
                    thinking_level AS thinkingLevel
                FROM agent_runs
                WHERE status IN ('RUNNING', 'WAITING_TOOL')
                ORDER BY created_at ASC, rowid ASC;
            `)
            .all()
            .map((row) => this.runFromRow(row));
    }

    /**
     * 进程重启后重建内存调度队列。
     * SQLite 保存 QUEUED 事实，Scheduler 只保存当前进程的公平轮转状态。
     */
    listQueuedRuns(): AgentRun[] {
        return this.db
            .query<AgentRunRow, []>(`
                SELECT
                    id,
                    tenant_id AS tenantId,
                    harness_session_id AS harnessSessionId,
                    status,
                    user_input AS userInput,
                    workspace_path AS workspacePath,
                    created_at AS createdAt,
                    updated_at AS updatedAt,
                    started_at AS startedAt,
                    finished_at AS finishedAt,
                    checkpoint_id AS checkpointId,
                    failure_reason AS failureReason,
                    template_version_id AS templateVersionId,
                    harness_instance_id AS harnessInstanceId,
                    run_policy_json AS runPolicyJson,
                    thinking_level AS thinkingLevel
                FROM agent_runs
                WHERE status = 'QUEUED'
                ORDER BY created_at ASC, rowid ASC;
            `)
            .all()
            .map((row) => this.runFromRow(row));
    }

    /**
     * 保存 Run 的新快照，并追加导致这次变化的事件。
     *
     * 状态机负责判断 from -> to 是否是合法转换。
     * SQLite 事务负责保证 UPDATE 和 INSERT 不会只成功其中一个。
     */
    update(run: AgentRun, event: RunEvent): void {
        this.assertEventBelongsToRun(run.id, event);

        const updateRunAndAppendEvent = this.db.transaction(() => {
            const currentRun = this.get(run.id);

            if (currentRun === null) {
                throw new Error(`找不到 AgentRun：${run.id}`);
            }

            assertValidTransition(currentRun.status, run.status);

            const parameters = {
                id: run.id,
                tenantId: run.tenantId,
                harnessSessionId: run.harnessSessionId,
                status: run.status,
                userInput: run.userInput,
                workspacePath: run.workspacePath,
                createdAt: run.createdAt,
                updatedAt: run.updatedAt,
                startedAt: run.startedAt,
                finishedAt: run.finishedAt,
                checkpointId: run.checkpointId,
                failureReason: run.failureReason,
                templateVersionId: run.templateVersionId ?? null,
                harnessInstanceId: run.harnessInstanceId ?? null,
                runPolicyJson: run.runPolicy === undefined
                    ? null
                    : JSON.stringify(run.runPolicy),
                thinkingLevel: run.thinkingLevel ?? "off",
                previousStatus: currentRun.status,
            };

            // 同时检查旧状态，避免用过期快照覆盖已经发生的状态变化。
            const result = this.db
                .query<unknown, typeof parameters>(`
                    UPDATE agent_runs
                    SET
                        tenant_id = $tenantId,
                        harness_session_id = $harnessSessionId,
                        status = $status,
                        user_input = $userInput,
                        workspace_path = $workspacePath,
                        created_at = $createdAt,
                        updated_at = $updatedAt,
                        started_at = $startedAt,
                        finished_at = $finishedAt,
                        checkpoint_id = $checkpointId,
                        failure_reason = $failureReason,
                        template_version_id = $templateVersionId,
                        harness_instance_id = $harnessInstanceId,
                        run_policy_json = $runPolicyJson,
                        thinking_level = $thinkingLevel
                    WHERE id = $id
                      AND status = $previousStatus;
                `)
                .run(parameters);

            if (result.changes !== 1) {
                throw new Error(`AgentRun 状态已被其他写入修改：${run.id}`);
            }

            this.insertEvent(event);
        });

        updateRunAndAppendEvent();
    }

    private runFromRow(row: AgentRunRow): AgentRun {
        const run: AgentRun = {
            id: row.id,
            tenantId: row.tenantId,
            harnessSessionId: row.harnessSessionId,
            status: row.status,
            userInput: row.userInput,
            workspacePath: row.workspacePath,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            checkpointId: row.checkpointId,
            failureReason: row.failureReason,
            thinkingLevel: row.thinkingLevel,
        };
        if (row.templateVersionId !== null) {
            run.templateVersionId = row.templateVersionId;
        }
        if (row.harnessInstanceId !== null) {
            run.harnessInstanceId = row.harnessInstanceId;
        }
        if (row.runPolicyJson !== null) {
            run.runPolicy = JSON.parse(row.runPolicyJson) as AgentRun["runPolicy"];
        }
        return run;
    }

    /**
     * 追加一条不需要改变 Run 快照的事件。
     *
     * 例如 MODEL_STARTED、MODEL_COMPLETED 或 TOOL_COMPLETED。
     * run_events 是 append-only log，因此这里不提供修改或删除事件的方法。
     */
    appendEvent(event: RunEvent): void {
        this.insertEvent(event);
    }

    /**
     * 幂等地追加一个拥有稳定 dedupeKey 的事件。
     *
     * 返回 true 表示本次确实插入了新事实；
     * 返回 false 表示相同 Runtime 事实已经存在，可以安全忽略。
     *
     * 这里只吞掉 dedupe key 冲突。重复 sequence、eventId 或其他数据库错误
     * 仍然继续抛出，避免把真正的数据问题误判成正常重复投递。
     */
    appendEventIfNew(event: DeduplicatedRunEvent): boolean {
        try {
            this.insertEvent(event);
            return true;
        } catch (error) {
            const existingEvent = this.db
                .query<
                    { eventId: string },
                    { runId: string; dedupeKey: string }
                >(`
                    SELECT event_id AS eventId
                    FROM run_events
                    WHERE run_id = $runId
                      AND dedupe_key = $dedupeKey;
                `)
                .get({
                    runId: event.runId,
                    dedupeKey: event.dedupeKey,
                });

            if (existingEvent !== null) {
                return false;
            }

            throw error;
        }
    }

    /**
     * 按 sequence 从小到大读取一个 Run 的全部历史事件。
     *
     * 多个事件可能拥有相同时间戳，因此 timestamp 不能作为稳定顺序；
     * sequence 才是同一个 Run 内明确且稳定的排序依据。
     */
    listEvents(runId: string): RunEvent[] {
        const rows = this.db
            .query<RunEventRow, { runId: string }>(`
                SELECT
                    event_id,
                    run_id,
                    sequence,
                    type,
                    timestamp,
                    payload_version,
                    payload_json,
                    dedupe_key
                FROM run_events
                WHERE run_id = $runId
                ORDER BY sequence ASC;
            `)
            .all({ runId });

        return rows.map((row) => {
            const event: RunEvent = {
                eventId: row.event_id,
                runId: row.run_id,
                sequence: row.sequence,
                type: row.type,
                timestamp: row.timestamp,
                payloadVersion: row.payload_version,
                payload: JSON.parse(row.payload_json) as unknown,
            };

            if (row.dedupe_key !== null) {
                event.dedupeKey = row.dedupe_key;
            }

            return event;
        });
    }

    /**
     * 返回一个 Run 当前已经持久化的最后事件序号。
     *
     * ToolGateway 创建 Checkpoint 时只需要知道事件位置，不应该自己理解
     * run_events 的 SQL 结构。不存在事件时返回 0；正常 AgentRun 创建后
     * 至少已经拥有 sequence 1。
     */
    getLastEventSequence(runId: string): number {
        const row = this.db
            .query<LastEventSequenceRow, { runId: string }>(`
                SELECT COALESCE(MAX(sequence), 0) AS sequence
                FROM run_events
                WHERE run_id = $runId;
            `)
            .get({ runId });

        return row?.sequence ?? 0;
    }

    /**
     * 把领域事件写入 run_events 表。
     *
     * UNIQUE(run_id, sequence) 会拒绝同一个 Run 的重复序号；
     * FOREIGN KEY(run_id) 会拒绝指向不存在 Run 的事件。
     */
    private insertEvent(event: RunEvent): void {
        const parameters = {
            eventId: event.eventId,
            runId: event.runId,
            sequence: event.sequence,
            type: event.type,
            timestamp: event.timestamp,
            payloadVersion: event.payloadVersion,
            // undefined 不是合法 JSON 值，这里统一按 null 保存。
            payloadJson: JSON.stringify(event.payload ?? null),
            dedupeKey: event.dedupeKey ?? null,
        };

        this.db
            .query<unknown, typeof parameters>(`
                INSERT INTO run_events (
                    event_id,
                    run_id,
                    sequence,
                    type,
                    timestamp,
                    payload_version,
                    payload_json,
                    dedupe_key
                )
                VALUES (
                    $eventId,
                    $runId,
                    $sequence,
                    $type,
                    $timestamp,
                    $payloadVersion,
                    $payloadJson,
                    $dedupeKey
                );
            `)
            .run(parameters);
    }

    /**
     * 在执行 SQL 前先给出明确的领域错误，
     * 避免只看到较难理解的 SQLite 外键错误。
     */
    private assertEventBelongsToRun(runId: string, event: RunEvent): void {
        if (event.runId !== runId) {
            throw new Error(
                `RunEvent ${event.eventId} 不属于 AgentRun ${runId}`,
            );
        }
    }
}
