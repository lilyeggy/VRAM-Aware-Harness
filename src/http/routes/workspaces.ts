import { HttpError, jsonResponse, readJsonObject, requiredString } from "../http-utils.ts";
import type { HttpRouteContext } from "./route-context.ts";

export async function handleWorkspacesRoute(
    request: Request,
    segments: readonly string[],
    ctx: HttpRouteContext,
): Promise<Response | null> {
    if (segments.length !== 1 || segments[0] !== "workspaces") {
        return null;
    }

    if (request.method === "POST") {
        const principal = ctx.requirePrincipal(request, "workspaces:write");
        if (ctx.accessControl === undefined) {
            throw new HttpError(501, "未配置受管 Workspace 服务");
        }
        const body = await readJsonObject(request);
        return jsonResponse({
            workspace: ctx.accessControl.workspaceService.create(
                principal.tenantId,
                requiredString(body, "name"),
            ),
        }, 201);
    }

    if (request.method === "GET") {
        const principal = ctx.requirePrincipal(request, "workspaces:read");
        if (ctx.accessControl === undefined) {
            throw new HttpError(501, "未配置受管 Workspace 服务");
        }
        return jsonResponse({
            workspaces: ctx.accessControl.workspaceService.listForTenant(
                principal.tenantId,
            ),
        });
    }

    return null;
}
