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
        try {
            await this.target.drain();
        } catch (error) {
            this.options.onError?.(error);
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
}