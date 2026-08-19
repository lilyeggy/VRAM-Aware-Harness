/**
 * 方向 A：执行质量评测报告。
 *
 * 用法：
 *   bun run scripts/eval-report.ts <sqlite-db-path> [tenantId]
 *
 * 从现有落库数据读出并计算评测指标（行业标准 token/cost/latency/quality
 * + 我们特有的背压/副作用/自治/完成度），输出 JSON 报告。
 */

import { EvaluationAggregator } from "../src/eval/evaluation-aggregator.ts";
import { openHarnessDatabase } from "../src/storage/database.ts";

const dbPath = process.argv[2];
const tenantId = process.argv[3];

if (dbPath === undefined) {
    console.error(
        "用法: bun run scripts/eval-report.ts <sqlite-db-path> [tenantId]",
    );
    process.exit(1);
}

const db = openHarnessDatabase(dbPath);
const aggregator = new EvaluationAggregator(db);

const runs = aggregator.listRunMetrics(tenantId);
const summary = aggregator.summarize(runs);
const resource = aggregator.computeResourceEvaluation(tenantId);

console.log(
    JSON.stringify(
        {
            scope: tenantId === undefined ? "all-tenants" : tenantId,
            runCount: runs.length,
            executionQuality: summary,
            resourceAdmission: resource,
        },
        null,
        2,
    ),
);
