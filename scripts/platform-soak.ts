/**
 * 平台并发浸泡测试（不依赖 GPU / 模型 / 沙箱）。
 *
 * 目标：证明"平台在高并发下的调度正确性"，而不是推理吞吐：
 *   - 所有 Run 都能完成（无丢失、无死锁）
 *   - 同时活跃 Run 数不超过配置上限
 *   - 同一会话永远只有一个 Run 在跑
 *   - 租户之间完成数公平（等权份额）
 *   - 结束后没有 slot / 队列泄漏
 *   - 排队等待的 p50 / p95
 *
 * 用法：
 *   bun run scripts/platform-soak.ts
 *   SOAK_TENANTS=20 SOAK_RUNS_PER_TENANT=25 SOAK_MAX_ACTIVE=8 bun run scripts/platform-soak.ts
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
import { TenantRunScheduler } from "../src/scheduling/tenant-run-scheduler.ts";
import { openHarnessDatabase } from "../src/storage/database.ts";

const tenantCount = Number(process.env.SOAK_TENANTS ?? 10);
const runsPerTenant = Number(process.env.SOAK_RUNS_PER_TENANT ?? 30);
const maxActiveRuns = Number(process.env.SOAK_MAX_ACTIVE ?? 6);
const seed = Number(process.env.SOAK_SEED ?? 20261022);
const minDurationMs = Number(process.env.SOAK_MIN_MS ?? 5);
const maxDurationMs = Number(process.env.SOAK_MAX_MS ?? 60);

function mulberry32(initial: number): () => number {
    let state = initial >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const random = mulberry32(seed);

class SoakRuntime implements AgentRuntime {
    readonly durations = new Map<string, number>();
    active = 0;
    peak = 0;
    sessionViolations = 0;
    private readonly activeSessions = new Map<string, number>();
    private readonly handlersByRunId =
        new Map<string, Set<RuntimeEventHandler>>();

    private emit(event: Parameters<RuntimeEventHandler>[0]): void {
        for (const handler of this.handlersByRunId.get(event.runId) ?? []) {
            handler(event);
        }
    }

    start(request: RuntimeStartRequest): Promise<void> {
        const sessionId = request.run.harnessSessionId;
        const runId = request.run.runId;

        this.emit({
            type: "agent_started",
            runId,
            timestamp: new Date().toISOString(),
            runtimeSessionRef: `soak-${runId}`,
        });
        this.emit({
            type: "text_delta",
            runId,
            timestamp: new Date().toISOString(),
            delta: "SOAK-OK",
        });
        const running = (this.activeSessions.get(sessionId) ?? 0) + 1;

        if (running > 1) {
            this.sessionViolations += 1;
        }
        this.activeSessions.set(sessionId, running);

        this.active += 1;
        this.peak = Math.max(this.peak, this.active);

        const duration = this.durations.get(request.run.runId) ?? minDurationMs;

        return (async () => {
            await Bun.sleep(duration);
            this.emit({
                type: "agent_completed",
                runId,
                timestamp: new Date().toISOString(),
            });
            this.active -= 1;
            const remaining = (this.activeSessions.get(sessionId) ?? 1) - 1;
            if (remaining <= 0) {
                this.activeSessions.delete(sessionId);
            } else {
                this.activeSessions.set(sessionId, remaining);
            }
        })();
    }

    resume(request: RuntimeResumeRequest): Promise<void> {
        return this.start({
            run: request.run,
            input: request.continuationInput,
        });
    }

    async interrupt(): Promise<void> {}

    subscribe(runId: string, handler: RuntimeEventHandler): () => void {
        let handlers = this.handlersByRunId.get(runId);
        if (handlers === undefined) {
            handlers = new Set<RuntimeEventHandler>();
            this.handlersByRunId.set(runId, handlers);
        }
        handlers.add(handler);
        return () => {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.handlersByRunId.delete(runId);
            }
        };
    }
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index] ?? 0;
}

const db = openHarnessDatabase(":memory:");
const store = new RunStore(db);
const runtime = new SoakRuntime();
const runService = new RunService(store, runtime);
const scheduler = new TenantRunScheduler({
    maxActiveRuns,
    maxActiveRunsPerTenant: 0,
    agingMs: 60_000,
});

const enqueuedAt = new Map<string, number>();
const claimedAt = new Map<string, number>();
const originalEnqueue = scheduler.enqueue.bind(scheduler);
const originalClaim = scheduler.claimNext.bind(scheduler);

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

const coordinator = new RunScheduler(runService, scheduler);

const submitted: Array<{ id: string; tenantId: string }> = [];
for (let tenant = 0; tenant < tenantCount; tenant += 1) {
    const tenantId = `tenant-${tenant}`;
    for (let index = 0; index < runsPerTenant; index += 1) {
        const sessionId = `session-${tenant}-${index}`;
        const run = coordinator.submit({
            tenantId,
            harnessSessionId: sessionId,
            userInput: `soak ${tenant}/${index}`,
            workspacePath: `/tmp/soak/${tenant}/${index}`,
        });
        runtime.durations.set(
            run.id,
            Math.round(minDurationMs + random() * (maxDurationMs - minDurationMs)),
        );
        submitted.push({ id: run.id, tenantId });
    }
}

const startedAt = performance.now();
await coordinator.drain();
const wallMs = performance.now() - startedAt;

const completedByTenant = new Map<string, number>();
const waits: number[] = [];
let completed = 0;
let failed = 0;

for (const item of submitted) {
    const run = store.get(item.id);

    if (run?.status === "COMPLETED") {
        completed += 1;
        completedByTenant.set(
            item.tenantId,
            (completedByTenant.get(item.tenantId) ?? 0) + 1,
        );
    } else {
        failed += 1;
    }

    const enqueued = enqueuedAt.get(item.id);
    const claimed = claimedAt.get(item.id);
    if (enqueued !== undefined && claimed !== undefined) {
        waits.push(claimed - enqueued);
    }
}

const counts = [...completedByTenant.values()];
const spread = counts.length === 0 ? 0 : Math.max(...counts) - Math.min(...counts);
const capacity = scheduler.getCapacity("tenant-0");
const queueLeft = scheduler.listQueue().length;

console.log("== 平台并发浸泡 ==");
console.log(`runs=${submitted.length} tenants=${tenantCount} maxActive=${maxActiveRuns} wall=${wallMs.toFixed(0)}ms`);
console.log(`completed=${completed} failed=${failed} peakActive=${runtime.peak}`);
console.log(`sessionViolations=${runtime.sessionViolations}`);
console.log(`perTenantCompleted=${counts.join(",")} spread=${spread}`);
console.log(`queueWait p50=${percentile(waits, 50).toFixed(1)}ms p95=${percentile(waits, 95).toFixed(1)}ms p99=${percentile(waits, 99).toFixed(1)}ms`);
console.log(`leak: activeRunCount=${capacity.activeRunCount} queuedLeft=${queueLeft}`);

const ok = completed === submitted.length
    && failed === 0
    && runtime.peak <= maxActiveRuns
    && runtime.sessionViolations === 0
    && spread <= 2
    && capacity.activeRunCount === 0
    && queueLeft === 0;

console.log(ok ? "SOAK_OK" : "SOAK_FAILED");
db.close();

if (ok === false) {
    process.exit(1);
}
