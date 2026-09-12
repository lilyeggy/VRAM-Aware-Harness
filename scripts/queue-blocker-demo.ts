/**
 * QueueBlocker 真机演示
 *
 * 用项目里真实的三个组件跑一遍（不是伪代码）：
 *   - TenantRunScheduler：真实租户轮转队列，负责算出 blocker
 *   - RunService + RunStore(SQLite :memory:)：真实落库，写 QUEUE_BLOCKED 事件
 *   - RunQueueCoordinator：真实协调器，负责把 blocker 同步成 Run 事实
 *
 * 运行：bun run scripts/queue-blocker-demo.ts
 */

import { RunQueueCoordinator } from "../src/scheduling/run-queue-coordinator.ts";
import { TenantRunScheduler } from "../src/scheduling/tenant-run-scheduler.ts";
import type { QueueBlocker } from "../src/scheduling/tenant-run-scheduler.ts";
import { RunService } from "../src/runs/run-service.ts";
import { RunStore } from "../src/runs/runstore.ts";
import { openHarnessDatabase } from "../src/storage/database.ts";
import type {
    AgentRuntime,
    RuntimeEventHandler,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "../src/runtime/agent-runtime.ts";
import type {
    PolicyAction,
    PolicyDecision,
    PolicyReasonCode,
} from "../src/resources/execution-policy.ts";
import type {
    ResourceAdmissionEvaluator,
    ResourceAdmissionRequest,
    ResourceAdmissionResult,
} from "../src/resources/resource-admission-service.ts";

/* ------------------------------------------------------------------ */
/* 1. 真实存储：SQLite 内存库 + 真实 RunService                          */
/* ------------------------------------------------------------------ */

const db = openHarnessDatabase(":memory:");
const store = new RunStore(db);

/**
 * 演示用 Runtime：start 之后不投递任何事件，Run 就停在 RUNNING，
 * 用来模拟"还在跑、占着并发槽位"的状态（真实场景里这是常态）。
 */
class SilentRuntime implements AgentRuntime {
    subscribe(_runId: string, _handler: RuntimeEventHandler): () => void {
        return () => {};
    }
    async start(_request: RuntimeStartRequest): Promise<void> {}
    async resume(_request: RuntimeResumeRequest): Promise<void> {}
    async interrupt(_runId: string): Promise<void> {}
}

const runService = new RunService(store, new SilentRuntime());

/* ------------------------------------------------------------------ */
/* 2. 可控的准入评估器（模拟 GPU 显存压力判决）                          */
/* ------------------------------------------------------------------ */

class StubAdmission implements ResourceAdmissionEvaluator {
    constructor(
        private readonly action: PolicyAction,
        private readonly reasonCode: PolicyReasonCode,
    ) {}

    async evaluate(request: ResourceAdmissionRequest): Promise<ResourceAdmissionResult> {
        const decision: PolicyDecision = {
            decisionId: `decision-${request.runId}`,
            runId: request.runId,
            action: this.action,
            reasonCode: this.reasonCode,
            resourceSnapshotId: "snapshot-demo",
            pressure: this.reasonCode === "RESOURCE_CRITICAL" ? "CRITICAL" : "NORMAL",
            observationFailureReason: null,
            decidedAt: new Date().toISOString(),
        };

        return {
            observation: {
                ok: true,
                snapshot: {
                    snapshotId: "snapshot-demo",
                    observedAt: new Date().toISOString(),
                    sources: ["FAKE"],
                    gpuTotalMemoryMiB: 48_000,
                    gpuUsedMemoryMiB: 43_000,
                    gpuFreeMemoryMiB: 5_000,
                    gpuUtilizationPercent: 96,
                    runningRequests: 8,
                    waitingRequests: 3,
                    kvCacheUsagePercent: 91,
                    inputTokensPerSecond: 1_200,
                    outputTokensPerSecond: 300,
                },
            },
            classification: null,
            decision,
        };
    }
}

/* ------------------------------------------------------------------ */
/* 3. 展示用的小工具                                                     */
/* ------------------------------------------------------------------ */

const labels = new Map<string, string>();

function line(title: string): void {
    console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

function showBlockers(title: string, scheduler: TenantRunScheduler): void {
    const blockers: QueueBlocker[] = scheduler.listQueueBlockers();
    const capacity = `activeRunCount=${blockers[0]?.activeRunCount ?? 0}`;

    console.log(`\n${title}  （${capacity}）`);
    if (blockers.length === 0) {
        console.log("  (队列为空)");
        return;
    }
    console.table(
        blockers.map((b) => ({
            run: labels.get(b.runId) ?? b.runId,
            tenant: b.tenantId,
            pos: b.position,
            tenantPos: b.tenantPosition,
            activeTenant: b.activeTenantRunCount,
            reasonCode: b.reasonCode,
        })),
    );
}

function eventCount(): number {
    const row = db
        .query("select count(*) as n from run_events where type = 'QUEUE_BLOCKED'")
        .get() as { n: number };
    return row.n;
}

/* ------------------------------------------------------------------ */
/* 4. 开演                                                              */
/* ------------------------------------------------------------------ */

const scheduler = new TenantRunScheduler({
    maxActiveRuns: 3,
    maxActiveRunsPerTenant: 1, // 每个租户同时只能跑 1 个
});

const coordinator = new RunQueueCoordinator(
    runService,
    scheduler,
    new StubAdmission("START", "RESOURCE_NORMAL"),
);

function submit(tag: string, tenantId: string, sessionId?: string) {
    const run = coordinator.submit({
        tenantId,
        harnessSessionId: sessionId ?? `session-${tag}`,
        userInput: tag,
        workspacePath: `/tmp/${tag}`,
    });
    labels.set(run.id, tag);
    console.log(`submit ${tag} (tenant=${tenantId}) -> runId=${run.id.slice(0, 8)}`);
    return run;
}

line("M0 基线：队列里只有一个 Run，且没有并发压力");
console.log("配置 maxActiveRuns=3, maxActiveRunsPerTenant=1");
submit("A1", "tenant-a");
showBlockers("listQueueBlockers()", scheduler);
console.log(
    `→ reasonCode=AWAITING_SCHEDULING：还在排队等轮到，没有"卡住的原因"。\n` +
    `  coordinator 显式跳过这种原因，不写事件（RUN_CREATED 已经代表在排队）。\n` +
    `  当前 QUEUE_BLOCKED 事件数 = ${eventCount()}`,
);

line("M1 租户并发上限：tenant-a 已经有 1 个 Run 在跑，后面的只能等");
const claimedA1 = scheduler.claimNext();
console.log(`claimNext() -> ${labels.get(claimedA1!.runId)} 出队并占用槽位（视为 RUNNING，不释放）`);
submit("A2", "tenant-a");
submit("A3", "tenant-a");
showBlockers("listQueueBlockers()", scheduler);
console.log(`→ TENANT_CONCURRENCY_LIMIT，写库。当前 QUEUE_BLOCKED 事件数 = ${eventCount()}`);

line("M2 去重：原因没变就不重复写事件（pump 每秒都在 drain）");
submit("A4", "tenant-a");
submit("B1", "tenant-b");
showBlockers("listQueueBlockers()", scheduler);
console.log(
    `→ A2/A3 的原因仍是 TENANT_CONCURRENCY_LIMIT，与上次相同，被 lastQueueBlockerByRunId 拦掉；\n` +
    `  B1 还没被任何东西挡住 = AWAITING_SCHEDULING，同样不写。\n` +
    `  当前 QUEUE_BLOCKED 事件数 = ${eventCount()}（这一幕只多了 A4 这一条）`,
);

line("M3 全局并发上限：把 3 个全局槽位占满，原因从「租户」升级为「全局」");
scheduler.claimNext(); // B1
submit("C1", "tenant-c");
scheduler.claimNext(); // C1
submit("C2", "tenant-c");
showBlockers("listQueueBlockers()", scheduler);
console.log(
    `→ 全局槽位满了：无论哪个租户都动不了，reasonCode 统一升级为 GLOBAL_CONCURRENCY_LIMIT。\n` +
    `  A2/A3/A4 的"原因发生了变化"（TENANT → GLOBAL），所以各追加 1 条新事件。\n` +
    `  当前 QUEUE_BLOCKED 事件数 = ${eventCount()}`,
);

/* ---- M4 会话串行 -------------------------------------------------- */

const sessionScheduler = new TenantRunScheduler({
    maxActiveRuns: 4,
    maxActiveRunsPerTenant: 4,
});
const sessionCoordinator = new RunQueueCoordinator(
    runService,
    sessionScheduler,
    new StubAdmission("START", "RESOURCE_NORMAL"),
);

function submitSession(tag: string, sessionId: string) {
    const run = sessionCoordinator.submit({
        tenantId: "tenant-s",
        harnessSessionId: sessionId,
        userInput: tag,
        workspacePath: `/tmp/${tag}`,
    });
    labels.set(run.id, tag);
    return run;
}

line("M4 会话串行：同一段对话的两条消息不能并发（否则消息流会错序）");
submitSession("S1", "chat-9527");
sessionScheduler.claimNext(); // S1 占用 chat-9527
submitSession("S2", "chat-9527");
showBlockers("listQueueBlockers()", sessionScheduler);
console.log(`→ SESSION_SERIALIZATION。当前 QUEUE_BLOCKED 事件数 = ${eventCount()}`);

/* ---- M5 资源准入拒绝 ---------------------------------------------- */

const resourceScheduler = new TenantRunScheduler({
    maxActiveRuns: 4,
    maxActiveRunsPerTenant: 4,
});
const resourceCoordinator = new RunQueueCoordinator(
    runService,
    resourceScheduler,
    // 模拟显存吃紧：准入直接判 QUEUE
    new StubAdmission("QUEUE", "RESOURCE_BUSY_TENANT_LIMIT"),
);

function submitResource(tag: string) {
    const run = resourceCoordinator.submit({
        tenantId: "tenant-d",
        harnessSessionId: `session-${tag}`,
        userInput: tag,
        workspacePath: `/tmp/${tag}`,
    });
    labels.set(run.id, tag);
    return run;
}

line("M5 显存准入拒绝：槽位有空，但 GPU 判断现在不能起新推理进程");
submitResource("D1");
submitResource("D2");
const results = await resourceCoordinator.drain();
console.log(
    `\ndrain() 结果：${results.map((r) => r.kind).join(", ")}` +
    `（DEFERRED = 被准入挡回来，重新入队）`,
);
showBlockers("listQueueBlockers()", resourceScheduler);
console.log(
    `→ RESOURCE_BUSY：这次不是调度器的锅，是资源准入把 Run 退回来的，\n` +
    `  reasonCode 由 attemptNext 写入队列，再由 synchronizeQueueBlockers 落库。\n` +
    `  当前 QUEUE_BLOCKED 事件数 = ${eventCount()}`,
);

/* ---- 最终：落库事件时间线 ----------------------------------------- */

line("最终：run_events 表里真实落下的 QUEUE_BLOCKED 事件");

const rows = db
    .query(
        `select run_id, sequence, type, payload_json
         from run_events
         where type = 'QUEUE_BLOCKED'
         order by rowid`,
    )
    .all() as Array<{
        run_id: string;
        sequence: number;
        payload_json: string;
    }>;

console.table(
    rows.map((r) => {
        const payload = JSON.parse(r.payload_json) as Record<string, unknown>;
        return {
            run: labels.get(r.run_id) ?? r.run_id.slice(0, 8),
            seq: r.sequence,
            reasonCode: payload.reasonCode,
            pos: payload.position,
            tenantPos: payload.tenantPosition,
            active: payload.activeRunCount,
            activeTenant: payload.activeTenantRunCount,
        };
    }),
);

console.log(
    `\n合计 ${rows.length} 条。注意：A2/A3 各出现 2 次（TENANT → GLOBAL 的原因变化），\n` +
    `而每一次重复的 drain 都没有产生噪声事件 —— 这就是"blocker 是可查询证据"的意义。`,
);
