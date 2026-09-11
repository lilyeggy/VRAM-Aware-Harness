/**
 * 方向 A：评测聚合器。
 *
 * 只「读」现有落库数据，算出 execution-metrics.ts 定义的三层指标。
 * 不新增采集、不改控制面；数据库写入仍由原有控制面负责。
 *
 * 数据来源映射：
 * - agent_runs          → 终态/租户/排队/耗时/checkpoint
 * - run_attempts        → 尝试次数
 * - tool_executions     → 工具副作用画像 + 被拦危险副作用
 * - run_events(MODEL_COMPLETED) → LLM token/cost 用量
 * - run_workspace_diffs / run_artifacts / run_output_chunks → 完成度
 * - policy_decisions    → 资源准入评测
 */

import type { Database } from "bun:sqlite";

import { canAutomaticallyReplay } from "../tools/tool-execution.ts";
import {
    LlmCacheMetricsStore,
    type LlmCacheMetricsAggregate,
} from "./llm-cache-metrics-store.ts";
import type {
    EvaluationSummary,
    ResourceEvaluation,
    RunMetrics,
} from "./execution-metrics.ts";

interface AgentRunRow {
    id: string;
    tenant_id: string;
    status: string;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    checkpoint_id: string | null;
}

interface CountRow {
    n: number;
}

interface ToolEffectRow {
    effect: "READ_ONLY" | "IDEMPOTENT_WRITE" | "UNKNOWN_EFFECT";
    status: "PREPARED" | "SUCCEEDED" | "FAILED";
}

interface ToolEffectRowWithRun extends ToolEffectRow {
    run_id: string;
}

interface PayloadRow {
    payload_json: string;
}

interface PolicyDecisionRow {
    action: string;
    reason_code: string;
    pressure: string;
}

/** ISO 时间差（毫秒）。任一端缺失返回 null。 */
function msBetween(
    startIso: string | null,
    endIso: string | null,
): number | null {
    if (startIso === null || endIso === null) {
        return null;
    }
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    if (Number.isNaN(start) || Number.isNaN(end)) {
        return null;
    }
    return Math.max(0, end - start);
}

/** 百分位（已过滤 null 的数值数组）。空数组返回 null。 */
function percentile(
    values: readonly number[],
    p: number,
): number | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
        sorted.length - 1,
        Math.ceil((p / 100) * sorted.length) - 1,
    );
    return sorted[Math.max(0, index)] ?? null;
}

function average(values: readonly number[]): number | null {
    if (values.length === 0) {
        return null;
    }
    const sum = values.reduce((acc, v) => acc + v, 0);
    return sum / values.length;
}

export class EvaluationAggregator {
    private readonly llmCacheMetricsStore: LlmCacheMetricsStore;

    constructor(private readonly db: Database) {
        // D1：缓存指标聚合的 SQL 唯一来源是 LlmCacheMetricsStore，
        // 聚合器只委托，避免两处逐字重复的 SQL 静默分叉。
        this.llmCacheMetricsStore = new LlmCacheMetricsStore(db);
    }

    /** 计算单个 Run 的指标；Run 不存在返回 null。 */
    computeRunMetrics(runId: string): RunMetrics | null {
        const run = this.db
            .query<AgentRunRow, { runId: string }>(
                `SELECT id, tenant_id, status, created_at, started_at,
                        finished_at, checkpoint_id
                 FROM agent_runs WHERE id = $runId`,
            )
            .get({ runId });
        if (run === null) {
            return null;
        }

        const attemptCount =
            this.db
                .query<CountRow, { runId: string }>(
                    `SELECT COUNT(*) AS n FROM run_attempts
                     WHERE run_id = $runId`,
                )
                .get({ runId })?.n ?? 0;

        const toolRows = this.db
            .query<ToolEffectRow, { runId: string }>(
                `SELECT effect, status FROM tool_executions
                 WHERE run_id = $runId`,
            )
            .all({ runId });

        const toolCallsByEffect = {
            readOnly: 0,
            idempotentWrite: 0,
            unknownEffect: 0,
        };
        let blockedDangerousToolCount = 0;
        for (const row of toolRows) {
            if (row.effect === "READ_ONLY") {
                toolCallsByEffect.readOnly += 1;
            } else if (row.effect === "IDEMPOTENT_WRITE") {
                toolCallsByEffect.idempotentWrite += 1;
            } else {
                toolCallsByEffect.unknownEffect += 1;
            }
            // 仍处于 PREPARED 且不可自动重放 = 被拦下的危险副作用。
            if (
                row.status === "PREPARED"
                && !canAutomaticallyReplay(row.status, row.effect)
            ) {
                blockedDangerousToolCount += 1;
            }
        }

        const usageEvents = this.db
            .query<PayloadRow, { runId: string }>(
                `SELECT payload_json FROM run_events
                 WHERE run_id = $runId AND type = 'MODEL_COMPLETED'`,
            )
            .all({ runId });

        return this.toRunMetrics(run, {
            attemptCount,
            toolRows,
            usagePayloads: usageEvents,
            producedDiff: this.exists(
                `SELECT 1 FROM run_workspace_diffs WHERE run_id = $runId`,
                runId,
            ),
            producedArtifact: this.exists(
                `SELECT 1 FROM run_artifacts WHERE run_id = $runId LIMIT 1`,
                runId,
            ),
            hasFinalText: this.exists(
                `SELECT 1 FROM run_output_chunks WHERE run_id = $runId LIMIT 1`,
                runId,
            ),
        });
    }

    /**
     * D2：单 Run 指标装配（纯装配，不含查询）。
     * 点查（computeRunMetrics）与批量对账（listRunMetrics）共用同一装配，
     * 保证两条路径的口径永远一致。
     */
    private toRunMetrics(
        run: AgentRunRow,
        facts: {
            attemptCount: number;
            toolRows: readonly ToolEffectRow[];
            usagePayloads: readonly PayloadRow[];
            producedDiff: boolean;
            producedArtifact: boolean;
            hasFinalText: boolean;
        },
    ): RunMetrics {
        const toolCallsByEffect = {
            readOnly: 0,
            idempotentWrite: 0,
            unknownEffect: 0,
        };
        let blockedDangerousToolCount = 0;
        for (const row of facts.toolRows) {
            if (row.effect === "READ_ONLY") {
                toolCallsByEffect.readOnly += 1;
            } else if (row.effect === "IDEMPOTENT_WRITE") {
                toolCallsByEffect.idempotentWrite += 1;
            } else {
                toolCallsByEffect.unknownEffect += 1;
            }
            // 仍处于 PREPARED 且不可自动重放 = 被拦下的危险副作用。
            if (
                row.status === "PREPARED"
                && !canAutomaticallyReplay(row.status, row.effect)
            ) {
                blockedDangerousToolCount += 1;
            }
        }

        const llmUsage = aggregateLlmUsage([...facts.usagePayloads]);

        return {
            runId: run.id,
            tenantId: run.tenant_id,
            finalStatus: run.status,
            attemptCount: facts.attemptCount,
            queueWaitMs: msBetween(run.created_at, run.started_at),
            runDurationMs: msBetween(run.started_at, run.finished_at),
            toolCallCount: facts.toolRows.length,
            toolCallsByEffect,
            blockedDangerousToolCount,
            hasCheckpoint: run.checkpoint_id !== null,
            producedDiff: facts.producedDiff,
            producedArtifact: facts.producedArtifact,
            hasFinalText: facts.hasFinalText,
            llmUsage,
        };
    }

    /**
     * 计算一组 Run（可选按租户过滤）的指标。
     *
     * D2：原先对每个 Run 逐一点查 6 张表（N+1）。现在每张表只做一次
     * 批量读取（GROUP BY / DISTINCT / 全量集合），再装配回每个 Run——
     * 数据规模增大时查询数是 O(表数) 而不是 O(Run 数)。
     */
    listRunMetrics(tenantId?: string): RunMetrics[] {
        const runs = tenantId === undefined
            ? this.db
                .query<AgentRunRow, Record<string, never>>(
                    `SELECT id, tenant_id, status, created_at, started_at,
                            finished_at, checkpoint_id
                     FROM agent_runs ORDER BY created_at ASC`,
                )
                .all({})
            : this.db
                .query<AgentRunRow, { tenantId: string }>(
                    `SELECT id, tenant_id, status, created_at, started_at,
                            finished_at, checkpoint_id
                     FROM agent_runs WHERE tenant_id = $tenantId
                     ORDER BY created_at ASC`,
                )
                .all({ tenantId });
        if (runs.length === 0) {
            return [];
        }

        const attemptCounts = new Map<string, number>();
        for (const row of this.db
            .query<CountRow & { run_id: string }, []>(
                `SELECT run_id, COUNT(*) AS n FROM run_attempts GROUP BY run_id`,
            )
            .all()) {
            attemptCounts.set(row.run_id, row.n);
        }

        const toolRowsByRun = new Map<string, ToolEffectRowWithRun[]>();
        for (const row of this.db
            .query<ToolEffectRowWithRun, []>(
                `SELECT run_id, effect, status FROM tool_executions`,
            )
            .all()) {
            const list = toolRowsByRun.get(row.run_id) ?? [];
            list.push(row);
            toolRowsByRun.set(row.run_id, list);
        }

        const usagePayloadsByRun = new Map<string, string[]>();
        for (const row of this.db
            .query<PayloadRow & { run_id: string }, []>(
                `SELECT run_id, payload_json FROM run_events
                 WHERE type = 'MODEL_COMPLETED'`,
            )
            .all()) {
            const list = usagePayloadsByRun.get(row.run_id) ?? [];
            list.push(row.payload_json);
            usagePayloadsByRun.set(row.run_id, list);
        }

        const diffRunIds = new Set(
            this.db.query<{ run_id: string }, []>(
                `SELECT run_id FROM run_workspace_diffs`,
            ).all().map((row) => row.run_id),
        );
        const artifactRunIds = new Set(
            this.db.query<{ run_id: string }, []>(
                `SELECT run_id FROM run_artifacts`,
            ).all().map((row) => row.run_id),
        );
        const outputRunIds = new Set(
            this.db.query<{ run_id: string }, []>(
                `SELECT DISTINCT run_id FROM run_output_chunks`,
            ).all().map((row) => row.run_id),
        );

        return runs.map((run) => this.toRunMetrics(run, {
            attemptCount: attemptCounts.get(run.id) ?? 0,
            toolRows: toolRowsByRun.get(run.id) ?? [],
            usagePayloads: (usagePayloadsByRun.get(run.id) ?? []).map(
                (payload_json) => ({ payload_json }),
            ),
            producedDiff: diffRunIds.has(run.id),
            producedArtifact: artifactRunIds.has(run.id),
            hasFinalText: outputRunIds.has(run.id),
        }));
    }

    /** 把一组单任务指标聚合成系统/租户级总结（纯函数，易测）。 */
    summarize(runs: readonly RunMetrics[]): EvaluationSummary {
        const totalRuns = runs.length;

        const statusCounts: Record<string, number> = {};
        for (const run of runs) {
            statusCounts[run.finalStatus] =
                (statusCounts[run.finalStatus] ?? 0) + 1;
        }

        const completed = statusCounts["COMPLETED"] ?? 0;
        const queueWaits = runs
            .map((r) => r.queueWaitMs)
            .filter((v): v is number => v !== null);
        const durations = runs
            .map((r) => r.runDurationMs)
            .filter((v): v is number => v !== null);

        const rate = (n: number): number =>
            totalRuns === 0 ? 0 : n / totalRuns;

        const toolEffectTotals = {
            readOnly: 0,
            idempotentWrite: 0,
            unknownEffect: 0,
            blockedDangerous: 0,
        };
        let totalTokens = 0;
        let totalCost = 0;
        let hasCost = false;
        let sumInput = 0;
        let sumCacheRead = 0;
        let runsWithUsage = 0;
        for (const run of runs) {
            toolEffectTotals.readOnly += run.toolCallsByEffect.readOnly;
            toolEffectTotals.idempotentWrite +=
                run.toolCallsByEffect.idempotentWrite;
            toolEffectTotals.unknownEffect +=
                run.toolCallsByEffect.unknownEffect;
            toolEffectTotals.blockedDangerous +=
                run.blockedDangerousToolCount;

            if (run.llmUsage !== null) {
                runsWithUsage += 1;
                totalTokens += run.llmUsage.totalTokens;
                sumInput += run.llmUsage.inputTokens;
                sumCacheRead += run.llmUsage.cacheReadTokens;
                if (run.llmUsage.costTotal !== null) {
                    hasCost = true;
                    totalCost += run.llmUsage.costTotal;
                }
            }
        }

        return {
            totalRuns,
            statusCounts,
            successRate: rate(completed),
            avgAttemptCount:
                totalRuns === 0
                    ? 0
                    : runs.reduce((acc, r) => acc + r.attemptCount, 0)
                        / totalRuns,
            queueWaitMs: {
                avg: average(queueWaits),
                p95: percentile(queueWaits, 95),
            },
            runDurationMs: {
                avg: average(durations),
                p95: percentile(durations, 95),
            },
            completion: {
                diffRate: rate(runs.filter((r) => r.producedDiff).length),
                artifactRate: rate(
                    runs.filter((r) => r.producedArtifact).length,
                ),
                finalTextRate: rate(
                    runs.filter((r) => r.hasFinalText).length,
                ),
            },
            // 无人值守率：没有「被拦下的危险副作用」的任务占比。
            unattendedRate: rate(
                runs.filter((r) => r.blockedDangerousToolCount === 0).length,
            ),
            toolEffectTotals,
            llmTotals: {
                totalTokens,
                avgTokensPerRun:
                    runsWithUsage === 0 ? 0 : totalTokens / runsWithUsage,
                totalCost: hasCost ? totalCost : null,
                cacheHitRate:
                    sumInput + sumCacheRead === 0
                        ? null
                        : sumCacheRead / (sumInput + sumCacheRead),
            },
        };
    }

    /** 资源准入评测：聚合 policy_decisions。 */
    computeResourceEvaluation(tenantId?: string): ResourceEvaluation {
        const rows = tenantId === undefined
            ? this.db
                .query<PolicyDecisionRow, Record<string, never>>(
                    `SELECT d.action, d.reason_code, d.pressure
                     FROM policy_decisions d`,
                )
                .all({})
            : this.db
                .query<PolicyDecisionRow, { tenantId: string }>(
                    `SELECT d.action, d.reason_code, d.pressure
                     FROM policy_decisions d
                     JOIN agent_runs r ON r.id = d.run_id
                     WHERE r.tenant_id = $tenantId`,
                )
                .all({ tenantId });

        const totalDecisions = rows.length;
        const actionCounts: Record<string, number> = {};
        const reasonCounts: Record<string, number> = {};
        let pressured = 0;
        let observationFailed = 0;
        for (const row of rows) {
            actionCounts[row.action] = (actionCounts[row.action] ?? 0) + 1;
            reasonCounts[row.reason_code] =
                (reasonCounts[row.reason_code] ?? 0) + 1;
            if (row.pressure === "CRITICAL" || row.pressure === "UNKNOWN") {
                pressured += 1;
            }
            if (row.reason_code === "RESOURCE_OBSERVATION_FAILED") {
                observationFailed += 1;
            }
        }

        const rate = (n: number): number =>
            totalDecisions === 0 ? 0 : n / totalDecisions;

        return {
            totalDecisions,
            actionCounts,
            reasonCounts,
            pressuredRate: rate(pressured),
            observationFailureRate: rate(observationFailed),
        };
    }

    /** 所有出现过的租户（供观测页租户切换）。 */
    listTenants(): string[] {
        return this.db
            .query<{ tenant_id: string }, Record<string, never>>(
                `SELECT DISTINCT tenant_id FROM agent_runs
                 ORDER BY tenant_id ASC`,
            )
            .all({})
            .map((row) => row.tenant_id);
    }

    /**
     * 支柱 2：LLM 网关前缀缓存命中评测（读 llm_cache_metrics 台账）。
     * Run 级 usage.cacheReadTokens 之外，这里补上网关直连视角的
     * prompt_tokens_details.cached_tokens 系统级命中率。
     */
    computeLlmCacheMetrics(backendId?: string): LlmCacheMetricsAggregate {
        // D1：委托给 LlmCacheMetricsStore.aggregate——SQL 只写一份。
        return this.llmCacheMetricsStore.aggregate(backendId);
    }

    private exists(sql: string, runId: string): boolean {
        return (
            this.db
                .query<{ one: number }, { runId: string }>(sql)
                .get({ runId }) !== null
        );
    }
}

/** 聚合一个 Run 的所有 MODEL_COMPLETED 事件的 usage；无则 null。 */
function aggregateLlmUsage(
    events: readonly PayloadRow[],
): RunMetrics["llmUsage"] {
    let usage: NonNullable<RunMetrics["llmUsage"]> | null = null;
    let hasCost = false;

    for (const event of events) {
        let payload: unknown;
        try {
            payload = JSON.parse(event.payload_json);
        } catch {
            continue;
        }
        const u = (payload as { usage?: Record<string, unknown> }).usage;
        if (u === undefined || u === null) {
            continue;
        }
        if (usage === null) {
            usage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
                costTotal: 0,
            };
        }
        usage.inputTokens += (u.inputTokens as number | undefined) ?? 0;
        usage.outputTokens += (u.outputTokens as number | undefined) ?? 0;
        usage.cacheReadTokens += (u.cacheReadTokens as number | undefined) ?? 0;
        usage.cacheWriteTokens +=
            (u.cacheWriteTokens as number | undefined) ?? 0;
        usage.reasoningTokens += (u.reasoningTokens as number | null | undefined) ?? 0;
        usage.totalTokens += (u.totalTokens as number | undefined) ?? 0;
        const cost = (u.cost as { total?: number } | undefined)?.total;
        if (cost !== undefined && cost !== null) {
            hasCost = true;
            usage.costTotal = (usage.costTotal ?? 0) + cost;
        }
    }

    if (usage === null) {
        return null;
    }
    if (!hasCost) {
        usage.costTotal = null;
    }
    return usage;
}
