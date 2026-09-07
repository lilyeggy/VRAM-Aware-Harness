import { test, expect } from "bun:test";
import { summarizeRunObservation } from "../../src/resources/run-observation.ts";
import { ResourceMetricsSampler } from "../../src/resources/resource-metrics-sampler.ts";
import type { AgentRun } from "../../src/runs/agent-run.ts";
test("probe exceptions are retained as failures instead of unhandled rejection", async () => {
    const sampler = new ResourceMetricsSampler({async observe(){throw new Error("secret must not leak")}});
    expect((await sampler.sample()).ok).toBe(false);
    expect(JSON.stringify(sampler.getSamples())).not.toContain("secret");
});
test("run windows exclude outside samples and retain missing metrics as null", () => {
    const run = {id:"a",status:"COMPLETED",createdAt:"2026-09-05T00:00:00Z",finishedAt:"2026-09-05T00:00:02Z"} as AgentRun;
    const report = summarizeRunObservation(run, [], [{ok:false,sampledAt:"2026-09-05T00:00:01Z",reason:"TIMEOUT",message:"timeout"},{ok:false,sampledAt:"2026-09-05T00:00:03Z",reason:"TIMEOUT",message:"timeout"}]);
    expect(report.sampleCount).toBe(1);
    expect(report.resources.kv.max).toBeNull();
    expect(report.timings.e2e_ms).toBe(2000);
});

test("queue blocker events are included in per-Run observability", () => {
    const run = {id:"a",status:"QUEUED",createdAt:"2026-09-05T00:00:00Z",finishedAt:null} as AgentRun;
    const report = summarizeRunObservation(run, [{
        eventId:"e", runId:"a", sequence:2, type:"QUEUE_BLOCKED",
        timestamp:"2026-09-05T00:00:01Z", payloadVersion:1,
        payload:{ reasonCode:"TENANT_CONCURRENCY_LIMIT" },
    }], []);
    expect(report.queue).toEqual([{
        timestamp:"2026-09-05T00:00:01Z",
        reasonCode:"TENANT_CONCURRENCY_LIMIT",
    }]);
});
