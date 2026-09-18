import { HttpError, jsonResponse } from "../http-utils.ts";
import { userConsoleResponse } from "../harness-user-console.ts";
import type { HttpRouteContext } from "./route-context.ts";

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
                const limitParam = Number(url.searchParams.get("limit") ?? undefined);
                const offsetParam = Number(url.searchParams.get("offset") ?? undefined);
                return jsonResponse({
                    events: ctx.accessControl.auditStore.listForTenant(principal.tenantId, {
                        ...(Number.isFinite(limitParam) ? { limit: limitParam } : {}),
                        ...(Number.isFinite(offsetParam) ? { offset: offsetParam } : {}),
                    }),
                });
            }
        }
    }

    return null;
}
