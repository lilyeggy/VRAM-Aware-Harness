import { describe, expect, test } from "bun:test";

import { RateLimiter } from "../../src/http/rate-limiter.ts";

const options = {
    enabled: true,
    windowMs: 60_000,
    maxRequestsPerTenant: 3,
    maxRequestsPerIp: 2,
};

describe("RateLimiter", () => {
    test("固定窗口内超过上限返回 allowed=false 与 Retry-After", () => {
        const limiter = new RateLimiter(options);
        const now = 1_000_000;

        expect(limiter.consumeIp("1.1.1.1", now).allowed).toBe(true);
        expect(limiter.consumeIp("1.1.1.1", now + 1).allowed).toBe(true);

        const third = limiter.consumeIp("1.1.1.1", now + 2);
        expect(third.allowed).toBe(false);
        expect(third.limit).toBe(2);
        expect(third.remaining).toBe(0);
        expect(third.retryAfterSeconds).toBeGreaterThan(0);
    });

    test("窗口过期后计数重置", () => {
        const limiter = new RateLimiter(options);
        const now = 1_000_000;

        limiter.consumeIp("1.1.1.1", now);
        limiter.consumeIp("1.1.1.1", now + 1);
        expect(limiter.consumeIp("1.1.1.1", now + 2).allowed).toBe(false);

        expect(limiter.consumeIp("1.1.1.1", now + options.windowMs).allowed).toBe(true);
    });

    test("租户与 IP 使用各自独立的桶", () => {
        const limiter = new RateLimiter(options);
        const now = 1_000_000;

        expect(limiter.consumeTenant("tenant-a", now).allowed).toBe(true);
        expect(limiter.consumeTenant("tenant-a", now).allowed).toBe(true);
        expect(limiter.consumeTenant("tenant-a", now).allowed).toBe(true);
        expect(limiter.consumeTenant("tenant-a", now).allowed).toBe(false);

        // 另一个租户不受影响
        expect(limiter.consumeTenant("tenant-b", now).allowed).toBe(true);
    });

    test("关闭时永远放行且不记录桶", () => {
        const limiter = new RateLimiter({ ...options, enabled: false });
        for (let i = 0; i < 100; i += 1) {
            expect(limiter.consumeIp("1.1.1.1", 1_000_000 + i).allowed).toBe(true);
        }
        expect(limiter.size).toBe(0);
    });

    test("prune 清理过期桶", () => {
        const limiter = new RateLimiter(options);
        const now = 1_000_000;
        limiter.consumeIp("1.1.1.1", now);
        limiter.consumeIp("2.2.2.2", now);
        expect(limiter.size).toBe(2);

        limiter.prune(now + options.windowMs);
        expect(limiter.size).toBe(0);
    });
});
