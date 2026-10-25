import { digest } from "../../auth/api-credential-store.ts";
import { RegistrationPolicyError } from "../../auth/registration-policy.ts";
import type { RequestPrincipal } from "../../auth/request-principal.ts";
import type { HttpAccessControl } from "../http-contracts.ts";
import {
    HttpError,
    bearerToken,
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
        userId: string | null,
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
            const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode : undefined;
            try {
                return jsonResponse({
                    user: await ctx.accessControl.registerUser(
                        requiredString(body, "email"),
                        requiredString(body, "password"),
                        inviteCode,
                    ),
                }, 201);
            } catch (error) {
                // 注册策略拒绝是 403（不是账号冲突的 409），让客户端/日志能区分。
                if (error instanceof RegistrationPolicyError) {
                    throw new HttpError(403, error.message);
                }
                const message = error instanceof Error ? error.message : String(error);
                // F10：重复邮箱只回一个稳定的 409，不透出 SQLite 的
                // "UNIQUE constraint failed: users.email"（可能含 schema/表名）。
                if (message.includes("UNIQUE constraint failed") || message.includes("SQLITE_CONSTRAINT")) {
                    throw new HttpError(409, "该邮箱已被注册");
                }
                // 已知的输入校验错误是安全的客户端错误（400）；其余交给
                // HarnessHttpApi 的 500 通用兜底，避免把内部细节当业务错误返回。
                if (message === "邮箱格式无效" || message === "密码至少需要 8 个字符") {
                    throw new HttpError(400, message);
                }
                throw error;
            }
        }
        if (request.method === "POST" && segments.join("/") === "auth/login") {
            if (!ctx.accessControl?.loginUser) throw new HttpError(503, "账户服务未启用");
            const body = await readJsonObject(request);
            const result = await ctx.accessControl.loginUser(requiredString(body, "email"), requiredString(body, "password"));
            if (result === null) throw new HttpError(401, "邮箱或密码错误");
            return jsonResponse(result);
        }
        if (request.method === "POST" && segments.join("/") === "auth/logout") {
            const token = bearerToken(request) ?? "";
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
            const revoked = ctx.accessControl.revokeAllSessions(principal.userId);
            ctx.auditResource("SESSION", null, "SESSION_REVOKE_ALL", "ALLOW", principal.userId, `revoked_${revoked}_sessions`);
            return jsonResponse({ ok: true, revoked });
        }
    return null;
}
