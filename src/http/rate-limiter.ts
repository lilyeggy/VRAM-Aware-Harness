/**
 * 极简固定窗口限流器（单机内存版）。
 *
 * 目标：在单机、单 Master 的实验室部署里挡住单租户/单 IP 的突发流量，
 * 返回 429 + Retry-After。不做分布式限流、不依赖 Redis；进程重启即清零。
 *
 * 固定窗口的取舍：实现简单、内存可控；代价是窗口边界可能瞬时放行 2x。
 * 对"防止一个账号刷爆入口"这个目标足够，不追求精确的令牌桶平滑度。
 */

export interface RateLimitOptions {
    enabled: boolean;
    windowMs: number;
    maxRequestsPerTenant: number;
    maxRequestsPerIp: number;
}

export interface RateLimitDecision {
    allowed: boolean;
    limit: number;
    remaining: number;
    /** 超限时建议的 Retry-After 秒数；未超限为 0。 */
    retryAfterSeconds: number;
}

interface Bucket {
    count: number;
    resetAt: number;
}

const MAX_TRACKED_KEYS = 10_000;

export class RateLimiter {
    private readonly buckets = new Map<string, Bucket>();

    constructor(private readonly options: RateLimitOptions) {}

    get enabled(): boolean {
        return this.options.enabled;
    }

    consumeTenant(tenantId: string, now = Date.now()): RateLimitDecision {
        return this.consume(`tenant:${tenantId}`, this.options.maxRequestsPerTenant, now);
    }

    consumeIp(ip: string, now = Date.now()): RateLimitDecision {
        return this.consume(`ip:${ip}`, this.options.maxRequestsPerIp, now);
    }

    consume(key: string, limit: number, now = Date.now()): RateLimitDecision {
        if (this.options.enabled === false) {
            return { allowed: true, limit, remaining: limit, retryAfterSeconds: 0 };
        }

        const existing = this.buckets.get(key);
        if (existing === undefined || now >= existing.resetAt) {
            this.buckets.set(key, { count: 1, resetAt: now + this.options.windowMs });
            this.pruneIfNeeded(now);
            return { allowed: true, limit, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
        }

        existing.count += 1;
        const allowed = existing.count <= limit;
        return {
            allowed,
            limit,
            remaining: Math.max(0, limit - existing.count),
            retryAfterSeconds: allowed
                ? 0
                : Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
        };
    }

    /** 清理过期桶；超过阈值时惰性触发，避免 Map 无限增长。 */
    prune(now = Date.now()): void {
        for (const [key, bucket] of this.buckets) {
            if (now >= bucket.resetAt) this.buckets.delete(key);
        }
    }

    get size(): number {
        return this.buckets.size;
    }

    private pruneIfNeeded(now: number): void {
        if (this.buckets.size > MAX_TRACKED_KEYS) this.prune(now);
    }
}
