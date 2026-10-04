/**
 * 路由层共享的归属校验助手。
 *
 * 「鉴权 + 取资源 + 租户归属校验 + DENY 审计」原先在 runs/conversations
 * 路由里逐份复制，归属判断一旦漂移（比如漏掉 404 防枚举）就是越权漏洞，
 * 这里收敛为唯一实现。
 */
import type { RequestPrincipal } from "../../auth/request-principal.ts";
import type { AgentRun } from "../../runs/agent-run.ts";
import type { Workspace } from "../../workspaces/workspace-store.ts";
import { HttpError } from "../http-utils.ts";
import type { HttpRouteContext } from "./route-context.ts";

/** 写操作共用：tasks:write 鉴权 + 取 Run + 租户归属校验。 */
export function requireOwnedRun(
    request: Request,
    runId: string,
    ctx: HttpRouteContext,
    action: string,
): { principal: RequestPrincipal; run: AgentRun } {
    const principal = ctx.requirePrincipal(request, "tasks:write");
    const run = ctx.getRequiredRun(runId);
    if (ctx.accessControl !== undefined && run.tenantId !== principal.tenantId) {
        ctx.auditResource("RUN", runId, action, "DENY", principal.tenantId, "run_not_owned");
        // Deliberately indistinguishable from an absent resource (anti-enumeration).
        throw new HttpError(404, `找不到 AgentRun：${runId}`);
    }
    return { principal, run };
}

/** 租户归属校验后的 Workspace；服务未启用 501，不归属/不存在一律 404。 */
export function requireOwnedWorkspace(
    ctx: HttpRouteContext,
    workspaceId: string,
    tenantId: string,
): Workspace {
    if (ctx.accessControl === undefined) {
        throw new HttpError(501, "Workspace 服务未启用");
    }
    const workspace = ctx.accessControl.workspaceService.getForTenant(
        workspaceId,
        tenantId,
    );
    if (workspace === null) throw new HttpError(404, "找不到 Workspace");
    return workspace;
}
