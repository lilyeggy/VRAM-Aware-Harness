import { expect, test } from "bun:test";

import { EvaluationAggregator } from "../../src/eval/evaluation-aggregator.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";

/**
 * 造两个对比任务：
 * - run-1 COMPLETED：有排队/耗时、混合工具副作用（含一个被拦危险调用）、
 *   两次模型调用（含 token/cost/cache）、完整完成度信号、有 checkpoint。
 * - run-2 FAILED：未启动（无排队/耗时）、一个只读工具、无模型调用、无完成度信号。
 * 外加三条资源准入决策，覆盖 pressuredRate / observationFailureRate。
 */
function buildDb() {
    const db = openHarnessDatabase(":memory:");

    db.exec(`
        INSERT INTO agent_runs (
            id, tenant_id, harness_session_id, status, user_input,
            workspace_path, created_at, updated_at, started_at,
            finished_at, checkpoint_id, failure_reason
        ) VALUES (
            'run-1', 'tenant-a', 'sess-1', 'COMPLETED', 'task1',
            '/w1', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:12.000Z',
            '2026-08-18T00:00:02.000Z', '2026-08-18T00:00:12.000Z',
            'cp-1', NULL
        ),(
            'run-2', 'tenant-a', 'sess-1', 'FAILED', 'task2',
            '/w2', '2026-08-18T00:01:00.000Z', '2026-08-18T00:01:05.000Z',
            NULL, NULL, NULL, 'boom'
        );

        INSERT INTO tool_executions (
            id, run_id, tool_call_id, tool_name, arguments_json,
            effect, status, result_json, error_message, created_at, finished_at
        ) VALUES
            ('te-1','run-1','tc-1','read','{}','READ_ONLY','SUCCEEDED','{}',NULL,'2026-08-18T00:00:03.000Z','2026-08-18T00:00:04.000Z'),
            ('te-2','run-1','tc-2','read','{}','READ_ONLY','SUCCEEDED','{}',NULL,'2026-08-18T00:00:05.000Z','2026-08-18T00:00:06.000Z'),
            ('te-3','run-1','tc-3','post','{}','UNKNOWN_EFFECT','PREPARED',NULL,NULL,'2026-08-18T00:00:07.000Z',NULL),
            ('te-4','run-2','tc-9','read','{}','READ_ONLY','SUCCEEDED','{}',NULL,'2026-08-18T00:01:01.000Z','2026-08-18T00:01:02.000Z');

        INSERT INTO run_events (
            event_id, run_id, sequence, type, timestamp, payload_version, payload_json
        ) VALUES
            ('e-1','run-1',1,'MODEL_COMPLETED','2026-08-18T00:00:03.000Z',1,
             '{"modelCallId":"m1","durationMs":1000,"usage":{"inputTokens":100,"outputTokens":40,"cacheReadTokens":50,"cacheWriteTokens":10,"reasoningTokens":null,"totalTokens":150,"cost":{"total":0.5}}}'),
            ('e-2','run-1',2,'MODEL_COMPLETED','2026-08-18T00:00:08.000Z',1,
             '{"modelCallId":"m2","durationMs":2000,"usage":{"inputTokens":200,"outputTokens":40,"cacheReadTokens":50,"cacheWriteTokens":10,"reasoningTokens":null,"totalTokens":250,"cost":{"total":0.3}}}');

        INSERT INTO run_workspace_diffs (run_id, diff_json, created_at)
            VALUES ('run-1','{"files":[]}','2026-08-18T00:00:12.000Z');
        INSERT INTO run_artifacts (run_id, path, hash, size, created_at)
            VALUES ('run-1','out.txt','h1',10,'2026-08-18T00:00:12.000Z');
        INSERT INTO run_output_chunks (id, run_id, sequence, delta, created_at)
            VALUES ('oc-1','run-1',1,'最终回答','2026-08-18T00:00:12.000Z');

        INSERT INTO resource_snapshots (snapshot_id, observed_at, sources_json)
            VALUES ('snap-1','2026-08-18T00:00:00.000Z','[]');

        INSERT INTO policy_decisions (
            decision_id, run_id, action, reason_code, resource_snapshot_id,
            pressure, observation_failure_reason, decided_at
        ) VALUES
            ('d-1','run-1','START','RESOURCE_NORMAL','snap-1','NORMAL',NULL,'2026-08-18T00:00:00.000Z'),
            ('d-2','run-1','QUEUE','RESOURCE_CRITICAL','snap-1','CRITICAL',NULL,'2026-08-18T00:00:01.000Z'),
            ('d-3','run-2','QUEUE','RESOURCE_OBSERVATION_FAILED',NULL,'UNKNOWN','TIMEOUT','2026-08-18T00:01:00.000Z');
    `);

    return db;
}

test("单任务指标：排队/耗时/工具画像/危险拦截/checkpoint", () => {
    const db = buildDb();
    const agg = new EvaluationAggregator(db);
    const m = agg.computeRunMetrics("run-1");
    expect(m).not.toBeNull();
    expect(m!.finalStatus).toBe("COMPLETED");
    expect(m!.queueWaitMs).toBe(2000);
    expect(m!.runDurationMs).toBe(10000);
    expect(m!.toolCallCount).toBe(3);
    expect(m!.toolCallsByEffect).toEqual({
        readOnly: 2,
        idempotentWrite: 0,
        unknownEffect: 1,
    });
    expect(m!.blockedDangerousToolCount).toBe(1);
    expect(m!.hasCheckpoint).toBe(true);
    expect(m!.producedDiff).toBe(true);
    expect(m!.producedArtifact).toBe(true);
    expect(m!.hasFinalText).toBe(true);
});

test("单任务指标：聚合多次模型调用的 token/cost/cache 用量", () => {
    const db = buildDb();
    const agg = new EvaluationAggregator(db);
    const m = agg.computeRunMetrics("run-1");
    expect(m!.llmUsage).not.toBeNull();
    expect(m!.llmUsage!.inputTokens).toBe(300);
    expect(m!.llmUsage!.totalTokens).toBe(400);
    expect(m!.llmUsage!.cacheReadTokens).toBe(100);
    expect(m!.llmUsage!.costTotal).toBeCloseTo(0.8);
});

test("单任务指标：无模型调用的任务 llmUsage 为 null", () => {
    const db = buildDb();
    const agg = new EvaluationAggregator(db);
    const m = agg.computeRunMetrics("run-2");
    expect(m!.llmUsage).toBeNull();
    expect(m!.queueWaitMs).toBeNull();
    expect(m!.runDurationMs).toBeNull();
    expect(m!.producedDiff).toBe(false);
});

test("聚合：成功率/完成度/无人值守率/工具画像/cache 命中率", () => {
    const db = buildDb();
    const agg = new EvaluationAggregator(db);
    const runs = agg.listRunMetrics();
    expect(runs.length).toBe(2);
    const s = agg.summarize(runs);
    expect(s.totalRuns).toBe(2);
    expect(s.successRate).toBeCloseTo(0.5);
    expect(s.completion.diffRate).toBeCloseTo(0.5);
    expect(s.completion.artifactRate).toBeCloseTo(0.5);
    // 只有 run-2 没有被拦危险副作用 → 1/2
    expect(s.unattendedRate).toBeCloseTo(0.5);
    expect(s.toolEffectTotals).toEqual({
        readOnly: 3,
        idempotentWrite: 0,
        unknownEffect: 1,
        blockedDangerous: 1,
    });
    expect(s.llmTotals.totalTokens).toBe(400);
    expect(s.llmTotals.totalCost).toBeCloseTo(0.8);
    // cacheRead / (input + cacheRead) = 100 / (300 + 100)
    expect(s.llmTotals.cacheHitRate).toBeCloseTo(0.25);
});

test("资源准入评测：决策/原因分布、背压率、观测失败率", () => {
    const db = buildDb();
    const agg = new EvaluationAggregator(db);
    const r = agg.computeResourceEvaluation();
    expect(r.totalDecisions).toBe(3);
    expect(r.actionCounts).toEqual({ START: 1, QUEUE: 2 });
    expect(r.reasonCounts.RESOURCE_OBSERVATION_FAILED).toBe(1);
    // CRITICAL + UNKNOWN → 2/3
    expect(r.pressuredRate).toBeCloseTo(2 / 3);
    expect(r.observationFailureRate).toBeCloseTo(1 / 3);
});

test("聚合：按租户过滤", () => {
    const db = buildDb();
    const agg = new EvaluationAggregator(db);
    expect(agg.listRunMetrics("tenant-a").length).toBe(2);
    expect(agg.listRunMetrics("tenant-x").length).toBe(0);
    expect(agg.computeResourceEvaluation("tenant-x").totalDecisions).toBe(0);
});
