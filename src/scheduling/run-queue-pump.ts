import type {
    CoordinatorResult,
}   from "./run-queue-coordinator.ts";

export interface QueueDrainTarget {
    drain(): Promise<CoordinatorResult[]>;
}

export interface RunQueuePumpOptions {
    intervalMs:number;
    onError?: (error:unknown) => void;
}

export class RunQueuePump {
    private timer : ReturnType<typeof setInterval> | null = null;
    /**
     * N20：当前在飞的 tick。关闭时必须等它落地。
     *
     * 原先 `stop()` 只清定时器（注释也写明"不会强制中断当前已经开始的 drain"），
     * 于是在飞的 drain 会继续推进 Run、走到工作区快照写库，而此刻 SQLite 已被
     * `composition.close()` 关闭 → `RangeError: Cannot use a closed database`
     * （真机同实例日志里出现 20 次）。
     */
    private inFlight : Promise<void> | null = null;
    constructor (
        private readonly target : QueueDrainTarget,
        private readonly options : RunQueuePumpOptions,
    ) {
        if (
            !Number.isInteger(options.intervalMs)
            || options.intervalMs <= 0
        ) {
            throw new Error ("intervalMs 必须是正整数");
        }
    }

    // 执行一次 drain 并处理异常
    async tick() : Promise<void> {
        const work = (async () => {
            try {
                await this.target.drain();
            } catch (error) {
                this.options.onError?.(error);
            }
        })();
        this.inFlight = work;
        try {
            await work;
        } finally {
            // 只在"自己仍是最新那次"时清空，避免把后起的 tick 覆盖掉。
            if (this.inFlight === work) {
                this.inFlight = null;
            }
        }
    }


    start() : void {
        if (this.timer !== null) {
            return;
        }

        this.timer = setInterval(() => {
            void this.tick();
        },this.options.intervalMs);

        // 前面加 void，实际上这里的void是一个一元运算符，表示丢弃它的返回值
        // 不必等待第一个时间间隔，启动后立即检查队列
        void this.tick();
    }

    // stop 函数有下面的职责
    // 没有启动时调用不报错
    // 清除定时器
    // 设置回null，使pump后续可以重新启动
    // 不会强制中断当前已经开始的 drain
    stop() : void {
        if (this.timer === null) {
            return;
        }

        // 清理定时器
        clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * N20：停表**并等待在飞的 drain 结束**。关闭流程必须用它而不是 `stop()`，
     * 否则在飞 tick 会在数据库关闭之后仍然尝试写库。
     *
     * 用循环等待而非只 await 一次：等待期间若又有 tick 被触发（定时器已清，
     * 但上一条已入队的回调可能仍在跑），循环会把新的那次也等掉。
     */
    async stopAndDrain() : Promise<void> {
        this.stop();
        while (this.inFlight !== null) {
            await this.inFlight;
        }
    }
}