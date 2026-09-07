import type { AgentRun, RunEvent } from "../runs/agent-run.ts";
import type { ResourceSample } from "./resource-metrics-sampler.ts";

/** Host-level samples overlap runs; they do not measure exclusive per-run GPU consumption. */
export function summarizeRunObservation(run: AgentRun, events: readonly RunEvent[], samples: readonly ResourceSample[]) {
    const time = (type: string) => {
        const event = events.find(e => e.type === type);
        return event ? Date.parse(event.timestamp) : null;
    };
    const delta = (a: number | null, b: number | null) => a === null || b === null ? null : Math.max(0, b - a);
    const created = Date.parse(run.createdAt), started = time("RUN_STARTED"), model = time("MODEL_STARTED");
    const finished = run.finishedAt ? Date.parse(run.finishedAt) : null;
    const windowEnd = finished ?? Date.now();
    const windowSamples = samples.filter(s => Date.parse(s.sampledAt) >= created && Date.parse(s.sampledAt) <= windowEnd);
    const acquired = events.filter(e => e.type === "SANDBOX_ACQUIRED").map(e => ({ timestamp: e.timestamp, ...e.payload as Record<string, unknown> }));
    const stage = (type: string): Array<Record<string, unknown> & { timestamp: string }> =>
        events
            .filter((event) => event.type === type)
            .map((event) => ({
                timestamp: event.timestamp,
                ...(event.payload as Record<string, unknown>),
            }));
    const stats = (key: "gpuUtilizationPercent" | "kvCacheUsagePercent" | "runningRequests" | "waitingRequests") => {
        const values = windowSamples.flatMap(s => s.ok && s.snapshot[key] !== null ? [s.snapshot[key]!] : []);
        return { count: values.length, mean: values.length ? values.reduce((a,b) => a+b,0)/values.length : null, max: values.length ? Math.max(...values) : null };
    };
    return {
        runId: run.id, status: run.status,
        scope: "host-overlap-not-exclusive-run-usage",
        retention: "bounded-in-memory; export reports before restart",
        window: { start: run.createdAt, end: new Date(windowEnd).toISOString() },
        timings: { queue_wait_ms: delta(created, started), model_start_delay_ms: delta(created, model), runtime_start_ms: delta(started, model), ttft_ms: delta(model, time("MODEL_FIRST_TOKEN")), e2e_ms: delta(created, finished) },
        control: stage("CONTROL_PREPARED"),
        session: stage("SESSION_INITIALIZED"),
        queue: stage("QUEUE_BLOCKED"),
        sandbox: acquired,
        resources: { gpu: stats("gpuUtilizationPercent"), kv: stats("kvCacheUsagePercent"), running: stats("runningRequests"), waiting: stats("waitingRequests") },
        sampleCount: windowSamples.length, failedSamples: windowSamples.filter(s => !s.ok).length,
        samples: windowSamples,
    };
}
