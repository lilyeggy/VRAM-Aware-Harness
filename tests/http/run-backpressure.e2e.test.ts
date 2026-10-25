import { expect, test } from "bun:test";

import { HarnessHttpApi } from "../../src/http/harness-http-api.ts";
import type { HarnessHttpApplication } from "../../src/http/http-contracts.ts";
import { QueueBackpressureError } from "../../src/scheduling/run-scheduler.ts";

test("队列深度 backpressure 映射为 429 + Retry-After", async () => {
    const application = {
        isStarted() {
            return true;
        },
        submitRun() {
            throw new QueueBackpressureError(
                "全局排队深度已达上限：1/1",
                "GLOBAL",
                1,
                1,
                5,
            );
        },
    } as unknown as HarnessHttpApplication;
    const api = new HarnessHttpApi(
        application,
        { get: () => null },
    );

    const response = await api.fetch(new Request(
        "http://harness.local/runs",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                userId: "user-a",
                userInput: "排队",
                workspacePath: "/tmp/a",
            }),
        },
    ));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("x-queue-limit")).toBe("1");
    expect(response.headers.get("x-queue-current")).toBe("1");
    expect(await response.json()).toEqual({
        error: "全局排队深度已达上限：1/1",
    });
});
