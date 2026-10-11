/**
 * §9.8 v1.4：最小可观测性。
 *
 * 这里只提供 Prometheus 文本渲染，不引入任何第三方 SDK；数据由调用方从
 * 现有 RunStore / 内存计数器读取。目的是让 Phase 2/3 的 lease、recovery、
 * retry 有可验证的数字，而不是把项目做成完整的监控系统。
 */

export interface SandboxAcquisitionStats {
    total: number;
    warm: number;
    cold: number;
    durationMsSum: number;
}

export interface HarnessMetricsSnapshot {
    started: boolean;
    uptimeSeconds: number;
    queueLength: number;
    runStatusCounts: Record<string, number>;
    sandboxAcquisitions: SandboxAcquisitionStats;
}

function formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return "";
    const body = entries
        .map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`)
        .join(",");
    return `{${body}}`;
}

function metricLine(
    name: string,
    value: number,
    labels: Record<string, string> = {},
): string {
    return `${name}${formatLabels(labels)} ${value}`;
}

export function renderPrometheusMetrics(
    snapshot: HarnessMetricsSnapshot,
    httpRequestsByStatus: ReadonlyMap<number, number> = new Map(),
): string {
    const lines: string[] = [];

    lines.push("# HELP harness_up 服务是否已启动");
    lines.push("# TYPE harness_up gauge");
    lines.push(metricLine("harness_up", snapshot.started ? 1 : 0));

    lines.push("# HELP harness_uptime_seconds 进程运行时长（秒）");
    lines.push("# TYPE harness_uptime_seconds gauge");
    lines.push(metricLine("harness_uptime_seconds", snapshot.uptimeSeconds));

    lines.push("# HELP harness_runs_queued 当前排队 Run 数");
    lines.push("# TYPE harness_runs_queued gauge");
    lines.push(metricLine("harness_runs_queued", snapshot.queueLength));

    lines.push("# HELP harness_runs 按状态统计的 Run 总数");
    lines.push("# TYPE harness_runs gauge");
    for (const [status, count] of Object.entries(snapshot.runStatusCounts)) {
        lines.push(metricLine("harness_runs", count, { status }));
    }

    lines.push("# HELP harness_sandbox_acquisitions_total 沙箱获取次数");
    lines.push("# TYPE harness_sandbox_acquisitions_total counter");
    lines.push(metricLine("harness_sandbox_acquisitions_total", snapshot.sandboxAcquisitions.warm, { warm: "true" }));
    lines.push(metricLine("harness_sandbox_acquisitions_total", snapshot.sandboxAcquisitions.cold, { warm: "false" }));

    lines.push("# HELP harness_sandbox_acquire_duration_ms_sum 沙箱获取耗时总和（毫秒）");
    lines.push("# TYPE harness_sandbox_acquire_duration_ms_sum counter");
    lines.push(metricLine("harness_sandbox_acquire_duration_ms_sum", snapshot.sandboxAcquisitions.durationMsSum));

    lines.push("# HELP harness_http_requests_total 按 HTTP 状态码统计的请求数");
    lines.push("# TYPE harness_http_requests_total counter");
    for (const [status, count] of httpRequestsByStatus) {
        lines.push(metricLine("harness_http_requests_total", count, { status: String(status) }));
    }

    return `${lines.join("\n")}\n`;
}
