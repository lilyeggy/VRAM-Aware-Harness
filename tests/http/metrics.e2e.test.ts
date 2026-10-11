import { expect, test } from "bun:test";

import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import type { ResourceSnapshot } from "../../src/resources/resource-observer.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import { FakeResourceObserver } from "../fakes/fake-resource-observer.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

const normalSnapshot: ResourceSnapshot = {
    snapshotId: "metrics-snapshot",
    observedAt: "2026-10-11T00:00:00.000Z",
    sources: ["FAKE"],
    gpuTotalMemoryMiB: 100,
    gpuUsedMemoryMiB: 20,
    gpuFreeMemoryMiB: 80,
    gpuUtilizationPercent: 20,
    runningRequests: 0,
    waitingRequests: 0,
    kvCacheUsagePercent: 20,
    inputTokensPerSecond: 1_000,
    outputTokensPerSecond: 100,
};

test("GET /metrics 需要鉴权并返回 Prometheus 文本", async () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH: ":memory:",
        HARNESS_PUMP_INTERVAL_MS: "60000",
        HARNESS_BOOTSTRAP_API_KEY: "metrics-bootstrap-key",
    });
    const composition = await createHarnessApplication(config, {
        runtime: new FakeAgentRuntime(),
        resourceObserver: new FakeResourceObserver({ ok: true, snapshot: normalSnapshot }),
    });

    try {
        const unauthorized = await composition.httpApi.fetch(
            new Request("http://harness.local/metrics"),
        );
        expect(unauthorized.status).toBe(401);

        const response = await composition.httpApi.fetch(
            new Request("http://harness.local/metrics", {
                headers: { authorization: "Bearer metrics-bootstrap-key" },
            }),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/plain");

        const body = await response.text();
        expect(body).toContain("harness_up 0");
        expect(body).toContain("harness_runs_queued 0");
        expect(body).toContain('harness_runs{status="QUEUED"} 0');
        expect(body).toContain('harness_sandbox_acquisitions_total{warm="false"} 0');
        expect(body).toContain('harness_http_requests_total{status="401"} 1');
    } finally {
        await composition.close();
    }
});
