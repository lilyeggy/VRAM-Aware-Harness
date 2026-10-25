
// 并发上限配置
export interface UserRunSchedulerConfig {
    maxActiveRuns: number;
    maxActiveRunsPerUser: number;
    /**
     * N10：老化阈值（ms）。某个用户的队首 Run 等待超过该值时，它不再等
     * 轮转排到，而是直接插队优先调度——给「被洪泛用户挡在后面的正常用户」
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
    | "USER_CONCURRENCY_LIMIT"
    | "SESSION_SERIALIZATION";

// 队列里面的 Run 的格式要求
export interface EnqueueRunInput {
    runId: string;
    userId: string;
    /** Runs sharing a conversation must never be active concurrently. */
    sessionId?: string;
    reasonCode?: QueueReasonCode;
    enqueuedAt?: string;
}

export interface QueuedRun {
    runId: string;
    userId: string;
    sessionId?: string;
    reasonCode: QueueReasonCode;
    enqueuedAt: string;
}

export interface QueueEntry extends Omit<QueuedRun, "sessionId"> {
    position: number;
    userPosition: number;
}

export interface SchedulerCapacity {
    activeRunCount:number;
    activeUserRunCount:number;
}

/**
 * A point-in-time explanation for a Run that remains queued. It is diagnostic
 * evidence, not a new scheduler decision: the scheduler continues to own the
 * actual claim/release transition.
 */
export interface QueueBlocker extends QueueEntry {
    reasonCode: QueueReasonCode;
    activeRunCount: number;
    activeUserRunCount: number;
}

/**
 * 在 User 之间公平选择 Run，并维护 Harness 的逻辑模型并发 slot。
 *
 * Scheduler 不负责 GPU 压力分类，也不负责 vLLM 内部 token 调度。
 */
export class UserRunScheduler {
    private readonly queuesByUser = new Map<string, QueuedRun[]>();
    private readonly userOrder: string[] = [];
    private readonly activeUserByRunId = new Map<string, string>();
    private readonly activeSessionByRunId = new Map<string, string>();
    /** runId → QueuedRun 索引，避免 findQueuedRun 全队列线性扫描。 */
    private readonly queuedRunByRunId = new Map<string, QueuedRun>();
    /** userId → 活跃 Run 数，随 claim/release 增量维护。 */
    private readonly activeCountByUser = new Map<string, number>();
    /** 当前有活跃 Run 的会话集合，随 claim/release 增量维护。 */
    private readonly activeSessionIds = new Set<string>();

    constructor(private readonly config: UserRunSchedulerConfig) {
        assertPositiveInteger(config.maxActiveRuns, "maxActiveRuns");

        // 0 = 自动公平份额（maxActiveRuns 除以有需求用户数）。
        assertNonNegativeInteger(
            config.maxActiveRunsPerUser,
            "maxActiveRunsPerUser",
        );

        if (
            config.maxActiveRunsPerUser > 0
            && config.maxActiveRunsPerUser
            > config.maxActiveRuns
        ) {
            throw new Error(
                "maxActiveRunsPerUser 不能大于 maxActiveRuns",
            );
        }
    }

    enqueue(input: EnqueueRunInput): QueuedRun {
        if (this.activeUserByRunId.has(input.runId)) {
            throw new Error(`Run 正在执行中：${input.runId}`);
        }

        if (this.findQueuedRun(input.runId) !== null) {
            throw new Error(`Run 已经在队列中：${input.runId}`);
        }

        const queuedRun: QueuedRun = {
            runId: input.runId,
            userId: input.userId,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            reasonCode:
                input.reasonCode ?? "AWAITING_SCHEDULING",
            enqueuedAt:
                input.enqueuedAt ?? new Date().toISOString(),
        };
        const userQueue = this.queuesByUser.get(input.userId);

        if (userQueue === undefined) {
            this.queuesByUser.set(input.userId, [queuedRun]);
            this.userOrder.push(input.userId);
        } else {
            userQueue.push(queuedRun);
            userQueue.sort(compareQueuedRuns);
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
        this.activeUserByRunId.set(run.runId, run.userId);
        this.activeCountByUser.set(
            run.userId,
            (this.activeCountByUser.get(run.userId) ?? 0) + 1,
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
     *  userId:"user-a",
     *  ...
     * }
     * 这代表的是 A1 已经离开等待队列，A1 已经占用一个 slot，调用方可以启动 A1
     */
    claimNext() : QueuedRun | null {
        // 全局 slot 已满：任何人都不能 claim。
        if (this.activeUserByRunId.size >= this.config.maxActiveRuns) {
            return null;
        }

        // 老化优先：给"等太久"的 Run 一个确定的等待上界。
        const aged = this.claimAged();

        if (aged !== null) {
            return aged;
        }

        // 等权轮转：按用户环逐个看，每个用户内部跳过"当前不可 claim"的
        // 队首（会话锁被占 / 用户并发已满），取第一个可 claim 的 Run。
        // 这样队首被阻塞时不会连带堵死同用户后面的 Run。
        const usersToInspect = this.userOrder.length;

        for (
            let inspected = 0;
            inspected < usersToInspect;
            inspected += 1
        ) {
            const userId = this.userOrder.shift();

            if (userId === undefined) {
                return null;
            }

            const userQueue = this.queuesByUser.get(userId);

            if (userQueue === undefined || userQueue.length === 0) {
                this.queuesByUser.delete(userId);
                continue;
            }

            const claimableIndex = userQueue.findIndex(
                (candidate) => this.canClaim(userId, candidate),
            );

            if (claimableIndex === -1) {
                // 本用户本轮没有可 claim 的 Run（并发满或会话锁被占）：
                // 整用户让位一轮，但不阻塞其它用户。
                this.userOrder.push(userId);
                continue;
            }

            const [run] = userQueue.splice(claimableIndex, 1);

            if (run === undefined) {
                this.userOrder.push(userId);
                continue;
            }

            if (userQueue.length > 0) {
                this.userOrder.push(userId);
            } else {
                this.queuesByUser.delete(userId);
            }

            this.activate(run);
            return run;
        }

        // 有等待任务，但是所有用户都不可 claim（并发满 / 会话锁）。
        return null;
    }

    /**
     * N10：老化插队。跨用户找出"等待时间最长且已超过 agingMs"、当前可
     * claim 的 Run。用户内部同样跳过被会话锁/并发上限挡住的前缀，避免
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
        let bestUserId: string | null = null;
        let bestRun: QueuedRun | null = null;
        let bestWaitedMs = agingMs;

        for (const userId of this.userOrder) {
            const userQueue = this.queuesByUser.get(userId);

            if (userQueue === undefined) {
                continue;
            }

            for (const candidate of userQueue) {
                if (this.canClaim(userId, candidate) === false) {
                    // 会话锁/并发上限挡住：跳过它继续找后面可 claim 的。
                    continue;
                }

                const waitedMs = now - Date.parse(candidate.enqueuedAt);

                if (Number.isFinite(waitedMs) && waitedMs >= bestWaitedMs) {
                    bestUserId = userId;
                    bestRun = candidate;
                    bestWaitedMs = waitedMs;
                }

                // FIFO：一旦遇到第一个可 claim 但尚未老化的 Run，本用户
                // 后面的 Run 不允许越过它。
                break;
            }
        }

        if (bestUserId === null || bestRun === null) {
            return null;
        }

        return this.claimSpecific(bestUserId, bestRun.runId);
    }

    /** 从指定用户队列里精确摘出一个 Run 并激活；用于老化路径。 */
    private claimSpecific(userId: string, runId: string): QueuedRun | null {
        const userQueue = this.queuesByUser.get(userId);

        if (userQueue === undefined) {
            return null;
        }

        const index = userQueue.findIndex((run) => run.runId === runId);

        if (index === -1) {
            return null;
        }

        const [run] = userQueue.splice(index, 1);

        if (run === undefined) {
            return null;
        }

        if (userQueue.length > 0) {
            // 老化插队后，把该用户放到环尾，避免它下一轮继续优先。
            const ringIndex = this.userOrder.indexOf(userId);

            if (ringIndex !== -1) {
                this.userOrder.splice(ringIndex, 1);
            }

            this.userOrder.push(userId);
        } else {
            this.queuesByUser.delete(userId);

            const ringIndex = this.userOrder.indexOf(userId);

            if (ringIndex !== -1) {
                this.userOrder.splice(ringIndex, 1);
            }
        }

        this.activate(run);
        return run;
    }

    /**
     * 单个 Run 当前是否具备启动资格：user 并发未满，且同一会话没有前序
     * Run 在跑。claimNext 与 claimAged 共用，避免两套判断逻辑漂移。
     */
    private canClaim(userId: string, run: QueuedRun): boolean {
        if (run.sessionId !== undefined && this.hasActiveSession(run.sessionId)) {
            return false;
        }

        const activeInUser = this.getActiveUserRunCount(userId);

        // 显式配置的上限是硬上限：到了就不许再借。
        const ceiling = this.config.maxActiveRunsPerUser > 0
            ? this.config.maxActiveRunsPerUser
            : this.config.maxActiveRuns;

        if (activeInUser >= ceiling) {
            return false;
        }

        const cap = this.fairShareCap();

        if (activeInUser < cap) {
            return true;
        }

        // 已达公平份额：只有在没有别的用户还能用这个 slot 时才允许借用，
        // 保证 work-conserving，不因为配额而空转全局槽位。
        return this.hasCompetingUserBelowShare(userId, cap) === false;
    }

    /**
     * 单用户当前可用并发上限：max(1, floor(C / N))，N = 当前有排队需求的
     * 用户数。显式配置 maxActiveRunsPerUser > 0 时作为硬上限叠加。
     * 等权定位下这就是公平份额；N 随用户进入/退出队列自然重算。
     */
    private effectiveUserCap(): number {
        const ceiling = this.config.maxActiveRunsPerUser > 0
            ? this.config.maxActiveRunsPerUser
            : this.config.maxActiveRuns;
        return Math.min(ceiling, this.fairShareCap());
    }

    /** 等权公平份额：floor(C / 有需求用户数)，最小 1。 */
    private fairShareCap(): number {
        const demand = Math.max(1, this.demandUserCount());
        return Math.max(
            1,
            Math.floor(this.config.maxActiveRuns / demand),
        );
    }

    /** 当前还有排队 Run 的用户数（有需求的用户）。 */
    private demandUserCount(): number {
        let count = 0;

        for (const queue of this.queuesByUser.values()) {
            if (queue.length > 0) {
                count += 1;
            }
        }

        return count;
    }

    /**
     * 除 excludeUserId 外，是否存在还有可跑 Run 且未达公平份额的用户。
     * 有竞争就守份额，没竞争就允许占满全局槽位。
     */
    private hasCompetingUserBelowShare(
        excludeUserId: string,
        cap: number,
    ): boolean {
        for (const [userId, queue] of this.queuesByUser) {
            if (userId === excludeUserId || queue.length === 0) {
                continue;
            }

            if (this.getActiveUserRunCount(userId) >= cap) {
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

    private getActiveUserRunCount(userId:string):number {
        return this.activeCountByUser.get(userId) ?? 0;
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

        const userId = this.activeUserByRunId.get(runId);
        if (userId === undefined) {
            return false;
        }

        this.activeUserByRunId.delete(runId);
        const remaining = (this.activeCountByUser.get(userId) ?? 1) - 1;
        if (remaining > 0) {
            this.activeCountByUser.set(userId, remaining);
        } else {
            this.activeCountByUser.delete(userId);
        }
        return true;
    }

    /** 该 Run 是否已被 claim、当前占用活跃 slot。 */
    isActive(runId:string):boolean {
        return this.activeUserByRunId.has(runId);
    }

    // 获取最大并发上限
    getCapacity(userId:string):SchedulerCapacity {
        return {
            activeRunCount : this.activeUserByRunId.size,
            activeUserRunCount : this.getActiveUserRunCount(userId),
        }
    }

    removeQueued(runId:string):QueuedRun | null {
        // 遍历 user 队列
        for (const [userId,userQueue] of this.queuesByUser.entries()) {
            const runIndex = userQueue.findIndex(
                (run) => run.runId === runId,
            );
            // 如果没有找到对应的runIndex
            if (runIndex === -1) {
                continue;
            }

            const [removedRun] = userQueue.splice(runIndex,1)
            if (removedRun === undefined) {
                return null;
            }

            this.queuedRunByRunId.delete(runId);
            // 清理空的user
            if (userQueue.length === 0){
                this.queuesByUser.delete(userId);

                const userOrderIndex = this.userOrder.indexOf(userId);

                // 如果找到的话，那么就删除
                if (userOrderIndex !== -1){
                    this.userOrder.splice(userOrderIndex,1);
                }
            }
            return removedRun;
            
        }
        return null;
    }
    

    // 这个函数就是如何查看当前队列情况
    // 具体如下：
    /**
     * User A: A1, A2, A3
     * User B: B1, B2
     * userOrder : [A,B]
     * 
     * 公平的调度顺序应该是
     * A1->B1->A2
     * 
     * 我们下面的函数应该把这个顺序展示为
     * { runId:"A1", position:1,userPosition:1 },
     * { runId:"B1", position:2,userPosition:1 },
     * { runId:"A2", position:3,userPosition:2 },
     */
    // 我们要输出的就是两个位置,position和userPosition
    listQueue():QueueEntry[] {
        const queueCopies = new Map<string,QueuedRun[]>();

        for (
            const [userId,userQueue]
            of this.queuesByUser.entries()
        )   {
            queueCopies.set(userId,[...userQueue]);
        }

        const userOrderCopy = [...this.userOrder];
        const entries:QueueEntry[] = [];
        const userPositions = new Map<string,number>();

        // 只要副本轮转队列还有user
        while (userOrderCopy.length > 0){
            const userId = userOrderCopy.shift();

            // 没有 user 了
            if (userId === undefined) {
                break;
            }

            // 查找对应的user的队列
            const userQueue = queueCopies.get(userId);

            if (userQueue === undefined || userQueue.length === 0){
                continue;
            }

            // 获取一个 run
            const run = userQueue.shift();
            if (run === undefined) {
                continue;
            }

            const userPosition = (userPositions.get(userId) ?? 0) + 1;
            userPositions.set(userId,userPosition);

            entries.push({
                runId: run.runId,
                userId: run.userId,
                reasonCode: run.reasonCode,
                enqueuedAt: run.enqueuedAt,
                position:entries.length + 1,
                userPosition,
            })

            if (userQueue.length > 0) {
                userOrderCopy.push(userId);
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
            this.activeUserByRunId.size >= this.config.maxActiveRuns;

        return this.listQueue().map((entry) => {
            const queued = this.findQueuedRun(entry.runId);
            const activeUserRunCount = this.getActiveUserRunCount(
                entry.userId,
            );
            let reasonCode = entry.reasonCode;

            if (globalAtLimit) {
                reasonCode = "GLOBAL_CONCURRENCY_LIMIT";
            } else if (
                activeUserRunCount >= this.effectiveUserCap()
            ) {
                reasonCode = "USER_CONCURRENCY_LIMIT";
            } else if (
                queued?.sessionId !== undefined
                && this.hasActiveSession(queued.sessionId)
            ) {
                reasonCode = "SESSION_SERIALIZATION";
            }

            return {
                ...entry,
                reasonCode,
                activeRunCount: this.activeUserByRunId.size,
                activeUserRunCount,
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
