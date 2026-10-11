import { expect, test } from "bun:test";

import { renderPrometheusMetrics } from "../../src/observability/metrics.ts";

test("renderPrometheusMetrics 输出核心指标与标签", () => {
    const text = renderPrometheusMetrics({
        started: true,
        uptimeSeconds: 12,
        queueLength: 3,
        runStatusCounts: { QUEUED: 3, COMPLETED: 2 },
        sandboxAcquisitions: { total: 5, warm: 4, cold: 1, durationMsSum: 1234 },
    }, new Map([[200, 7], [401, 1]]));

    expect(text).toContain("harness_up 1");
    expect(text).toContain("harness_uptime_seconds 12");
    expect(text).toContain("harness_runs_queued 3");
    expect(text).toContain('harness_runs{status="COMPLETED"} 2');
    expect(text).toContain('harness_sandbox_acquisitions_total{warm="true"} 4');
    expect(text).toContain('harness_sandbox_acquisitions_total{warm="false"} 1');
    expect(text).toContain("harness_sandbox_acquire_duration_ms_sum 1234");
    expect(text).toContain('harness_http_requests_total{status="200"} 7');
    expect(text).toContain('harness_http_requests_total{status="401"} 1');
});
