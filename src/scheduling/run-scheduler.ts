/**
 * 协调 scheduler 与 runService：
 * 1. scheduler 层面：什么时候选择哪个 Run；
 * 2. runService 层面：选择以后让谁去执行。
 *
 * 资源观测/分类/策略准入层已整体移除：宿主层只负责准入（并发上限）、
 * 调度、隔离与溯源，不再对平台外模型服务做本地资源压力推断。
 */


import type {
    AgentRun
}   from "../runs/agent-run.ts";

import type {
    RunService,
    StartRunInput,
    ResumeRunInput,
}   from "../runs/run-service.ts";
import { buildRecoveryContinuationInput } from "../runs/run-service.ts";
import type { CheckpointStore } from "../checkpoints/checkpoint-store.ts";
import type { RunEvent } from "../runs/agent-run.ts";
import type { RunLeaseManager } from "../runs/run-lease-manager.ts";
import type { RunStore } from "../runs/runstore.ts";

import type {
    QueuedRun,
    QueueReasonCode,
    UserRunScheduler,
}   from "./user-run-scheduler.ts";



export type SchedulerDrainResult =
    | {
        kind: "EMPTY";
    }
    | {
        kind: "EXECUTED";
        run: AgentRun;
    };

/**
 * §9.8 v1.4 Phase 2：队列深度 backpressure。submit 在创建 Run 之前
 * 检查全局/用户排队深度，超限直接拒绝，避免队列无限增长。
 */
export class QueueBackpressureError extends Error {
    constructor(
        message: string,
        readonly scope: "GLOBAL" | "USER",
        readonly limit: number,
        readonly current: number,
        readonly retryAfterSeconds: number,
    ) {
        super(message);
        this.name = "QueueBackpressureError";
    }
}

export interface RunSchedulerOptions {
    /**
     * 支柱 3：排队 TTL（ms）。undefined 表示不启用排队超时熔断。
     */
    queueTtlMs?: number;
    /** §9.8 v1.4 Phase 2：全局排队深度上限，超限 submit 抛 QueueBackpressureError。 */
    readonly maxQueuedRuns?: number;
    /** §9.8 v1.4 Phase 2：单用户排队深度上限，超限 submit 抛 QueueBackpressureError。 */
    readonly maxQueuedRunsPerUser?: number;
    /** 时钟（测试注入）。 */
    now?: () => number;
    /**
     * B4/B5：DB 侧 QUEUED Run 读取器（组合根传 runStore）。
     * 提供 后 reconcileQueuedRuns() 才能对账：把"DB 仍 QUEUED 但已脱离
     * 内存队列"的孤儿（claimNext 与 re-enqueue 之间崩溃等 TOCTOU 窗口）
     * 重新入队，并对超过 TTL 的 DB QUEUED Run 熔断——不依赖 pump 是否存活。
     */
    readonly queuedRunReader?: { listQueuedRuns(): readonly AgentRun[] };
    /** 启动恢复：读取 QUEUED Run 与事件。 */
    readonly runStoreForRecovery?: Pick<RunStore, "listQueuedRuns" | "findLastEventByType">;
    /** 启动恢复：读取 Checkpoint。 */
    readonly checkpointStoreForRecovery?: Pick<CheckpointStore, "get">;
    /** 自动轮询间隔；未设置时只能手动 tick()。 */
    readonly intervalMs?: number;
    /**
     * DB 对账（孤儿 QUEUED 回填 + TTL 熔断）的最小间隔，默认 5s。
     * 稳态下不必每次推进都查库。
     */
    readonly reconcileIntervalMs?: number;
    /** 自动轮询异常回调。 */
    readonly onError?: (error: unknown) => void;
    /**
     * §9.8 v1.4 Phase 2：租约回收器。pump 每次 tick 与启动恢复时扫描
     * 过期 RUNNING Attempt，避免死执行器永久占用 slot。
     */
    readonly leaseManager?: RunLeaseManager;
}

export interface QueuedRunRestoreTarget {
    restoreQueuedRun(run: AgentRun): AgentRun;
    restoreQueuedResume(run: AgentRun, input: ResumeRunInput): AgentRun;
}

export function restoreQueuedRunInputs(
    runStore: Pick<RunStore, "listQueuedRuns" | "findLastEventByType">,
    checkpointStore: Pick<CheckpointStore, "get">,
    target: QueuedRunRestoreTarget,
): void {
    for (const run of runStore.listQueuedRuns()) {
        const checkpointId = getRecoveryCheckpointId(
            runStore.findLastEventByType(run.id, "RUN_QUEUED"),
        );
        if (checkpointId === null) {
            target.restoreQueuedRun(run);
            continue;
        }

        const checkpoint = checkpointStore.get(checkpointId);
        if (checkpoint === null || checkpoint.runId !== run.id) {
            throw new Error(`QUEUED 恢复任务缺少有效 Checkpoint：${run.id}`);
        }
        target.restoreQueuedResume(run, {
            runId: run.id,
            checkpoint,
            continuationInput: buildRecoveryContinuationInput(
                run.userInput,
                checkpoint.id,
            ),
        });
    }
}

function getRecoveryCheckpointId(
    queuedEvent: RunEvent | null,
): string | null {
    if (
        queuedEvent === null
        || typeof queuedEvent.payload !== "object"
        || queuedEvent.payload === null
    ) {
        return null;
    }

    const payload = queuedEvent.payload as Record<string, unknown>;
    return payload.reason === "AUTO_RECOVERY"
        && typeof payload.checkpointId === "string"
        ? payload.checkpointId
        : null;
}

export class RunScheduler  {
    constructor(
        private readonly runService:RunService,
        private readonly scheduler:UserRunScheduler,
        private readonly options: RunSchedulerOptions = {},
    ) {}

    private readonly pendingResumeByRunId = new Map<string,ResumeRunInput>();
    private readonly lastQueueBlockerByRunId = new Map<string, QueueReasonCode>();
    /** 当前正在执行的推进循环；同一时刻只允许一个。 */
    private activePass: Promise<SchedulerDrainResult[]> | null = null;
    /** 推进期间又收到推进请求：当前轮结束后再跑一轮。 */
    private rerunRequested = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    /** kick() 在批次之外独立派发的 attempt（stopAndDrain 需要等它们收尾）。 */
    private readonly inlineDispatches = new Set<Promise<void>>();
    /** 上次 reconcile 的时间：DB 对账按低频兜底，不必每次推进都查库。 */
    private lastReconcileAt = 0;

    start(): void {
        if (this.timer !== null || this.options.intervalMs === undefined) return;
        this.timer = setInterval(() => {
            void this.tick();
        }, this.options.intervalMs);
        void this.tick();
    }

    stop(): void {
        if (this.timer === null) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    async stopAndDrain(): Promise<void> {
        this.stop();
        while (this.activePass !== null || this.inlineDispatches.size > 0) {
            if (this.activePass !== null) {
                await this.activePass;
            }
            await this.waitForInlineDispatches();
        }
    }

    private async waitForInlineDispatches(): Promise<void> {
        while (this.inlineDispatches.size > 0) {
            await Promise.allSettled([...this.inlineDispatches]);
        }
    }

    /**
     * 不等待当前 drain 批次，直接尝试推进一个可 claim 的 Run。
     *
     * drainOnce 会等待本批次所有 Run 执行结束才处理下一批；
     * HTTP 提交等场景下，后到的 Run 若继续走 drain，会被批次屏障
     * 串行化。提交后调用 kick()，让 attemptNext 在当前批次之外
     * 独立抢一个 slot，从而让不同批次也能并发。
     */
    kick(): void {
        this.enforceQueueTtl();
        const attempt = (async () => {
            try {
                await this.attemptNext();
            } catch (error) {
                this.options.onError?.(error);
            }
        })();
        this.inlineDispatches.add(attempt);
        void attempt.finally(() => {
            this.inlineDispatches.delete(attempt);
        });
    }

    async tick(): Promise<void> {
        try {
            this.options.leaseManager?.reapExpired();
            await this.drain();
            await this.waitForInlineDispatches();
        } catch (error) {
            this.options.onError?.(error);
        }
    }

    /**
     * 支柱 3：一级排队超时（Queue TTL）。
     *
     * 每次 drain 前扫描队列：Run 等待时间（enqueuedAt 起，含多次准入
     * 重排的累计等待）超过 queueTtlMs 且仍未获得调度准入时，把它从
     * 队列摘除并经状态机安全流转到 FAILED（QUEUE_TIMEOUT），同时清理
     * 排队计数与待恢复输入，杜绝任务永久饥饿死等、排队计数泄漏。
     */
    private enforceQueueTtl(): void {
        const queueTtlMs = this.options.queueTtlMs;
        if (queueTtlMs === undefined) {
            return;
        }
        const nowMs = this.options.now?.() ?? Date.now();

        // 用 blocker 视图而不是裸队列：只有"资源/并发"类阻塞才算饥饿。
        // 会话串行是 session 锁，等自己会话的前序 Run 属于合法等待，不能被
        // QUEUE_TIMEOUT 熔断（默认 5min < 执行超时 30min，否则追问必被误杀）。
        for (const entry of this.scheduler.listQueueBlockers()) {
            if (entry.reasonCode === "SESSION_SERIALIZATION") {
                continue;
            }

            const enqueuedAtMs = Date.parse(entry.enqueuedAt);
            if (
                !Number.isFinite(enqueuedAtMs)
                || nowMs - enqueuedAtMs <= queueTtlMs
            ) {
                continue;
            }

            // 先把状态机事实落库（QUEUED -> FAILED），成功后再摘除排队
            // 条目释放 slot；若落 FAILED 失败则保留排队，下一轮 TTL 重试。
            try {
                this.runService.failQueuedRun(
                    entry.runId,
                    "QUEUE_TIMEOUT",
                    `排队超时：Run 已在队列等待 ${nowMs - enqueuedAtMs}ms，超过 queueTtlMs=${queueTtlMs} 门限`,
                    { waitedMs: nowMs - enqueuedAtMs, queueTtlMs },
                );
            } catch (error) {
                console.error(`排队超时熔断失败：${entry.runId}`, error);
                continue;
            }
            this.scheduler.removeQueued(entry.runId);
            this.pendingResumeByRunId.delete(entry.runId);
        }
    }

    /**
     * Materialize scheduler-only blocking facts into each queued Run timeline.
     * The Pump may call drain repeatedly, so equal consecutive reasons are
     * intentionally collapsed. A later reason change is retained as a new
     * event, which preserves a useful causal timeline without event flooding.
     */
    private synchronizeQueueBlockers(): void {
        const blockers = this.scheduler.listQueueBlockers();
        const queuedRunIds = new Set(blockers.map((blocker) => blocker.runId));

        for (const runId of this.lastQueueBlockerByRunId.keys()) {
            if (!queuedRunIds.has(runId)) {
                this.lastQueueBlockerByRunId.delete(runId);
            }
        }

        for (const blocker of blockers) {
            // Normal queue residency is already represented by RUN_CREATED /
            // RUN_QUEUED. Persist only a concrete blocker that explains why
            // this Run cannot advance right now.
            if (blocker.reasonCode === "AWAITING_SCHEDULING") {
                continue;
            }
            if (this.lastQueueBlockerByRunId.get(blocker.runId) === blocker.reasonCode) {
                continue;
            }

            this.runService.recordQueueBlocked(blocker.runId, {
                reasonCode: blocker.reasonCode,
                position: blocker.position,
                userPosition: blocker.userPosition,
                activeRunCount: blocker.activeRunCount,
                activeUserRunCount: blocker.activeUserRunCount,
            });
            this.lastQueueBlockerByRunId.set(blocker.runId, blocker.reasonCode);
        }
    }
    restoreQueuedRuns(): void {
        const runStore = this.options.runStoreForRecovery;
        const checkpointStore = this.options.checkpointStoreForRecovery;
        if (runStore === undefined || checkpointStore === undefined) {
            throw new Error("RunScheduler 未配置启动恢复所需的 runStore/checkpointStore");
        }
        restoreQueuedRunInputs(runStore, checkpointStore, this);
    }

    restore(): void {
        this.options.leaseManager?.reapExpired();
        this.restoreQueuedRuns();
    }

    /**
     * §9.8 v1.4 Phase 2：回收器判定租约过期后，释放该 Run 的调度 slot。
     * 幂等；Run 已不在活跃集合时返回 false。
     */
    releaseLease(runId: string): boolean {
        return this.scheduler.release(runId);
    }

    // submit只负责把用户任务变成 run 队列
    submit(input:StartRunInput) : AgentRun {
        // §9.8 v1.4 Phase 3：幂等键命中时直接返回既有 Run，不重复入队、
        // 也不应被 backpressure 拒绝——重放同一请求是客户端重试语义。
        if (input.idempotencyKey !== undefined) {
            const existing = this.runService.findByUserIdempotencyKey(
                input.userId,
                input.idempotencyKey,
            );
            if (existing !== null) {
                this.runService.assertIdempotentBinding(existing, input);
                return existing;
            }
        }

        // §9.8 v1.4 Phase 2：先做队列深度 backpressure，再创建 Run。
        this.assertQueueCapacity(input.userId);

        // 接收到用户任务输入后，创建对应持久化的Queued Run
        const run = this.runService.createQueuedRun(input);

        // 并发同键请求的唯一约束竞态：createQueuedRun 会回查并返回既有 Run；
        // 若它已经在执行或已在内存队列中，则不重复入队。
        if (!this.scheduler.isActive(run.id) && !this.scheduler.isQueued(run.id)) {
            // 把对应的 run 入队
            this.scheduler.enqueue({
                runId:run.id,
                userId:run.userId,
                sessionId:run.harnessSessionId,
                            })
        }
        this.synchronizeQueueBlockers();

        // 返回 Queued Run
        return run;
    }

    private assertQueueCapacity(userId: string): void {
        const maxQueuedRuns = this.options.maxQueuedRuns;
        const maxQueuedRunsPerUser = this.options.maxQueuedRunsPerUser;

        if (maxQueuedRuns === undefined && maxQueuedRunsPerUser === undefined) {
            return;
        }

        const queue = this.scheduler.listQueue();

        if (maxQueuedRuns !== undefined && queue.length >= maxQueuedRuns) {
            throw new QueueBackpressureError(
                `全局排队深度已达上限：${queue.length}/${maxQueuedRuns}`,
                "GLOBAL",
                maxQueuedRuns,
                queue.length,
                5,
            );
        }

        if (maxQueuedRunsPerUser !== undefined) {
            const userQueued = queue.filter(
                (entry) => entry.userId === userId,
            ).length;

            if (userQueued >= maxQueuedRunsPerUser) {
                throw new QueueBackpressureError(
                    `用户 ${userId} 排队深度已达上限：${userQueued}/${maxQueuedRunsPerUser}`,
                    "USER",
                    maxQueuedRunsPerUser,
                    userQueued,
                    5,
                );
            }
        }
    }

    restoreQueuedRun(run:AgentRun):AgentRun {
        if (run.status !== "QUEUED") {
            throw new Error(`只能恢复 QUEUED Run 到调度队列：${run.id}`);
        }

        this.scheduler.enqueue({
            runId:run.id,
            userId:run.userId,
            sessionId:run.harnessSessionId,
                        // B4：排队时间取 DB updatedAt（进入/回到 QUEUED 的时刻），
            // 重启恢复不重置 TTL 时钟，等待时间跨重启累计。
            enqueuedAt:run.updatedAt,
        });
        this.synchronizeQueueBlockers();

        return run;
    }

    /**
     * B4/B5：队列对账（每次 drain 与启动恢复后都可安全重放）。
     *
     * 1. DB 中 QUEUED 但不在内存队列的 Run（claimNext 与 release+re-enqueue
     *    之间崩溃、executeQueuedRun 启动前抛错等 TOCTOU 归档窗口的孤儿）
     *    重新入队，enqueuedAt 取 DB updatedAt；
     * 2. 对超过 queueTtlMs 的 DB QUEUED Run（无论是否在内存队列）执行
     *    FAILED(QUEUE_TIMEOUT) 熔断——即使 pump 已停，下一次 drain/重启也会补上。
     */
    reconcileQueuedRuns(): { requeued: string[]; timedOut: string[] } {
        const reader = this.options.queuedRunReader;
        const requeued: string[] = [];
        const timedOut: string[] = [];
        if (reader === undefined) {
            return { requeued, timedOut };
        }

        const nowMs = this.options.now?.() ?? Date.now();
        const queueTtlMs = this.options.queueTtlMs;
        const queuedInMemory = new Set(
            this.scheduler.listQueue().map((entry) => entry.runId),
        );

        for (const run of reader.listQueuedRuns()) {
            if (run.status !== "QUEUED") {
                continue;
            }

            // 已被 claim、正在执行的 Run 不在内存等待队列，但 DB 可能仍处于
            // QUEUED 的短暂窗口；不能把它当孤儿重新入队（enqueue 会抛
            // "Run 正在执行中"）。
            if (this.scheduler.isActive(run.id)) {
                continue;
            }

            // §9.8 v1.4 Phase 3：退避重试未到点的 QUEUED Run 先不入队。
            if (run.retryAt != null && run.retryAt != undefined) {
                const retryAtMs = Date.parse(run.retryAt);
                if (Number.isFinite(retryAtMs) && retryAtMs > nowMs) {
                    continue;
                }
            }

            const enqueuedAtMs = Date.parse(run.updatedAt);
            const waitedMs = Number.isFinite(enqueuedAtMs)
                ? nowMs - enqueuedAtMs
                : 0;

            if (
                queueTtlMs !== undefined
                && waitedMs > queueTtlMs
            ) {
                try {
                    this.runService.failQueuedRun(
                        run.id,
                        "QUEUE_TIMEOUT",
                        `排队超时：Run 已在队列等待 ${waitedMs}ms，超过 queueTtlMs=${queueTtlMs} 门限`,
                        { waitedMs, queueTtlMs, source: "RECONCILE" },
                    );
                } catch (error) {
                    console.error(`排队超时熔断失败：${run.id}`, error);
                    continue;
                }
                this.scheduler.removeQueued(run.id);
                this.pendingResumeByRunId.delete(run.id);
                timedOut.push(run.id);
                continue;
            }

            if (queuedInMemory.has(run.id)) {
                continue;
            }

            this.scheduler.enqueue({
                runId:run.id,
                userId:run.userId,
                sessionId:run.harnessSessionId,
                                enqueuedAt:run.updatedAt,
            });
            requeued.push(run.id);
        }

        if (requeued.length > 0 || timedOut.length > 0) {
            this.synchronizeQueueBlockers();
        }

        return { requeued, timedOut };
    }

    /**
     * 先释放已 claim 的 slot，再带原因重新入队并同步 blocker；调用顺序不能反。
     * 现在只用于执行异常回退（AWAITING_SCHEDULING），不再表达资源拒绝。
     */
    private requeueClaimed(run: QueuedRun, reasonCode: QueueReasonCode): void {
        this.scheduler.release(run.runId);
        this.scheduler.enqueue({
            runId: run.runId,
            userId: run.userId,
            ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
            reasonCode,
            enqueuedAt: run.enqueuedAt,
        });
        this.synchronizeQueueBlockers();
    }

    async attemptNext() : Promise<SchedulerDrainResult> {
        // 调度器选择并保留一个 slot 后，直接执行；不再有第二道资源准入。
        const queuedRun = this.scheduler.claimNext();

        if (queuedRun === null) {
            this.synchronizeQueueBlockers();
            return {
                kind : "EMPTY",
            };
        }

        const resumeInput = this.pendingResumeByRunId.get(queuedRun.runId);
        try {
            const run =
            resumeInput === undefined
            ? await this.runService.executeQueuedRun(
                queuedRun.runId,
            )
            : await this.runService.executeQueuedResume(
                resumeInput,
            );

            return {
                kind:"EXECUTED",
                run,
            };
        } catch (error) {
            // 执行前异常（例如快照/落库失败）可能让 DB 仍停在 QUEUED，
            // 但 Run 已经离开内存队列。重新入队避免丢失；已进入终态或
            // INTERRUPTED 的 Run 不再入队，交给恢复流程处理。
            const current = this.runService.getRun(queuedRun.runId);
            if (current === null || current.status === "QUEUED") {
                this.requeueClaimed(queuedRun, "AWAITING_SCHEDULING");
            }
            // 标记失败的 Run，drain 据此判断是否要在同一轮立刻补位重试。
            if (error !== null && typeof error === "object") {
                (error as { failedRunId?: string }).failedRunId =
                    queuedRun.runId;
            }
            throw error;
        } finally {
            if (resumeInput !== undefined){
                this.pendingResumeByRunId.delete(queuedRun.runId);
            }
            // 什么情况下释放 slot？run 完成、失败、runtime 启动抛错、event处理抛错
            this.scheduler.release(queuedRun.runId);
        }
    }
    
    private async drainOnce():Promise<SchedulerDrainResult[]> {
        // 支柱 3：先熔断排队超时的 Run，再推进队列。
        this.enforceQueueTtl();

        const errors: unknown[] = [];
        const results: SchedulerDrainResult[] = [];
        const pending = new Set<Promise<SchedulerDrainResult>>();

        const launchOne = (): void => {
            const attempt = this.attemptNext();
            pending.add(attempt);
            void attempt.then(
                (result) => {
                    if (result.kind !== "EMPTY") {
                        results.push(result);
                    }
                },
                (error) => {
                    errors.push(error);
                },
            ).finally(() => {
                pending.delete(attempt);
            });
        };

        // 初始按队列深度铺开；claimNext 会按全局 slot / 用户公平份额自然限流。
        const initialAttempts = this.scheduler.listQueue().length;
        // 异常补位预算：最坏情况下每条初次尝试只额外重试一次，避免
        // "执行一直失败 -> 一直补位" 的忙等。
        let retryBudget = initialAttempts;
        for (let index = 0; index < initialAttempts; index += 1) {
            launchOne();
        }

        // B4/B5：DB 对账按低频兜底，避免每次推进都查库。
        const nowMs = this.options.now?.() ?? Date.now();
        const reconcileIntervalMs = this.options.reconcileIntervalMs ?? 5_000;

        if (nowMs - this.lastReconcileAt >= reconcileIntervalMs) {
            this.lastReconcileAt = nowMs;
            this.reconcileQueuedRuns();
        }

        // 批屏障修复：谁先结束就先补谁。空出一个 slot 就立刻再 claim 一个，
        // 不再等本轮最慢的 Run 结束（旧实现是 Promise.allSettled 整批等待）。
        while (pending.size > 0) {
            const settled = await Promise.race(
                [...pending].map((attempt) => attempt.then(
                    (result) => ({ attempt, result, error: null as unknown }),
                    (error) => ({ attempt, result: null, error }),
                )),
            );

            pending.delete(settled.attempt);

            // 成功结束或异常结束都会释放 slot，两种都要补位；
            // EMPTY 表示没抢到 slot（容量满/无队列），不补，避免空转。
            if (this.scheduler.listQueue().length === 0) {
                continue;
            }

            if (settled.result === null) {
                if (retryBudget <= 0) {
                    continue;
                }

                // 同一个 Run 不在同一轮里立即重试（否则执行一直失败会忙等）；
                // 把它留给下一轮 drain/tick，并先推进队列里的其它 Run。
                const failedRunId = (settled.error as {
                    failedRunId?: string;
                } | null)?.failedRunId;
                const headRunId = this.scheduler.listQueue()[0]?.runId;

                if (failedRunId !== undefined && failedRunId === headRunId) {
                    continue;
                }

                retryBudget -= 1;
                launchOne();
                continue;
            }

            if (settled.result.kind !== "EMPTY") {
                launchOne();
            }
        }

        if (errors.length === 1) {
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(
                errors,
                "多个队列调度尝试执行失败",
            );
        }
        return results;
    }

    /**
     * 唯一的推进循环：跑一轮 drainOnce；期间若又收到推进请求，再跑一轮。
     * 同一时刻只允许一个循环，避免两个循环重复 claim。
     */
    private async runPass(): Promise<SchedulerDrainResult[]> {
        const results: SchedulerDrainResult[] = [];

        try {
            do {
                this.rerunRequested = false;
                const passResults = await this.drainOnce();
                results.push(...passResults);
            } while (this.rerunRequested);

            return results;
        } finally {
            this.activePass = null;
        }
    }

    // attemptNext是单次调用，它只处理一个 run，它的核心思路是选择一个 run，检查资源，然后判断能否执行
    // drain 是会反复调用attemptNext的，它会推进当前队列

    // drain 的主要职责是：1. 遍历当前队列并尽可能启动 Run； 2. 处理多个地方同时发起的 drain 请求
    // drain 是负责“当前有空位，看看哪些 run 可以启动的”
    // attemptNext就是调度一个 run
    /**
     * 请求推进一次。已有推进在跑时只做标记（复用同一个 Promise），
     * 等当前轮结束后自动再跑一轮。
     */
    drain() : Promise<SchedulerDrainResult[]> {
        if (this.activePass !== null) {
            this.rerunRequested = true;
            return this.activePass;
        }

        const pass = this.runPass();
        this.activePass = pass;
        return pass;
    }

    submitResume(input:ResumeRunInput) : AgentRun {
        const run = this.runService.queueResume(input);

        return this.restoreQueuedResume(run,input);
    }

    restoreQueuedResume(
        run:AgentRun,
        input:ResumeRunInput,
    ):AgentRun {
        if (run.status !== "QUEUED") {
            throw new Error(
                `只能恢复 QUEUED Run 的恢复调度：${run.id}`,
            );
        }

        if (
            input.runId !== run.id
            || input.checkpoint.runId !== run.id
            || run.checkpointId !== input.checkpoint.id
        ) {
            throw new Error(
                `恢复输入与 QUEUED Run 不匹配：${run.id}`,
            );
        }

        this.pendingResumeByRunId.set(run.id,input);

        try {
            this.scheduler.enqueue({
                runId:run.id,
                userId:run.userId,
                sessionId:run.harnessSessionId,
                                // B4：与 restoreQueuedRun 一致，重启/恢复不重置 TTL 时钟。
                enqueuedAt:run.updatedAt,
            });
        } catch (error) {
            this.pendingResumeByRunId.delete(run.id);
            throw error;
        }

        this.synchronizeQueueBlockers();

        return run;
    }

    async interrupt(runId:string) : Promise<AgentRun> {
        this.scheduler.removeQueued(runId);
        this.pendingResumeByRunId.delete(runId);

        return this.runService.interrupt(runId);
    }
    
}
