
// 并发上限配置
export interface TenantRunSchedulerConfig {
    maxActiveRuns: number;
    maxActiveRunsPerTenant: number;
    /**
     * N10：老化阈值（ms）。某个租户的队首 Run 等待超过该值时，它不再等
     * 轮转排到，而是直接插队优先调度——给「被洪泛租户挡在后面的正常租户」
     * 一个确定的等待上界。未配置 / <= 0 = 关闭（纯轮转，旧行为）。
     */
    agingMs?: number;
    /** 时钟注入（测试用），默认 Date.now。 */
    now?: () => number;
}

// 队列情况说明
export type QueueReasonCode =
    | "AWAITING_SCHEDULING"
    | "GLOBAL_CONCURRENCY_LIMIT"
    | "TENANT_CONCURRENCY_LIMIT"
    | "SESSION_SERIALIZATION"
    | "RESOURCE_BUSY"
    | "RESOURCE_CRITICAL"
    | "RESOURCE_UNKNOWN"
    | "RESOURCE_OBSERVATION_FAILED"
    | "TENANT_BUDGET_EXCEEDED"
    | "INSTANCE_NOT_READY";

// 队列里面的 Run 的格式要求
export interface EnqueueRunInput {
    runId: string;
    tenantId: string;
    /** Runs sharing a conversation must never be active concurrently. */
    sessionId?: string;
    reasonCode?: QueueReasonCode;
    enqueuedAt?: string;
}

export interface QueuedRun {
    runId: string;
    tenantId: string;
    sessionId?: string;
    reasonCode: QueueReasonCode;
    enqueuedAt: string;
}

export interface QueueEntry extends Omit<QueuedRun, "sessionId"> {
    position: number;
    tenantPosition: number;
}

export interface SchedulerCapacity {
    activeRunCount:number;
    activeTenantRunCount:number;
}

/**
 * A point-in-time explanation for a Run that remains queued. It is diagnostic
 * evidence, not a new scheduler decision: the scheduler continues to own the
 * actual claim/release transition.
 */
export interface QueueBlocker extends QueueEntry {
    reasonCode: QueueReasonCode;
    activeRunCount: number;
    activeTenantRunCount: number;
}

/**
 * 在 Tenant 之间公平选择 Run，并维护 Harness 的逻辑模型并发 slot。
 *
 * Scheduler 不负责 GPU 压力分类，也不负责 vLLM 内部 token 调度。
 */
export class TenantRunScheduler {
    private readonly queuesByTenant = new Map<string, QueuedRun[]>();
    private readonly tenantOrder: string[] = [];
    private readonly activeTenantByRunId = new Map<string, string>();
    private readonly activeSessionByRunId = new Map<string, string>();

    constructor(private readonly config: TenantRunSchedulerConfig) {
        assertPositiveInteger(config.maxActiveRuns, "maxActiveRuns");
        assertPositiveInteger(
            config.maxActiveRunsPerTenant,
            "maxActiveRunsPerTenant",
        );

        if (
            config.maxActiveRunsPerTenant
            > config.maxActiveRuns
        ) {
            throw new Error(
                "maxActiveRunsPerTenant 不能大于 maxActiveRuns",
            );
        }
    }

    enqueue(input: EnqueueRunInput): QueuedRun {
        if (this.activeTenantByRunId.has(input.runId)) {
            throw new Error(`Run 正在执行中：${input.runId}`);
        }

        if (this.findQueuedRun(input.runId) !== null) {
            throw new Error(`Run 已经在队列中：${input.runId}`);
        }

        const queuedRun: QueuedRun = {
            runId: input.runId,
            tenantId: input.tenantId,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            reasonCode:
                input.reasonCode ?? "AWAITING_SCHEDULING",
            enqueuedAt:
                input.enqueuedAt ?? new Date().toISOString(),
        };
        const tenantQueue = this.queuesByTenant.get(input.tenantId);

        if (tenantQueue === undefined) {
            this.queuesByTenant.set(input.tenantId, [queuedRun]);
            this.tenantOrder.push(input.tenantId);
        } else {
            tenantQueue.push(queuedRun);
        }

        return queuedRun;
    }

    private findQueuedRun(runId: string): QueuedRun | null {
        for (const queue of this.queuesByTenant.values()) {
            const run = queue.find((item) => item.runId === runId);

            if (run !== undefined) {
                return run;
            }
        }

        return null;
    }

    // 要从所有等待中的 Run 里公平地选择一个当前有资格启动的 Run，并立即为他保留一个逻辑并发 slot
    // 我们给定的返回值：
    /**
     * {
     *  runId:"A1",
     *  tenantId:"tenant-a",
     *  ...
     * }
     * 这代表的是 A1 已经离开等待队列，A1 已经占用一个 slot，调用方可以启动 A1
     */
    claimNext() : QueuedRun | null {
        // 首先检查全局 slot
        // 如果说当前活跃的 run 大于配置要求最大 run
        if (this.activeTenantByRunId.size >= this.config.maxActiveRuns){
            return null;
        }

        // N10：老化插队。先看有没有等太久的 Run，有就先调度它，
        // 避免正常租户被洪泛租户的轮转顺序挡住长尾（真机观察 215s）。
        const aged = this.claimAged();

        if (aged !== null) {
            return aged;
        }

        // 记录最多检查多少个tenant
        const tenantsToInspect = this.tenantOrder.length;

        for (
            let inspected = 0;
            inspected < tenantsToInspect;
            inspected += 1
        ) {
            // 从轮转队列头部取出本轮tenant
            const tenantId = this.tenantOrder.shift();

            // tenantOrder 已经为空，说明没有可以调度的tenant
            if (tenantId === undefined) {
                return null;
            }

            const tenantQueue = this.queuesByTenant.get(tenantId);

            // 正常情况下tenantOrder中的 tenant一定会有非空队列.
            if (
                tenantQueue === undefined || tenantQueue.length === 0
            )   {
                this.queuesByTenant.delete(tenantId);
                continue;
            }

            const activeTenantByRunCount = this.getActiveTenantRunCount(tenantId);

            // 当前 tenant 已经达到并发上限，它仍有等待任务，所以放回轮转队尾.
            if (activeTenantByRunCount >= this.config.maxActiveRunsPerTenant){
                this.tenantOrder.push(tenantId);
                continue;
            }

            const run = tenantQueue.shift();

            if (run === undefined){
                this.queuesByTenant.delete(tenantId);
                continue;
            }

            // A conversation is an ordered message stream. Keep the candidate
            // queued while an earlier Run from the same conversation is active.
            if (
                run.sessionId !== undefined
                && this.hasActiveSession(run.sessionId)
            ) {
                tenantQueue.unshift(run);
                this.tenantOrder.push(tenantId);
                continue;
            }

            // 如果这个 tenant 还有等待任务，那么将它放在下一轮队尾
            // 如果已经情况，那么就从queuesByTenant删除
            if (tenantQueue.length > 0){
                this.tenantOrder.push(tenantId);
            }   else {
                this.queuesByTenant.delete(tenantId);
            }
            
            this.activeTenantByRunId.set(
                run.runId,
                run.tenantId
            );
            if (run.sessionId !== undefined) {
                this.activeSessionByRunId.set(run.runId, run.sessionId);
            }
            return run;
        }
     
        // 有等待任务，但是所有tenant都达到了自己的并发上限;
        return null;
    }

    /**
     * N10：老化插队。扫描所有租户的队首，选出「等待时间最长、且已超过
     * agingMs」并当前有资格启动的 Run（未达本租户并发上限、无会话串行冲突）。
     * 没有任何 Run 超过阈值时返回 null，交由原有轮转逻辑处理（行为不变）。
     */
    private claimAged(): QueuedRun | null {
        const agingMs = this.config.agingMs ?? 0;

        if (agingMs <= 0) {
            return null;
        }

        const now = (this.config.now ?? Date.now)();
        let bestTenantId: string | null = null;
        let bestIndex = -1;
        let bestWaitedMs = agingMs;

        for (let index = 0; index < this.tenantOrder.length; index += 1) {
            const tenantId = this.tenantOrder[index];

            if (tenantId === undefined) {
                continue;
            }

            const tenantQueue = this.queuesByTenant.get(tenantId);
            const head = tenantQueue?.[0];

            if (tenantQueue === undefined || head === undefined) {
                continue;
            }

            if (
                this.getActiveTenantRunCount(tenantId)
                >= this.config.maxActiveRunsPerTenant
            ) {
                continue;
            }

            if (
                head.sessionId !== undefined
                && this.hasActiveSession(head.sessionId)
            ) {
                continue;
            }

            const waitedMs = now - Date.parse(head.enqueuedAt);

            if (!Number.isFinite(waitedMs) || waitedMs < bestWaitedMs) {
                continue;
            }

            bestTenantId = tenantId;
            bestIndex = index;
            bestWaitedMs = waitedMs;
        }

        if (bestTenantId === null || bestIndex < 0) {
            return null;
        }

        const queue = this.queuesByTenant.get(bestTenantId);
        const run = queue?.[0];

        if (queue === undefined || run === undefined) {
            return null;
        }

        this.tenantOrder.splice(bestIndex, 1);
        queue.shift();

        if (queue.length > 0) {
            this.tenantOrder.push(bestTenantId);
        } else {
            this.queuesByTenant.delete(bestTenantId);
        }

        this.activeTenantByRunId.set(run.runId, run.tenantId);

        if (run.sessionId !== undefined) {
            this.activeSessionByRunId.set(run.runId, run.sessionId);
        }

        return run;
    }

    private getActiveTenantRunCount(tenantId:string):number {
        let count = 0;

        for (
            const activeTenantId of this.activeTenantByRunId.values()
        ){
            if (activeTenantId === tenantId){
                count += 1;
            }
        }
        return count;
    }

    private hasActiveSession(sessionId: string): boolean {
        for (const activeSessionId of this.activeSessionByRunId.values()) {
            if (activeSessionId === sessionId) return true;
        }
        return false;
    }


    // 释放资源
    release(runId:string):boolean {
        // 释放指定 run 的 slot
        this.activeSessionByRunId.delete(runId);
        return this.activeTenantByRunId.delete(runId);
    }

    // 获取最大并发上限
    getCapacity(tenantId:string):SchedulerCapacity {
        return {
            activeRunCount : this.activeTenantByRunId.size,
            activeTenantRunCount : this.getActiveTenantRunCount(tenantId),
        }
    }

    removeQueued(runId:string):QueuedRun | null {
        // 遍历 tenant 队列
        for (const [tenantId,tenantQueue] of this.queuesByTenant.entries()) {
            const runIndex = tenantQueue.findIndex(
                (run) => run.runId === runId,
            );
            // 如果没有找到对应的runIndex
            if (runIndex === -1) {
                continue;
            }

            const [removedRun] = tenantQueue.splice(runIndex,1)
            if (removedRun === undefined) {
                return null;
            }

            // 清理空的tenant
            if (tenantQueue.length === 0){
                this.queuesByTenant.delete(tenantId);

                const tenantOrderIndex = this.tenantOrder.indexOf(tenantId);

                // 如果找到的话，那么就删除
                if (tenantOrderIndex !== -1){
                    this.tenantOrder.splice(tenantOrderIndex,1);
                }
            }
            return removedRun;
            
        }
        return null;
    }
    

    // 这个函数就是如何查看当前队列情况
    // 具体如下：
    /**
     * Tenant A: A1, A2, A3
     * Tenant B: B1, B2
     * tenantOrder : [A,B]
     * 
     * 公平的调度顺序应该是
     * A1->B1->A2
     * 
     * 我们下面的函数应该把这个顺序展示为
     * { runId:"A1", position:1,tenantPosition:1 },
     * { runId:"B1", position:2,tenantPosition:1 },
     * { runId:"A2", position:3,tenantPosition:2 },
     */
    // 我们要输出的就是两个位置,position和tenantPosition
    listQueue():QueueEntry[] {
        const queueCopies = new Map<string,QueuedRun[]>();

        for (
            const [tenantId,tenantQueue]
            of this.queuesByTenant.entries()
        )   {
            queueCopies.set(tenantId,[...tenantQueue]);
        }

        const tenantOrderCopy = [...this.tenantOrder];
        const entries:QueueEntry[] = [];
        const tenantPositions = new Map<string,number>();

        // 只要副本轮转队列还有tenant
        while (tenantOrderCopy.length > 0){
            const tenantId = tenantOrderCopy.shift();

            // 没有 tenant 了
            if (tenantId === undefined) {
                break;
            }

            // 查找对应的tenant的队列
            const tenantQueue = queueCopies.get(tenantId);

            if (tenantQueue === undefined || tenantQueue.length === 0){
                continue;
            }

            // 获取一个 run
            const run = tenantQueue.shift();
            if (run === undefined) {
                continue;
            }

            const tenantPosition = (tenantPositions.get(tenantId) ?? 0) + 1;
            tenantPositions.set(tenantId,tenantPosition);

            entries.push({
                runId: run.runId,
                tenantId: run.tenantId,
                reasonCode: run.reasonCode,
                enqueuedAt: run.enqueuedAt,
                position:entries.length + 1,
                tenantPosition,
            })

            if (tenantQueue.length > 0) {
                tenantOrderCopy.push(tenantId);
            }
        }

        return entries;
    }

    /**
     * Explain the current blocker for every queued Run without mutating queue
     * order or reserving a slot. Scheduler capacity reasons take precedence
     * over a previously stored resource-admission reason because they are the
     * immediate reason the Run cannot be claimed now.
     */
    listQueueBlockers(): QueueBlocker[] {
        const globalAtLimit =
            this.activeTenantByRunId.size >= this.config.maxActiveRuns;

        return this.listQueue().map((entry) => {
            const queued = this.findQueuedRun(entry.runId);
            const activeTenantRunCount = this.getActiveTenantRunCount(
                entry.tenantId,
            );
            let reasonCode = entry.reasonCode;

            if (globalAtLimit) {
                reasonCode = "GLOBAL_CONCURRENCY_LIMIT";
            } else if (
                activeTenantRunCount >= this.config.maxActiveRunsPerTenant
            ) {
                reasonCode = "TENANT_CONCURRENCY_LIMIT";
            } else if (
                queued?.sessionId !== undefined
                && this.hasActiveSession(queued.sessionId)
            ) {
                reasonCode = "SESSION_SERIALIZATION";
            }

            return {
                ...entry,
                reasonCode,
                activeRunCount: this.activeTenantByRunId.size,
                activeTenantRunCount,
            };
        });
    }

}


function assertPositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} 必须为正整数`);
    }
}
