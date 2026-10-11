import { HttpError, jsonResponse } from "../http-utils.ts";
import { renderPrometheusMetrics } from "../../observability/metrics.ts";
import { userConsoleResponse } from "../harness-user-console.ts";
import type { HttpRouteContext } from "./route-context.ts";


/**
 * 读取并校验分页查询参数；非法值返回 400，而不是静默退回默认值。
 */
function readPageParam(
    url: URL,
    name: string,
    min: number,
    max: number,
): number | undefined {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.trim() === "") {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new HttpError(400, `${name} 必须是 ${min}..${max} 的整数`);
    }
    return value;
}

export async function handleSystemRoute(
    request: Request,
    segments: readonly string[],
    ctx: HttpRouteContext,
): Promise<Response | null> {
    if (request.method === "GET" && segments.length === 0) {
        return Response.redirect(new URL("/app", request.url).toString(), 302);
    }

    if (request.method === "GET" && segments.length === 1 && segments[0] === "app") {
        return userConsoleResponse();
    }

    if (request.method === "GET" && segments.length === 1) {
        switch (segments[0]) {
            case "health":
                return jsonResponse({
                    ok: ctx.application.isStarted(),
                    started: ctx.application.isStarted(),
                });
            case "ready": {
                const ready = ctx.application.isStarted();
                return jsonResponse({ ready }, ready ? 200 : 503);
            }
            case "queue": {
                const principal = ctx.requirePrincipal(request, "tasks:read");
                return jsonResponse({
                    queue: ctx.accessControl === undefined
                        ? ctx.application.getQueue()
                        : ctx.application.getQueue().filter((entry) =>
                            entry.tenantId === principal.tenantId),
                });
            }
            case "metrics": {
                // §9.8 v1.4：最小可观测性；只暴露进程内计数与 RunStore 聚合，
                // 不引入 Prometheus SDK，也不泄漏租户级明细。
                ctx.requirePrincipal(request, "metrics:read");
                const snapshot = ctx.application.getMetricsSnapshot?.();
                if (snapshot === undefined) {
                    throw new HttpError(501, "未配置指标");
                }
                return new Response(
                    renderPrometheusMetrics(snapshot, ctx.httpRequestCounts),
                    {
                        status: 200,
                        headers: {
                            "content-type": "text/plain; version=0.0.4; charset=utf-8",
                        },
                    },
                );
            }
            case "resources": {
                const principal = ctx.requirePrincipal(request, "resources:read");
                // D3：主机级资源遥测（共享 GPU 池/vLLM 后端）不含跨租户数据，
                // 但可见性是"有意的主机级"而非"遗漏的租户过滤"——显式标注，
                // 并保留 principal 供将来引入租户切片视图（如按租户 token 配额）。
                return jsonResponse({
                    visibility: "HOST_WIDE",
                    requestedByTenant: principal.tenantId,
                    samples: ctx.resourceMetrics?.getSamples() ?? [],
                    observation: await ctx.application.observeResources(),
                });
            }
            case "audit": {
                const principal = ctx.requirePrincipal(request, "audits:read");
                if (ctx.accessControl?.auditStore === undefined) {
                    throw new HttpError(501, "未配置访问审计服务");
                }
                const url = new URL(request.url);
                // F12：分页参数显式校验，拒绝 NaN/负数/超大值，避免无效 OFFSET 扫描。
                const limit = readPageParam(url, "limit", 1, 500);
                const offset = readPageParam(url, "offset", 0, 1_000_000);
                return jsonResponse({
                    events: ctx.accessControl.auditStore.listForTenant(principal.tenantId, {
                        ...(limit === undefined ? {} : { limit }),
                        ...(offset === undefined ? {} : { offset }),
                    }),
                });
            }
            case "billing": {
                const principal = ctx.requirePrincipal(request, "billing:read");
                if (ctx.accessControl?.billingStore === undefined) {
                    throw new HttpError(501, "未配置租户账单服务");
                }
                return jsonResponse({
                    billing: ctx.accessControl.billingStore.summarize(principal.tenantId),
                });
            }
        }
    }

    return null;
}
