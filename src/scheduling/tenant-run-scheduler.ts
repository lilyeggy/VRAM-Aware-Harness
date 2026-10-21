
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
    | "SESSION_SERIALIZATION";

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
    /** runId → QueuedRun 索引，避免 findQueuedRun 全队列线性扫描。 */
    private readonly queuedRunByRunId = new Map<string, QueuedRun>();
    /** tenantId → 活跃 Run 数，随 claim/release 增量维护。 */
    private readonly activeCountByTenant = new Map<string, number>();
    /** 当前有活跃 Run 的会话集合，随 claim/release 增量维护。 */
    private readonly activeSessionIds = new Set<string>();

    constructor(private readonly config: TenantRunSchedulerConfig) {
        assertPositiveInteger(config.maxActiveRuns, "maxActiveRuns");

        // 0 = 自动公平份额（maxActiveRuns 除以有需求租户数）。
        assertNonNegativeInteger(
            config.maxActiveRunsPerTenant,
            "maxActiveRunsPerTenant",
        );

        if (
            config.maxActiveRunsPerTenant > 0
            && config.maxActiveRunsPerTenant
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
            tenantQueue.sort(compareQueuedRuns);
        }

        this.queuedRunByRunId.set(queuedRun.runId, queuedRun);

        return queuedRun;
    }

    isQueued(runId: string): boolean {
        return this.queuedRunByRunId.has(runId);
    }

    private findQueuedRun(runId: string): QueuedRun | null {
        return this.queuedRunByRunId.get(runId) ?? null;
    }

    /** claim 成功后登记活跃 slot，并同步维护派生索引。 */
    private activate(run: QueuedRun): void {
        this.queuedRunByRunId.delete(run.runId);
        this.activeTenantByRunId.set(run.runId, run.tenantId);
        this.activeCountByTenant.set(
            run.tenantId,
            (this.activeCountByTenant.get(run.tenantId) ?? 0) + 1,
        );
        if (run.sessionId !== undefined) {
            this.activeSessionByRunId.set(run.runId, run.sessionId);
            this.activeSessionIds.add(run.sessionId);
        }
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
        // 全局 slot 已满：任何人都不能 claim。
        if (this.activeTenantByRunId.size >= this.config.maxActiveRuns) {
            return null;
        }

        // 老化优先：给"等太久"的 Run 一个确定的等待上界。
        const aged = this.claimAged();

        if (aged !== null) {
            return aged;
        }

        // 等权轮转：按租户环逐个看，每个租户内部跳过"当前不可 claim"的
        // 队首（会话锁被占 / 租户并发已满），取第一个可 claim 的 Run。
        // 这样队首被阻塞时不会连带堵死同租户后面的 Run。
        const tenantsToInspect = this.tenantOrder.length;

        for (
            let inspected = 0;
            inspected < tenantsToInspect;
            inspected += 1
        ) {
            const tenantId = this.tenantOrder.shift();

            if (tenantId === undefined) {
                return null;
            }

            const tenantQueue = this.queuesByTenant.get(tenantId);

            if (tenantQueue === undefined || tenantQueue.length === 0) {
                this.queuesByTenant.delete(tenantId);
                continue;
            }

            const claimableIndex = tenantQueue.findIndex(
                (candidate) => this.canClaim(tenantId, candidate),
            );

            if (claimableIndex === -1) {
                // 本租户本轮没有可 claim 的 Run（并发满或会话锁被占）：
                // 整租户让位一轮，但不阻塞其它租户。
                this.tenantOrder.push(tenantId);
                continue;
            }

            const [run] = tenantQueue.splice(claimableIndex, 1);

            if (run === undefined) {
                this.tenantOrder.push(tenantId);
                continue;
            }

            if (tenantQueue.length > 0) {
                this.tenantOrder.push(tenantId);
            } else {
                this.queuesByTenant.delete(tenantId);
            }

            this.activate(run);
            return run;
        }

        // 有等待任务，但是所有租户都不可 claim（并发满 / 会话锁）。
        return null;
    }

    /**
     * N10：老化插队。跨租户找出"等待时间最长且已超过 agingMs"、当前可
     * claim 的 Run。租户内部同样跳过被会话锁/并发上限挡住的前缀，避免
     * 老化补偿本身被队首阻塞吃掉。
     *
     * 没有任何 Run 超过阈值时返回 null，行为交回等权轮转。
     */
    private claimAged(): QueuedRun | null {
        const agingMs = this.config.agingMs ?? 0;

        if (agingMs <= 0) {
            return null;
        }

        const now = (this.config.now ?? Date.now)();
        let bestTenantId: string | null = null;
        let bestRun: QueuedRun | null = null;
        let bestWaitedMs = agingMs;

        for (const tenantId of this.tenantOrder) {
            const tenantQueue = this.queuesByTenant.get(tenantId);

            if (tenantQueue === undefined) {
                continue;
            }

            for (const candidate of tenantQueue) {
                if (this.canClaim(tenantId, candidate) === false) {
                    // 会话锁/并发上限挡住：跳过它继续找后面可 claim 的。
                    continue;
                }

                const waitedMs = now - Date.parse(candidate.enqueuedAt);

                if (Number.isFinite(waitedMs) && waitedMs >= bestWaitedMs) {
                    bestTenantId = tenantId;
                    bestRun = candidate;
                    bestWaitedMs = waitedMs;
                }

                // FIFO：一旦遇到第一个可 claim 但尚未老化的 Run，本租户
                // 后面的 Run 不允许越过它。
                break;
            }
        }

        if (bestTenantId === null || bestRun === null) {
            return null;
        }

        return this.claimSpecific(bestTenantId, bestRun.runId);
    }

    /** 从指定租户队列里精确摘出一个 Run 并激活；用于老化路径。 */
    private claimSpecific(tenantId: string, runId: string): QueuedRun | null {
        const tenantQueue = this.queuesByTenant.get(tenantId);

        if (tenantQueue === undefined) {
            return null;
        }

        const index = tenantQueue.findIndex((run) => run.runId === runId);

        if (index === -1) {
            return null;
        }

        const [run] = tenantQueue.splice(index, 1);

        if (run === undefined) {
            return null;
        }

        if (tenantQueue.length > 0) {
            // 老化插队后，把该租户放到环尾，避免它下一轮继续优先。
            const ringIndex = this.tenantOrder.indexOf(tenantId);

            if (ringIndex !== -1) {
                this.tenantOrder.splice(ringIndex, 1);
            }

            this.tenantOrder.push(tenantId);
        } else {
            this.queuesByTenant.delete(tenantId);

            const ringIndex = this.tenantOrder.indexOf(tenantId);

            if (ringIndex !== -1) {
                this.tenantOrder.splice(ringIndex, 1);
            }
        }

        this.activate(run);
        return run;
    }

    /**
     * 单个 Run 当前是否具备启动资格：tenant 并发未满，且同一会话没有前序
     * Run 在跑。claimNext 与 claimAged 共用，避免两套判断逻辑漂移。
     */
    private canClaim(tenantId: string, run: QueuedRun): boolean {
        if (run.sessionId !== undefined && this.hasActiveSession(run.sessionId)) {
            return false;
        }

        const activeInTenant = this.getActiveTenantRunCount(tenantId);

        // 显式配置的上限是硬上限：到了就不许再借。
        const ceiling = this.config.maxActiveRunsPerTenant > 0
            ? this.config.maxActiveRunsPerTenant
            : this.config.maxActiveRuns;

        if (activeInTenant >= ceiling) {
            return false;
        }

        const cap = this.fairShareCap();

        if (activeInTenant < cap) {
            return true;
        }

        // 已达公平份额：只有在没有别的租户还能用这个 slot 时才允许借用，
        // 保证 work-conserving，不因为配额而空转全局槽位。
        return this.hasCompetingTenantBelowShare(tenantId, cap) === false;
    }

    /**
     * 单租户当前可用并发上限：max(1, floor(C / N))，N = 当前有排队需求的
     * 租户数。显式配置 maxActiveRunsPerTenant > 0 时作为硬上限叠加。
     * 等权定位下这就是公平份额；N 随租户进入/退出队列自然重算。
     */
    private effectiveTenantCap(): number {
        const ceiling = this.config.maxActiveRunsPerTenant > 0
            ? this.config.maxActiveRunsPerTenant
            : this.config.maxActiveRuns;
        return Math.min(ceiling, this.fairShareCap());
    }

    /** 等权公平份额：floor(C / 有需求租户数)，最小 1。 */
    private fairShareCap(): number {
        const demand = Math.max(1, this.demandTenantCount());
        return Math.max(
            1,
            Math.floor(this.config.maxActiveRuns / demand),
        );
    }

    /** 当前还有排队 Run 的租户数（有需求的租户）。 */
    private demandTenantCount(): number {
        let count = 0;

        for (const queue of this.queuesByTenant.values()) {
            if (queue.length > 0) {
                count += 1;
            }
        }

        return count;
    }

    /**
     * 除 excludeTenantId 外，是否存在还有可跑 Run 且未达公平份额的租户。
     * 有竞争就守份额，没竞争就允许占满全局槽位。
     */
    private hasCompetingTenantBelowShare(
        excludeTenantId: string,
        cap: number,
    ): boolean {
        for (const [tenantId, queue] of this.queuesByTenant) {
            if (tenantId === excludeTenantId || queue.length === 0) {
                continue;
            }

            if (this.getActiveTenantRunCount(tenantId) >= cap) {
                continue;
            }

            const hasRunnableNow = queue.some(
                (candidate) => candidate.sessionId === undefined
                    || this.hasActiveSession(candidate.sessionId) === false,
            );

            if (hasRunnableNow) {
                return true;
            }
        }

        return false;
    }

    private getActiveTenantRunCount(tenantId:string):number {
        return this.activeCountByTenant.get(tenantId) ?? 0;
    }

    private hasActiveSession(sessionId: string): boolean {
        return this.activeSessionIds.has(sessionId);
    }


    // 释放资源
    release(runId:string):boolean {
        // 释放指定 run 的 slot
        const sessionId = this.activeSessionByRunId.get(runId);
        if (sessionId !== undefined) {
            this.activeSessionByRunId.delete(runId);
            this.activeSessionIds.delete(sessionId);
        }

        const tenantId = this.activeTenantByRunId.get(runId);
        if (tenantId === undefined) {
            return false;
        }

        this.activeTenantByRunId.delete(runId);
        const remaining = (this.activeCountByTenant.get(tenantId) ?? 1) - 1;
        if (remaining > 0) {
            this.activeCountByTenant.set(tenantId, remaining);
        } else {
            this.activeCountByTenant.delete(tenantId);
        }
        return true;
    }

    /** 该 Run 是否已被 claim、当前占用活跃 slot。 */
    isActive(runId:string):boolean {
        return this.activeTenantByRunId.has(runId);
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

            this.queuedRunByRunId.delete(runId);
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
     * over a previously stored scheduling hint because they are the immediate
     * reason the Run cannot be claimed now.
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
                activeTenantRunCount >= this.effectiveTenantCap()
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


function compareQueuedRuns(left: QueuedRun, right: QueuedRun): number {
    return Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt);
}

function assertPositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} 必须为正整数`);
    }
}

function assertNonNegativeInteger(value: number, name: string): void {
    if (value < 0 || Number.isInteger(value) === false) {
        throw new Error(name + " 必须为非负整数");
    }
}
