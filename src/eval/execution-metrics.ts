/**
 * 方向 A：Agent 执行质量评测闭环（Eval）。
 *
 * 目的：不只回答「任务跑完了没有」，而是回答「Agent 跑得好不好」。
 * 这是把现有「可靠的执行」升级为「可度量的执行」，是 agent infra
 * 岗位最看重的能力之一——因为 Agent 不可控，必须被度量。
 *
 * 数据来源：完全复用现有落库数据，不新增采集、不改控制面：
 * - agent_runs / run_attempts / run_events   → 任务生命周期
 * - tool_executions                          → 工具副作用分布
 * - resource_snapshots / policy_decisions    → 资源压力与准入决策
 * - run_workspace_diffs / run_artifacts      → 完成度信号
 * - checkpoints                              → 恢复行为
 *
 * 本文件只定义「算什么」（指标模型与纯函数类型）；怎么算（聚合器）
 * 见 evaluation-aggregator.ts，怎么呈现见报告脚本与观测驾驶舱。
 */

/** 单个任务（Run）的评测指标。 */
export interface RunMetrics {
    runId: string;
    tenantId: string;
    /** 终态：COMPLETED / FAILED / INTERRUPTED 等。 */
    finalStatus: string;
    /** 尝试次数：>1 说明发生过重试/恢复。 */
    attemptCount: number;
    /** 从入队到首次 START 的等待毫秒（排队成本）。 */
    queueWaitMs: number | null;
    /** 从首次 START 到终态的执行毫秒（执行耗时）。 */
    runDurationMs: number | null;
    /** 工具调用总数。 */
    toolCallCount: number;
    /** 按副作用分类的工具调用数。 */
    toolCallsByEffect: {
        readOnly: number;
        idempotentWrite: number;
        unknownEffect: number;
    };
    /**
     * 被拦截的危险副作用数（进入 MANUAL_REVIEW 的 PREPARED 工具）。
     * 越高说明这个任务越「危险」，是可靠性/风险信号。
     */
    blockedDangerousToolCount: number;
    /** 是否建立了恢复点。 */
    hasCheckpoint: boolean;
    // ---- 完成度信号：任务是否真的「产出了可用的东西」 ----
    /** 是否产出文件 Diff。 */
    producedDiff: boolean;
    /** 是否产出 Artifact。 */
    producedArtifact: boolean;
    /** 是否有最终回答文本。 */
    hasFinalText: boolean;
    /**
     * LLM 用量与成本（来自 Pi usage 事件，对齐 OpenTelemetry GenAI /
     * Langfuse 等行业标准指标）。null 表示该任务未采集到用量。
     */
    llmUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
        totalTokens: number;
        costTotal: number | null;
    } | null;
}

/** 一组任务的聚合评测结果（系统级/租户级）。 */
export interface EvaluationSummary {
    /** 统计窗口内的任务总数。 */
    totalRuns: number;
    /** 各终态计数。 */
    statusCounts: Record<string, number>;
    /** 成功率 = COMPLETED / totalRuns。 */
    successRate: number;
    /** 平均尝试次数（>1 表示存在重试/恢复开销）。 */
    avgAttemptCount: number;
    /** 排队等待（毫秒）：平均值与 P95。 */
    queueWaitMs: { avg: number | null; p95: number | null };
    /** 执行耗时（毫秒）：平均值与 P95。 */
    runDurationMs: { avg: number | null; p95: number | null };
    /** 完成度：产出 Diff / Artifact / 最终回答的任务占比。 */
    completion: {
        diffRate: number;
        artifactRate: number;
        finalTextRate: number;
    };
    /** 可靠性：无需人工介入即完成的任务占比。 */
    unattendedRate: number;
    /** 工具副作用画像（跨任务合计）。 */
    toolEffectTotals: {
        readOnly: number;
        idempotentWrite: number;
        unknownEffect: number;
        blockedDangerous: number;
    };
    /** 聚合 LLM 用量与成本（行业标准维度：token / cost）。 */
    llmTotals: {
        totalTokens: number;
        avgTokensPerRun: number;
        totalCost: number | null;
        /**
         * KV cache 命中率 = cacheRead / (input + cacheRead)。
         * 是 LLM 成本效率指标（Pi 特有维度，行业看重）。
         */
        cacheHitRate: number | null;
    };
}

/**
 * 资源与准入评测：把「资源感知的准入」也变成可度量的。
 * 数据来源：policy_decisions + resource_snapshots。
 */
export interface ResourceEvaluation {
    /** 决策总数。 */
    totalDecisions: number;
    /** 各 action（START/QUEUE）计数。 */
    actionCounts: Record<string, number>;
    /** 各 reasonCode（排队原因）计数。 */
    reasonCounts: Record<string, number>;
    /** CRITICAL / UNKNOWN 资源状态占比（背压触发频率）。 */
    pressuredRate: number;
    /** 观测失败率（RESOURCE_OBSERVATION_FAILED 占比，反映可观测健康度）。 */
    observationFailureRate: number;
}
