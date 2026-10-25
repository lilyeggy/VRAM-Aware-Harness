/**
 * 调度层量化基准（可离线运行，不依赖模型/沙箱）。
 *
 * 产出四个数：
 *   A. 静态 per-user cap  vs  自动公平份额的容量利用率
 *   B. 10 用户公平性：各用户完成数与排队等待 p50 / p95
 *   C. 混合时长负载下，批屏障修复后的 slot 利用率
 *
 * 用法：bun run scripts/scheduler-benchmark.ts
 */
import { RunService } from "../src/runs/run-service.ts";
import { RunStore } from "../src/runs/runstore.ts";
import type {
    AgentRuntime,
    RuntimeEventHandler,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "../src/runtime/agent-runtime.ts";
import { RunScheduler } from "../src/scheduling/run-scheduler.ts";
import { UserRunScheduler } from "../src/scheduling/user-run-scheduler.ts";
import { openHarnessDatabase } from "../src/storage/database.ts";

interface ClaimTrace {
    readonly claimedAt: Map<string, number>;
    readonly enqueuedAt: Map<string, number>;
}

function instrument(scheduler: UserRunScheduler): ClaimTrace {
    const claimedAt = new Map<string, number>();
    const enqueuedAt = new Map<string, number>();
    const originalClaim = scheduler.claimNext.bind(scheduler);
    const originalEnqueue = scheduler.enqueue.bind(scheduler);

    scheduler.enqueue = (input) => {
        const run = originalEnqueue(input);
        enqueuedAt.set(run.runId, performance.now());
        return run;
    };

    scheduler.claimNext = () => {
        const run = originalClaim();
        if (run !== null) {
            claimedAt.set(run.runId, performance.now());
        }
        return run;
    };

    return { claimedAt, enqueuedAt };
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[index] ?? 0;
}

function waitsMs(trace: ClaimTrace): number[] {
    const waits: number[] = [];
    for (const [runId, claimed] of trace.claimedAt) {
        const enqueued = trace.enqueuedAt.get(runId);
        if (enqueued !== undefined) {
            waits.push(claimed - enqueued);
        }
    }
    return waits;
}

function enqueueMany(
    scheduler: UserRunScheduler,
    userId: string,
    count: number,
    prefix: string,
): void {
    for (let index = 0; index < count; index += 1) {
        scheduler.enqueue({ runId: `${prefix}${index}`, userId });
    }
}

function claimUntilFull(scheduler: UserRunScheduler): Record<string, number> {
    const claimed: Record<string, number> = {};
    while (true) {
        const run = scheduler.claimNext();
        if (run === null) break;
        claimed[run.userId] = (claimed[run.userId] ?? 0) + 1;
    }
    return claimed;
}

function total(record: Record<string, number>): number {
    return Object.values(record).reduce((sum, value) => sum + value, 0);
}

// ---------------------------------------------------------------------------
// A. 静态 cap vs 自动公平份额
// ---------------------------------------------------------------------------
function scenarioA(): void {
    const globalConcurrency = 30;

    const staticScheduler = new UserRunScheduler({
        maxActiveRuns: globalConcurrency,
        maxActiveRunsPerUser: 10,
    });
    enqueueMany(staticScheduler, "user-a", 40, "sa");
    enqueueMany(staticScheduler, "user-b", 40, "sb");
    const staticClaimed = total(claimUntilFull(staticScheduler));

    const fairScheduler = new UserRunScheduler({
        maxActiveRuns: globalConcurrency,
        maxActiveRunsPerUser: 0,
    });
    enqueueMany(fairScheduler, "user-a", 40, "fa");
    enqueueMany(fairScheduler, "user-b", 40, "fb");
    const fairClaimed = total(claimUntilFull(fairScheduler));

    console.log("== A. 容量利用率（2 用户，全局 30）==");
    console.log(
        `静态 cap=10 : claimed=${staticClaimed}/${globalConcurrency} `
        + `utilization=${((staticClaimed / globalConcurrency) * 100).toFixed(1)}%`,
    );
    console.log(
        `自动公平份额: claimed=${fairClaimed}/${globalConcurrency} `
        + `utilization=${((fairClaimed / globalConcurrency) * 100).toFixed(1)}%`,
    );
}

// ---------------------------------------------------------------------------
// B. 10 用户公平性 + 排队等待
// ---------------------------------------------------------------------------
async function scenarioB(): Promise<void> {
    const globalConcurrency = 30;
    const userCount = 10;
    const runsPerUser = 12;
    const scheduler = new UserRunScheduler({
        maxActiveRuns: globalConcurrency,
        maxActiveRunsPerUser: 0,
        agingMs: 60_000,
    });
    const trace = instrument(scheduler);

    for (let user = 0; user < userCount; user += 1) {
        enqueueMany(scheduler, `user-${user}`, runsPerUser, `t${user}-`);
    }

    const completed: Record<string, number> = {};
    while (true) {
        const run = scheduler.claimNext();
        if (run === null) break;
        completed[run.userId] = (completed[run.userId] ?? 0) + 1;
        scheduler.release(run.runId);
        await Bun.sleep(1);
    }

    const waits = waitsMs(trace);
    const counts = Object.values(completed);
    const spread = Math.max(...counts) - Math.min(...counts);

    console.log("\n== B. 10 用户公平性（全局 30，每用户 12 条）==");
    console.log(`每用户完成数: ${counts.join(", ")}（极差 ${spread}）`);
    console.log(
        `排队等待 p50=${percentile(waits, 50).toFixed(1)}ms `
        + `p95=${percentile(waits, 95).toFixed(1)}ms`,
    );
}

// ---------------------------------------------------------------------------
// C. 混合时长负载下的 slot 利用率
// ---------------------------------------------------------------------------
class TimedRuntime implements AgentRuntime {
    private readonly durations = new Map<string, number>();

    setDuration(runId: string, durationMs: number): void {
        this.durations.set(runId, durationMs);
    }

    start(request: RuntimeStartRequest): Promise<void> {
        const duration = this.durations.get(request.run.runId) ?? 10;
        return Bun.sleep(duration);
    }

    resume(request: RuntimeResumeRequest): Promise<void> {
        return this.start({
            run: request.run,
            input: request.continuationInput,
        });
    }

    async interrupt(): Promise<void> {}

    subscribe(_runId: string, _handler: RuntimeEventHandler): () => void {
        return () => {};
    }
}

async function scenarioC(): Promise<void> {
    const maxActiveRuns = 6;
    const userCount = 2;
    const runsPerUser = 30;
    const durationPattern = [5, 10, 20, 50, 200];

    const db = openHarnessDatabase(":memory:");
    const store = new RunStore(db);
    const runtime = new TimedRuntime();
    const runService = new RunService(store, runtime);
    const scheduler = new UserRunScheduler({
        maxActiveRuns,
        maxActiveRunsPerUser: 0,
    });
    const trace = instrument(scheduler);
    const coordinator = new RunScheduler(runService, scheduler);

    let busySlotMs = 0;
    for (let user = 0; user < userCount; user += 1) {
        for (let index = 0; index < runsPerUser; index += 1) {
            const duration = durationPattern[index % durationPattern.length] ?? 10;
            const run = coordinator.submit({
                userId: `user-${user}`,
                harnessSessionId: `session-${user}-${index}`,
                userInput: `bench-${duration}ms`,
                workspacePath: `/tmp/bench-${user}-${index}`,
            });
            runtime.setDuration(run.id, duration);
            busySlotMs += duration;
        }
    }

    const startedAt = performance.now();
    await coordinator.drain();
    const wallMs = performance.now() - startedAt;
    const waits = waitsMs(trace);
    const utilization = busySlotMs / (maxActiveRuns * wallMs);

    console.log("\n== C. 混合时长负载（6 slot，60 条，5~200ms）==");
    console.log(`wall=${wallMs.toFixed(1)}ms busySlot=${busySlotMs}ms`);
    console.log(
        `slot 利用率=${(utilization * 100).toFixed(1)}% `
        + `排队等待 p50=${percentile(waits, 50).toFixed(1)}ms `
        + `p95=${percentile(waits, 95).toFixed(1)}ms`,
    );

    db.close();
}

// ---------------------------------------------------------------------------
// D. 批屏障：旧「整批等待」vs 新「谁先结束谁补位」
// ---------------------------------------------------------------------------
async function scenarioD(): Promise<void> {
    const maxActiveRuns = 6;
    const durationPattern = [5, 10, 20, 50, 200];

    async function runWith(mode: "batch" | "refill"): Promise<number> {
        const db = openHarnessDatabase(":memory:");
        const store = new RunStore(db);
        const runtime = new TimedRuntime();
        const runService = new RunService(store, runtime);
        const scheduler = new UserRunScheduler({
            maxActiveRuns,
            maxActiveRunsPerUser: 0,
        });
        const coordinator = new RunScheduler(runService, scheduler);

        for (let index = 0; index < 18; index += 1) {
            const duration = durationPattern[index % durationPattern.length] ?? 10;
            const run = coordinator.submit({
                userId: `user-${index % 2}`,
                harnessSessionId: `session-d-${index}`,
                userInput: `bench-${duration}ms`,
                workspacePath: `/tmp/bench-d-${index}`,
            });
            runtime.setDuration(run.id, duration);
        }

        const startedAt = performance.now();

        if (mode === "refill") {
            await coordinator.drain();
        } else {
            // 旧算法：每轮把当前队列长度铺开，然后等整批全部结束。
            while (scheduler.listQueue().length > 0) {
                const batch = scheduler.listQueue().length;
                await Promise.allSettled(
                    Array.from({ length: batch }, () => coordinator.attemptNext()),
                );
            }
        }

        const wallMs = performance.now() - startedAt;
        db.close();
        return wallMs;
    }

    const batchWall = await runWith("batch");
    const refillWall = await runWith("refill");

    console.log("\n== D. 批屏障（6 slot，18 条混合时长）==");
    console.log(`旧整批等待 wall=${batchWall.toFixed(1)}ms`);
    console.log(`新逐槽补位 wall=${refillWall.toFixed(1)}ms`);
    console.log(
        `提速 ${(((batchWall - refillWall) / batchWall) * 100).toFixed(1)}%`,
    );
}

scenarioA();
await scenarioB();
await scenarioC();
await scenarioD();
