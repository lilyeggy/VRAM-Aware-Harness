import {
    acquireRunAttemptLease,
    finishRunAttempt,
    heartbeatRunAttemptLease,
    releaseRunAttemptLease,
    type RunAttempt,
} from "./run-attempt.ts";
import type { RunAttemptStore } from "./run-attempt-store.ts";

export interface RunLeaseManagerOptions {
    /** 本实例的租约持有者 ID，用于区分同 Run 的旧/新执行器。 */
    readonly owner: string;
    /** 租约 TTL（ms）。超过后其他实例/回收器可回收。 */
    readonly leaseTtlMs: number;
    /** 心跳间隔（ms），必须小于 leaseTtlMs。 */
    readonly heartbeatIntervalMs: number;
    /** 时钟注入（测试用），默认 Date.now。 */
    readonly now?: () => number;
    /** 过期租约被回收后的回调（用于 RunService + scheduler 收口）。 */
    onExpired?: (attempt: RunAttempt) => void;
    /** 心跳/回收异常回调。 */
    readonly onError?: (error: unknown) => void;
}

/**
 * §9.8 v1.4 Phase 2：RunAttempt 租约与心跳。
 *
 * 执行器启动时 acquire，运行期按 heartbeatIntervalMs 续租，结束时 release；
 * reapExpired() 扫描 RUNNING 且 lease_expires_at 已过期的 Attempt，标记
 * INTERRUPTED 并回调 onExpired，供上层把 Run 退回可恢复状态、释放 slot。
 */
export class RunLeaseManager {
    private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

    constructor(
        private readonly attempts: RunAttemptStore,
        private readonly options: RunLeaseManagerOptions,
    ) {
        if (options.leaseTtlMs <= 0) {
            throw new Error("leaseTtlMs 必须为正数");
        }
        if (options.heartbeatIntervalMs <= 0) {
            throw new Error("heartbeatIntervalMs 必须为正数");
        }
        if (options.heartbeatIntervalMs >= options.leaseTtlMs) {
            throw new Error("heartbeatIntervalMs 必须小于 leaseTtlMs");
        }
    }

    setExpiredHandler(handler: (attempt: RunAttempt) => void): void {
        this.options.onExpired = handler;
    }

    /** 获取租约并持久化；调用方应使用返回的新 Attempt。 */
    acquire(attempt: RunAttempt): RunAttempt {
        const now = this.nowIso();
        const leased = acquireRunAttemptLease(
            attempt,
            this.options.owner,
            now,
            this.options.leaseTtlMs,
        );
        this.attempts.update(leased, attempt.status);
        return leased;
    }

    /** 开始周期心跳；重复调用会替换旧 timer。 */
    startHeartbeat(attemptId: string): void {
        this.stopHeartbeat(attemptId);
        const timer = setInterval(() => {
            this.heartbeat(attemptId);
        }, this.options.heartbeatIntervalMs);
        if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
        }
        this.timers.set(attemptId, timer);
    }

    stopHeartbeat(attemptId: string): void {
        const timer = this.timers.get(attemptId);
        if (timer !== undefined) {
            clearInterval(timer);
            this.timers.delete(attemptId);
        }
    }

    /** 主动释放租约（正常结束/失败收口时调用，幂等）。 */
    release(attemptId: string): void {
        this.stopHeartbeat(attemptId);
        const attempt = this.attempts.get(attemptId);
        if (attempt === null) {
            return;
        }
        if (attempt.leaseOwner === null) {
            return;
        }
        if (attempt.status !== "RUNNING" && attempt.status !== "PENDING") {
            return;
        }
        const released = releaseRunAttemptLease(attempt);
        this.attempts.update(released, attempt.status);
    }

    /**
     * 回收过期租约：把 RUNNING 且 lease_expires_at < now 的 Attempt 标记
     * INTERRUPTED，并回调 onExpired。返回被回收的 Attempt 列表。
     */
    reapExpired(): RunAttempt[] {
        const nowIso = this.nowIso();
        const expired = this.attempts.listExpiredLeases(nowIso);
        const reaped: RunAttempt[] = [];

        for (const attempt of expired) {
            try {
                const interrupted = finishRunAttempt(
                    attempt,
                    "INTERRUPTED",
                    nowIso,
                );
                this.attempts.update(interrupted, attempt.status);
                this.stopHeartbeat(attempt.id);
                this.options.onExpired?.(interrupted);
                reaped.push(interrupted);
            } catch (error) {
                this.options.onError?.(error);
            }
        }

        return reaped;
    }

    /** 停止所有心跳 timer（进程收尾用）。 */
    stopAll(): void {
        for (const attemptId of [...this.timers.keys()]) {
            this.stopHeartbeat(attemptId);
        }
    }

    private heartbeat(attemptId: string): void {
        try {
            const attempt = this.attempts.get(attemptId);
            if (attempt === null || attempt.status !== "RUNNING") {
                this.stopHeartbeat(attemptId);
                return;
            }
            if (attempt.leaseOwner !== this.options.owner) {
                this.stopHeartbeat(attemptId);
                return;
            }
            const heartbeat = heartbeatRunAttemptLease(
                attempt,
                this.options.owner,
                this.nowIso(),
                this.options.leaseTtlMs,
            );
            this.attempts.update(heartbeat, attempt.status);
        } catch (error) {
            this.options.onError?.(error);
        }
    }

    private nowIso(): string {
        return new Date(this.options.now?.() ?? Date.now()).toISOString();
    }
}
