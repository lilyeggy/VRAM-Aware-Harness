/**
 * 协调 scheduler,runService和resourceAdmissionServer
 * 1. scheduler 层面：什么时候选择
 * 2. runService 层面：选择以后让谁去执行
 */


import type {
    PolicyDecision,
} from "../resources/execution-policy.ts";
import type {
    ResourceAdmissionEvaluator,
} from "../resources/resource-admission-service.ts";
import type {
    AgentRun
}   from "../runs/agent-run.ts";

import type {
    RunService,
    StartRunInput,
    ResumeRunInput,
}   from "../runs/run-service.ts";

import type {
    QueueReasonCode,
    TenantRunScheduler,
}   from "./tenant-run-scheduler.ts";

import { InstanceSlotUnavailableError } from "../instances/harness-instance-store.ts";



export type CoordinatorResult =
    | {
        kind: "EMPTY";
    }
    | {
        kind: "DEFERRED";
        runId: string;
        decision: PolicyDecision;
    }
    | {
        kind: "EXECUTED";
        run: AgentRun;
        decision: PolicyDecision;
    };

export interface RunQueueCoordinatorOptions {
    /**
     * 支柱 3：排队 TTL（ms）。undefined 表示不启用排队超时熔断。
     */
    queueTtlMs?: number;
    /**
     * N19：同一 Run 允许因 INSTANCE_NOT_READY 重排的最大次数（默认 5）。
     *
     * 低于上限时按 N2 语义当作启动对账窗口的瞬态失败、下一轮重试；
     * 超过上限说明实例槽位结构性不可用，继续重排只会形成
     * INTERRUPTED↔QUEUED 活锁并反复创建/销毁沙箱，因此停止自动重排转人工。
     */
    maxInstanceNotReadyRetries?: number;
    /** 时钟（测试注入）。 */
    now?: () => number;
    /**
     * B4/B5：DB 侧 QUEUED Run 读取器（组合根传 runStore）。
     * 提供 后 reconcileQueuedRuns() 才能对账：把"DB 仍 QUEUED 但已脱离
     * 内存队列"的孤儿（claimNext 与 re-enqueue 之间崩溃等 TOCTOU 窗口）
     * 重新入队，并对超过 TTL 的 DB QUEUED Run 熔断——不依赖 pump 是否存活。
     */
    readonly queuedRunReader?: { listQueuedRuns(): readonly AgentRun[] };
}

export function toQueueReasonCode(
    decision: PolicyDecision,
): QueueReasonCode {
    if (decision.action !== "QUEUE") {
        throw new Error(
            `START 决策不能转换成排队原因：${decision.reasonCode}`,
        );
    }

    switch (decision.reasonCode) {
        case "GLOBAL_CONCURRENCY_LIMIT":
            return "GLOBAL_CONCURRENCY_LIMIT";
        case "RESOURCE_BUSY_TENANT_LIMIT":
            return "RESOURCE_BUSY";
        case "RESOURCE_CRITICAL":
            return "RESOURCE_CRITICAL";
        case "RESOURCE_UNKNOWN":
            return "RESOURCE_UNKNOWN";
        case "RESOURCE_OBSERVATION_FAILED":
            return "RESOURCE_OBSERVATION_FAILED";
        case "TENANT_BUDGET_EXCEEDED":
            return "TENANT_BUDGET_EXCEEDED";
        case "RESOURCE_NORMAL":
        case "RESOURCE_BUSY_TENANT_AVAILABLE":
            throw new Error(
                `START reason 不能作为排队原因：${decision.reasonCode}`,
            );
    }
}

export class RunQueueCoordinator  {
    constructor(
        private readonly runService:RunService,
        private readonly scheduler:TenantRunScheduler,
        private readonly admission: ResourceAdmissionEvaluator,
        private readonly pendingResumeByRunId = new Map<string,ResumeRunInput>(),
        private readonly lastQueueBlockerByRunId = new Map<string, QueueReasonCode>(),
        private drainPromise: Promise<CoordinatorResult[]> | null = null, // 当前是否有drain正在运行
        private drainRequested = false, // 正在运行期间，是否又收到了新的推进请求
        private readonly options: RunQueueCoordinatorOptions = {},
        /**
         * N19：同一 Run 因 INSTANCE_NOT_READY 被重新入队的次数。
         *
         * 该状态本意是"启动对账窗口里的瞬态"（N2），但实例槽位若**结构性**
         * 不可用（例如上次进程执行中被杀，实例停在 FAILED 且计数为 1），
         * 无界重排就会变成 INTERRUPTED↔QUEUED 活锁，而且每一轮失败的 RESUME
         * 都真实创建/销毁一个沙箱（真机实测泄漏 2 个容器）。
         * 因此必须有上限：超过即停止重排并转人工，把问题暴露出来而不是空转。
         */
        private readonly instanceNotReadyAttempts = new Map<string, number>(),
    ) {}

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

        for (const entry of this.scheduler.listQueue()) {
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
                tenantPosition: blocker.tenantPosition,
                activeRunCount: blocker.activeRunCount,
                activeTenantRunCount: blocker.activeTenantRunCount,
            });
            this.lastQueueBlockerByRunId.set(blocker.runId, blocker.reasonCode);
        }
    }
    // submit只负责把用户任务变成 run 队列
    submit(input:StartRunInput) : AgentRun {
        // 接收到用户任务输入后，创建对应持久化的Queued Run
        const run = this.runService.createQueuedRun(input);

        // 把对应的 run 入队
        this.scheduler.enqueue({
            runId:run.id,
            tenantId:run.tenantId,
            sessionId:run.harnessSessionId,
        })
        this.synchronizeQueueBlockers();

        // 返回 Queued Run
        return run;
    }

    restoreQueuedRun(run:AgentRun):AgentRun {
        if (run.status !== "QUEUED") {
            throw new Error(`只能恢复 QUEUED Run 到调度队列：${run.id}`);
        }

        this.scheduler.enqueue({
            runId:run.id,
            tenantId:run.tenantId,
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
                tenantId:run.tenantId,
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

    async attemptNext() : Promise<CoordinatorResult> {
        // 它做的是把一个等待中的 run 从队列里推进到运行状态，但是不管如何选
        // 如何选这个 run，是scheduler做的事
        // 最终控制流
        /**
         * 1. 没有 Run：Empty
         * 2. 资源拒绝：release -> 重新入队->deferred
         * 3. 资源允许: executeQueuedRun -> finally release -> executed
         */
        // scheduler选择一个 run出来
        const queuedRun = this.scheduler.claimNext();

        if (queuedRun === null) {
            this.synchronizeQueueBlockers();
            return {
                kind : "EMPTY",
            };
        }

        // 选出 run 的时候，run 已经离开队列并占用了 slot，所以需要更新资源情况
        const capacity = this.scheduler.getCapacity(queuedRun.tenantId);

        const admissionRequest = {
            runId : queuedRun.runId,
            tenantId : queuedRun.tenantId,
            activeRunCount : capacity.activeRunCount - 1,
            activeTenantRunCount : capacity.activeTenantRunCount - 1,
        }

        // 执行资源准入
        let admissionResult;

        
        try {
            // 进行资源情况评估
            admissionResult = await this.admission.evaluate(
                admissionRequest,
            );
        } catch (error) {
            this.scheduler.release(queuedRun.runId);

            // 重新入队，防止 admission 自身异常导致Run从内存队列中丢失
            this.scheduler.enqueue({
                runId : queuedRun.runId,
                tenantId : queuedRun.tenantId,
                ...(queuedRun.sessionId === undefined ? {} : { sessionId: queuedRun.sessionId }),
                reasonCode : "RESOURCE_OBSERVATION_FAILED",
                enqueuedAt : queuedRun.enqueuedAt,
            });
            this.synchronizeQueueBlockers();
            throw error;
        }

        // 获得资源评估结果
        const decision = admissionResult.decision;

        // 资源评估结果是仍然排队，也就是不执行，那么就release然后重新入队,deferred
        if (decision.action === "QUEUE") {
            const reasonCode = toQueueReasonCode(decision);

            this.scheduler.release(queuedRun.runId);
            // 顺序一定要是先release再 run，否则enqueue会认为 run 仍在执行并拒绝入队
            this.scheduler.enqueue({
                runId:queuedRun.runId,
                tenantId:queuedRun.tenantId,
                ...(queuedRun.sessionId === undefined ? {} : { sessionId: queuedRun.sessionId }),
                reasonCode,
                enqueuedAt:queuedRun.enqueuedAt,
            });
            this.synchronizeQueueBlockers();

            return {
                kind:"DEFERRED",
                runId:queuedRun.runId,
                decision,
            }
        }

        // 资源评估结果是执行 Run，那么就不排队了

        // 处理start决策
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

            // N19：本次执行真的启动了，清掉该 Run 的 INSTANCE_NOT_READY 计数，
            // 避免把一次成功之后的偶发瞬态累计成"耗尽"。
            this.instanceNotReadyAttempts.delete(queuedRun.runId);

            return {
                kind:"EXECUTED",
                run,
                decision,
            };
        } catch (error) {
            // N2：重启对账窗口里实例行 actual_state 尚未就绪，启动尝试是
            // 瞬态失败。识别后重新入队（下一轮 pump 重试），不再把异常栈
            // 抛进 pump 的 onError；其余错误维持原行为。
            if (error instanceof InstanceSlotUnavailableError) {
                const attempts =
                    (this.instanceNotReadyAttempts.get(queuedRun.runId) ?? 0) + 1;
                this.instanceNotReadyAttempts.set(queuedRun.runId, attempts);
                // 与 admission 失败路径一致：先 release 再 enqueue，
                // 否则 enqueue 会认为 Run 仍在执行而拒绝入队。
                this.scheduler.release(queuedRun.runId);

                const maxRetries = this.options.maxInstanceNotReadyRetries ?? 5;
                if (attempts > maxRetries) {
                    // N19：不再无界重排。走到这里说明实例槽位是**结构性**
                    // 不可用（不是启动窗口的瞬态），继续重排只会变成
                    // INTERRUPTED↔QUEUED 活锁，而且每轮失败的 RESUME 都会真实
                    // 创建/销毁一个沙箱。停止自动重排，把事实记下来交人工。
                    this.instanceNotReadyAttempts.delete(queuedRun.runId);
                    this.pendingResumeByRunId.delete(queuedRun.runId);
                    const message =
                        `实例槽位持续不可用，已停止自动重排并转人工：`
                        + `instanceId=${error.instanceId} 已重试 ${attempts - 1} 次`
                        + `（上限 ${maxRetries}）`;
                    console.error(`[N19] ${message} runId=${queuedRun.runId}`);
                    this.recordInstanceNotReadyExhausted(
                        queuedRun.runId,
                        error.instanceId,
                        attempts - 1,
                        maxRetries,
                    );
                    this.synchronizeQueueBlockers();
                    return {
                        kind:"DEFERRED",
                        runId:queuedRun.runId,
                        decision,
                    };
                }

                // N2：重启对账窗口里实例行 actual_state 尚未就绪，启动尝试是
                // 瞬态失败。识别后重新入队（下一轮 pump 重试），不再把异常栈
                // 抛进 pump 的 onError；其余错误维持原行为。
                console.warn(
                    `实例暂未就绪，Run 重新入队等待下一轮调度：${queuedRun.runId}（${error.instanceId}，第 ${attempts}/${maxRetries} 次）`,
                );
                this.scheduler.enqueue({
                    runId : queuedRun.runId,
                    tenantId : queuedRun.tenantId,
                    ...(queuedRun.sessionId === undefined ? {} : { sessionId: queuedRun.sessionId }),
                    reasonCode : "INSTANCE_NOT_READY",
                    enqueuedAt : queuedRun.enqueuedAt,
                });
                this.synchronizeQueueBlockers();
                return {
                    kind:"DEFERRED",
                    runId:queuedRun.runId,
                    decision,
                };
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
    
    /**
     * N19：把"实例槽位已耗尽重试、转人工"这件事落成可查的 Run 事实。
     *
     * 不静默：Run 若已经离开 QUEUED（恢复路径会先置 RUNNING），
     * `failQueuedRun`/`recordQueueBlocked` 会按状态机拒绝，属预期；
     * 此时至少保证有 error 级日志，不会像修复前那样无声空转。
     */
    private recordInstanceNotReadyExhausted(
        runId: string,
        instanceId: string,
        attempted: number,
        maxRetries: number,
    ): void {
        const payload = {
            reason: "INSTANCE_NOT_READY_RETRY_EXHAUSTED",
            instanceId,
            attempted,
            maxRetries,
            note: "实例槽位结构性不可用，已停止自动重排，需人工处理后手动恢复",
        };
        try {
            this.runService.recordQueueBlocked(runId, payload);
        } catch (recordError) {
            console.error(
                `[N19] 写入实例槽位耗尽事实失败：runId=${runId}`,
                recordError,
            );
        }
    }

    private async drainOnce():Promise<CoordinatorResult[]> {
        // 支柱 3：先熔断排队超时的 Run，再推进队列。
        this.enforceQueueTtl();

        // B4/B5：DB 对账——补回脱离内存队列的孤儿 QUEUED Run，并对
        // DB 侧超 TTL 的 Run 熔断（不依赖内存队列是否还有它）。
        this.reconcileQueuedRuns();

        const errors:unknown[] = [];
        // 看看当前有多少要处理的请求
        let remainingAttempts = this.scheduler.listQueue().length;

        const results : CoordinatorResult[] = [];

        // 只要还有请求，那么就交给attemptNext去执行
        while(remainingAttempts > 0) {
            const roundPromises = Array.from(
                { length : remainingAttempts },
                () => this.attemptNext(),
            );

            const settledResults = await Promise.allSettled(roundPromises);

            let inspectedCount = 0;

            for (const settledResult of settledResults) {
                if (settledResult.status === "rejected"){
                    errors.push(settledResult.reason);
                    inspectedCount += 1;
                    continue;
                }

                if (settledResult.value.kind !== "EMPTY"){
                    results.push(settledResult.value);
                    inspectedCount += 1;
                }
            }

            if (inspectedCount === 0){
                break;
            }
            remainingAttempts -= inspectedCount;
        }
        if (errors.length === 1){
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(
                errors,
                "多个队列调度尝试执行失败",
            )
        }
        return results;
    }

    private async runDrainLoop():Promise<CoordinatorResult[]> {
        const results: CoordinatorResult[] = [];
        try {
            while(this.drainRequested) {
                // 消费掉当前的请求
                this.drainRequested = false;
                const passResults = await this.drainOnce();
                results.push(...passResults);

                // 如果 drainonce 执行期间又有人调用drain(),
                // drainRequested会重新变成 true，继续下一轮
            }

            return results;
        } finally{
            this.drainPromise = null;
        }
    }



    // attemptNext是单次调用，它只处理一个 run，它的核心思路是选择一个 run，检查资源，然后判断能否执行
    // drain 是会反复调用attemptNext的，它会推进当前队列

    // drain 的主要职责是：1. 遍历当前队列并尽可能启动 Run； 2. 处理多个地方同时发起的 drain 请求
    // drain 是负责“当前有空位，看看哪些 run 可以启动的”
    // attemptNext就是调度一个 run
    drain() : Promise<CoordinatorResult[]> {
        // 每次调用都代表系统状态可能发生了变化
        // 因此至少请求进行一轮队列检查
        this.drainRequested = true;

        // 已经有drain在执行，重复用同一个Promise
        if (this.drainPromise !== null){
            return this.drainPromise;
        }

        // 没有 drain 执行，就启动新的推进循环
        this.drainPromise = this.runDrainLoop();
        return this.drainPromise;
    }

    // drain是这样的：
    // 第一次 drain：创建drainPromise 
    // 开始 drainOnce()

    // 执行过程中第二次drain()
    // -> drainRequested = true
    // 不创建第二个循环
    // 返回现有drainPromise



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
                tenantId:run.tenantId,
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
