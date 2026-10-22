import { expect, test } from "bun:test";

import {
    installModelRequestTiming,
    resetModelRequestTimingForTest,
    takeModelRequestTiming,
} from "../../src/runtime/model-request-timing.ts";

test("包装 fetch：记录模型 POST 的发出时刻与响应头到达时刻", async () => {
    const originalFetch = globalThis.fetch;
    resetModelRequestTimingForTest();
    let capturedUrl = "";

    globalThis.fetch = (async (input: unknown) => {
        capturedUrl = String(input);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
        installModelRequestTiming();

        await globalThis.fetch("https://example.test/v1/chat/completions", {
            method: "POST",
        });

        const timing = takeModelRequestTiming();
        expect(capturedUrl).toBe("https://example.test/v1/chat/completions");
        expect(timing).not.toBeNull();
        expect(timing?.url).toContain("/chat/completions");
        expect(timing?.headersAt).not.toBeNull();
        expect((timing?.headersAt ?? 0) - (timing?.startedAt ?? 0))
            .toBeGreaterThanOrEqual(4);
        expect(takeModelRequestTiming()).toBeNull();
    } finally {
        resetModelRequestTimingForTest();
        globalThis.fetch = originalFetch;
    }
});

test("非模型 POST / GET 不计入模型请求计时", async () => {
    const originalFetch = globalThis.fetch;
    resetModelRequestTimingForTest();

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    try {
        installModelRequestTiming();

        await globalThis.fetch("https://example.test/health", { method: "GET" });
        await globalThis.fetch("https://example.test/other", { method: "POST" });

        expect(takeModelRequestTiming()).toBeNull();
    } finally {
        resetModelRequestTimingForTest();
        globalThis.fetch = originalFetch;
    }
});
