/**
 * 平台运行报告：直接读 SQLite，把"平台效果"指标算出来。
 *
 * 覆盖：任务成功率、端到端 p50/p95/p99、排队等待、工具成功率与耗时分布、
 * 沙箱 warmHit 与获取时延、模型 TTFT/token/成本、恢复率（interrupted→resumed）、
 * 每用户成本归因。
 *
 * 用法：
 *   bun run scripts/platform-report.ts --database /path/to/harness.sqlite
 */
import { Database } from "bun:sqlite";

interface RunRow {
    id: string;
    user_id: string;
    status: string;
    created_at: string;
    finished_at: string | null;
}

interface EventRow {
    run_id: string;
    sequence: number;
    type: string;
    timestamp: string;
    payload_json: string;
}

const args = process.argv.slice(2);
const dbIndex = args.indexOf("--database");
const databasePath = dbIndex === -1 ? "data/harness.sqlite" : args[dbIndex + 1];

if (databasePath === undefined) {
    console.error("用法：--database <path>");
    process.exit(1);
}

const db = new Database(databasePath, { readonly: true });

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index] ?? 0;
}

function ms(startedAt: string | null, finishedAt: string | null): number | null {
    if (startedAt === null || finishedAt === null) return null;
    const start = Date.parse(startedAt);
    const end = Date.parse(finishedAt);
    if (Number.isFinite(start) === false || Number.isFinite(end) === false) return null;
    return Math.max(0, end - start);
}

function payloadOf(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

const runs = db.query<RunRow, []>(`
    SELECT id, user_id, status, created_at, finished_at FROM agent_runs
`).all();

const eventsByRun = new Map<string, EventRow[]>();
for (const event of db.query<EventRow, []>(`
    SELECT run_id, sequence, type, timestamp, payload_json
    FROM run_events ORDER BY run_id, sequence
`).all()) {
    const list = eventsByRun.get(event.run_id) ?? [];
    list.push(event);
    eventsByRun.set(event.run_id, list);
}

// ---------------- 任务结果 ----------------
const statusCounts = new Map<string, number>();
const wall: number[] = [];
const queueWait: number[] = [];
const ttft: number[] = [];
let totalTokens = 0;
let totalCost = 0;

const perUser = new Map<string, { runs: number; completed: number; tokens: number; cost: number; wall: number[] }>();
const toolStats = new Map<string, { calls: number; errors: number; durations: number[] }>();
const sandbox: { acquisitions: number; warm: number; durations: number[] } = { acquisitions: 0, warm: 0, durations: [] };
let interruptedRuns = 0;
let resumedRuns = 0;
let resumedCompleted = 0;
let recoverableInterrupted = 0;
const interruptReasons = new Map<string, number>();
const RECOVERABLE_REASONS = new Set([
    "RUNTIME_INTERRUPTED",
    "LEASE_EXPIRED",
    "WORKER_CRASHED",
]);

for (const run of runs) {
    statusCounts.set(run.status, (statusCounts.get(run.status) ?? 0) + 1);

    const user = perUser.get(run.user_id)
        ?? { runs: 0, completed: 0, tokens: 0, cost: 0, wall: [] };
    user.runs += 1;
    perUser.set(run.user_id, user);

    const runWall = ms(run.created_at, run.finished_at);
    if (runWall !== null) {
        wall.push(runWall);
        user.wall.push(runWall);
    }
    if (run.status === "COMPLETED") {
        user.completed += 1;
    }

    const events = eventsByRun.get(run.id) ?? [];
    const toolStartedAt = new Map<string, number>();
    let sawInterrupted = false;
    let sawResumed = false;

    for (const event of events) {
        const payload = payloadOf(event.payload_json);

        if (event.type === "RUN_INTERRUPTED") {
            sawInterrupted = true;
            const reason = typeof payload.reason === "string"
                ? payload.reason
                : "unknown";
            interruptReasons.set(reason, (interruptReasons.get(reason) ?? 0) + 1);
            if (RECOVERABLE_REASONS.has(reason)) {
                recoverableInterrupted += 1;
            }
        }
        if (event.type === "RUN_RESUMED") sawResumed = true;

        if (event.type === "RUN_STARTED") {
            const created = Date.parse(run.created_at);
            const started = Date.parse(event.timestamp);
            if (Number.isFinite(created) && Number.isFinite(started)) {
                queueWait.push(Math.max(0, started - created));
            }
        }

        if (event.type === "SANDBOX_ACQUIRED") {
            sandbox.acquisitions += 1;
            if (payload.warmHit === true) sandbox.warm += 1;
            if (typeof payload.durationMs === "number") sandbox.durations.push(payload.durationMs);
        }

        if (event.type === "MODEL_STARTED" && typeof payload.ttftMs === "number") {
            ttft.push(payload.ttftMs);
        }

        if (event.type === "MODEL_COMPLETED") {
            const usage = payload.usage !== null && typeof payload.usage === "object"
                ? payload.usage as Record<string, unknown>
                : {};
            const cost = usage.cost !== null && typeof usage.cost === "object"
                ? usage.cost as Record<string, unknown>
                : {};
            if (typeof usage.totalTokens === "number") {
                totalTokens += usage.totalTokens;
                user.tokens += usage.totalTokens;
            }
            if (typeof cost.total === "number") {
                totalCost += cost.total;
                user.cost += cost.total;
            }
        }

        if (event.type === "TOOL_STARTED") {
            const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : event.sequence.toString();
            toolStartedAt.set(callId, Date.parse(event.timestamp));
        }

        if (event.type === "TOOL_COMPLETED" || event.type === "TOOL_FAILED") {
            const name = typeof payload.toolName === "string" ? payload.toolName : "unknown";
            const stat = toolStats.get(name) ?? { calls: 0, errors: 0, durations: [] };
            stat.calls += 1;
            if (event.type === "TOOL_FAILED" || payload.isError === true) stat.errors += 1;
            const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : event.sequence.toString();
            const startedAtMs = toolStartedAt.get(callId);
            if (startedAtMs !== undefined) {
                stat.durations.push(Math.max(0, Date.parse(event.timestamp) - startedAtMs));
            }
            toolStats.set(name, stat);
        }
    }

    if (sawInterrupted) {
        interruptedRuns += 1;
        if (sawResumed) resumedRuns += 1;
        if (sawResumed && run.status === "COMPLETED") resumedCompleted += 1;
    }
}

const total = runs.length;
const completed = statusCounts.get("COMPLETED") ?? 0;
const failed = statusCounts.get("FAILED") ?? 0;
const interrupted = statusCounts.get("INTERRUPTED") ?? 0;

console.log(`database=${databasePath}`);
console.log(`runs=${total} completed=${completed} failed=${failed} interrupted=${interrupted} `
    + `successRate=${total === 0 ? 0 : ((completed / total) * 100).toFixed(1)}%`);
console.log(`wall p50=${percentile(wall, 50).toFixed(0)}ms p95=${percentile(wall, 95).toFixed(0)}ms p99=${percentile(wall, 99).toFixed(0)}ms`);
console.log(`queueWait p50=${percentile(queueWait, 50).toFixed(0)}ms p95=${percentile(queueWait, 95).toFixed(0)}ms p99=${percentile(queueWait, 99).toFixed(0)}ms`);
console.log(`ttft p50=${percentile(ttft, 50).toFixed(0)}ms p95=${percentile(ttft, 95).toFixed(0)}ms p99=${percentile(ttft, 99).toFixed(0)}ms (samples=${ttft.length})`);
console.log(`tokens=${totalTokens} cost=$${totalCost.toFixed(6)}`);
console.log(`sandbox acquisitions=${sandbox.acquisitions} warmHitRate=${sandbox.acquisitions === 0 ? 0 : ((sandbox.warm / sandbox.acquisitions) * 100).toFixed(1)}% `
    + `acquire p50=${percentile(sandbox.durations, 50).toFixed(0)}ms p95=${percentile(sandbox.durations, 95).toFixed(0)}ms`);
console.log(`recovery interruptedRuns=${interruptedRuns} recoverable=${recoverableInterrupted} `
    + `resumed=${resumedRuns} resumedCompleted=${resumedCompleted} `
    + `resumeRate=${recoverableInterrupted === 0 ? "n/a" : ((resumedRuns / recoverableInterrupted) * 100).toFixed(1) + "%"}`);
console.log(`interruptReasons=${JSON.stringify(Object.fromEntries(interruptReasons))}`);

console.log("\n== 工具分布 ==");
for (const [name, stat] of [...toolStats.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(`${name}: calls=${stat.calls} errorRate=${((stat.errors / stat.calls) * 100).toFixed(1)}% `
        + `p50=${percentile(stat.durations, 50).toFixed(0)}ms p95=${percentile(stat.durations, 95).toFixed(0)}ms`);
}

console.log("\n== 每用户 ==");
for (const [userId, stat] of [...perUser.entries()].sort((a, b) => b[1].runs - a[1].runs).slice(0, 15)) {
    console.log(`${userId.slice(0, 18)}: runs=${stat.runs} completed=${stat.completed} `
        + `tokens=${stat.tokens} cost=$${stat.cost.toFixed(6)} avgWall=${stat.wall.length === 0 ? 0 : Math.round(stat.wall.reduce((sum, value) => sum + value, 0) / stat.wall.length)}ms`);
}

db.close();
