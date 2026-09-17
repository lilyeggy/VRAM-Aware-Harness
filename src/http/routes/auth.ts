import { digest } from "../../auth/api-credential-store.ts";
import type { RequestPrincipal } from "../../auth/request-principal.ts";
import type { HttpAccessControl } from "../http-contracts.ts";
import {
    HttpError,
    jsonResponse,
    readJsonObject,
    requiredString,
} from "../http-utils.ts";

export interface AuthRouteContext {
    accessControl?: HttpAccessControl;
    requirePrincipal(request: Request, scope: string): RequestPrincipal;
    audit(
        action: string,
        outcome: "ALLOW" | "DENY",
        principal: RequestPrincipal | null,
        reason: string,
        extra?: { resourceId?: string; attemptedKeyDigest?: string },
    ): void;
    auditResource(
        resourceType: "RUN" | "SESSION",
        resourceId: string | null,
        action: string,
        outcome: "ALLOW" | "DENY",
        tenantId: string | null,
        reason: string,
    ): void;
}

export async function handleAuthRoute(
    request: Request,
    segments: readonly string[],
    ctx: AuthRouteContext,
): Promise<Response | null> {
        if (request.method === "POST" && segments.join("/") === "auth/register") {
            if (!ctx.accessControl?.registerUser) throw new HttpError(503, "账户服务未启用");
            const body = await readJsonObject(request);
            try {
                return jsonResponse({ user: await ctx.accessControl.registerUser(requiredString(body, "email"), requiredString(body, "password")) }, 201);
            } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
        }
        if (request.method === "POST" && segments.join("/") === "auth/login") {
            if (!ctx.accessControl?.loginUser) throw new HttpError(503, "账户服务未启用");
            const body = await readJsonObject(request);
            const result = await ctx.accessControl.loginUser(requiredString(body, "email"), requiredString(body, "password"));
            if (result === null) throw new HttpError(401, "邮箱或密码错误");
            return jsonResponse(result);
        }
        if (request.method === "POST" && segments.join("/") === "auth/logout") {
            const authorization = request.headers.get("authorization");
            const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
            // D7：无效/已撤销的 token 不再静默成功——撤销失败返回 401，
            // 让客户端能区分"已登出"与"本来就无效"。
            if (ctx.accessControl?.revokeSession === undefined) {
                throw new HttpError(503, "账户服务未启用");
            }
            if (token === "") {
                ctx.audit("SESSION_REVOKE", "DENY", null, "missing_session_token");
                throw new HttpError(401, "无效或已过期的会话");
            }
            // D4：登出动作的审计归因到会话所有者；resourceId 用 token 摘要而非明文。
            const owner = ctx.accessControl.sessionOwner?.(token) ?? null;
            if (!ctx.accessControl.revokeSession(token)) {
                ctx.auditResource("SESSION", digest(token), "SESSION_REVOKE", "DENY", owner, "invalid_or_revoked_session");
                throw new HttpError(401, "无效或已过期的会话");
            }
            ctx.auditResource("SESSION", digest(token), "SESSION_REVOKE", "ALLOW", owner, "session_revoked");
            return jsonResponse({ ok: true });
        }
        if (request.method === "DELETE" && segments.join("/") === "auth/sessions") {
            // D7：撤销当前用户的全部活跃会话（"退出所有设备"）。
            const principal = ctx.requirePrincipal(request, "auth:revoke");
            if (ctx.accessControl?.revokeAllSessions === undefined) {
                throw new HttpError(503, "账户服务未启用");
            }
            const revoked = ctx.accessControl.revokeAllSessions(principal.tenantId);
            ctx.auditResource("SESSION", null, "SESSION_REVOKE_ALL", "ALLOW", principal.tenantId, `revoked_${revoked}_sessions`);
            return jsonResponse({ ok: true, revoked });
        }
    return null;
}
