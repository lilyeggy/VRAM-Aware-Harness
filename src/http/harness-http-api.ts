import { randomUUID } from "node:crypto";
import type { RequestPrincipal } from "../auth/request-principal.ts";
import { digest } from "../auth/api-credential-store.ts";
import { hasScope } from "../auth/request-principal.ts";
import type { LlmGateway } from "../llm-gateway/llm-gateway.ts";
import type { AgentRun } from "../runs/agent-run.ts";
import { RunBindingError } from "../runs/runstore.ts";
import type {
    CheckpointLookup,
    HarnessHttpApplication,
    HttpAccessControl,
} from "./http-contracts.ts";
import { HttpError, bearerToken, jsonResponse } from "./http-utils.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import { handleAuthRoute } from "./routes/auth.ts";
import { handleConversationsRoute } from "./routes/conversations.ts";
import { handleGatewayRoute } from "./routes/gateway.ts";
import type { HttpRouteContext } from "./routes/route-context.ts";
import { handleRunsRoute } from "./routes/runs.ts";
import { handleSystemRoute } from "./routes/system.ts";
import { handleWorkspacesRoute } from "./routes/workspaces.ts";

export type {
    CheckpointLookup,
    HarnessHttpApplication,
    HttpAccessControl,
    UnknownEffectResolution,
} from "./http-contracts.ts";

/**
 * Day7 的最小 HTTP 协议层。
 *
 * 它只负责依赖注入、路由分发和共享 middleware；具体路由已经拆到
 * ./routes/*。调度、恢复、资源准入和持久化继续由 HarnessApplication 负责。
 */
export class HarnessHttpApi implements HttpRouteContext {
    constructor(
        readonly application: HarnessHttpApplication,
        readonly checkpointLookup: CheckpointLookup,
        readonly accessControl?: HttpAccessControl,
        readonly llmGateway?: LlmGateway,
        readonly limits?: { maxUserInputChars: number },
        readonly rateLimiter?: RateLimiter,
        readonly trustProxy = false,
    ) {}

    /** 同一请求可能多次 requirePrincipal（例如先读 run 再读 events）；用户限流只记一次。 */
    private readonly userRateLimited = new WeakSet<Request>();

    /** §9.8 v1.4：进程内 HTTP 状态码计数，供 /metrics 渲染。 */
    readonly httpRequestCounts = new Map<number, number>();

    async fetch(request: Request, clientIp?: string): Promise<Response> {
        try {
            this.enforceIpRateLimit(request, clientIp);
            const response = await this.route(request);
            this.recordHttpStatus(response.status);
            return response;
        } catch (error) {
            if (error instanceof RunBindingError) {
                this.recordHttpStatus(409);
                return jsonResponse({ error: error.message }, 409);
            }
            if (error instanceof HttpError) {
                this.recordHttpStatus(error.status);
                return jsonResponse({ error: error.message }, error.status, error.headers);
            }

            // F10：未知异常是服务端内部错误，语义应为 500，且不能把
            // Bun/SQLite 的原始 message（可能含文件路径、SQL 片段、邮箱唯一约束）
            // 透给客户端。给客户端一个通用文案 + requestId，原文只进服务端日志。
            const requestId = randomUUID().slice(0, 8);
            console.error(`[http] 内部错误 requestId=${requestId}`, error);
            this.recordHttpStatus(500);
            return jsonResponse({
                error: "内部错误，请稍后重试",
                requestId,
            }, 500);
        }
    }

    private recordHttpStatus(status: number): void {
        this.httpRequestCounts.set(status, (this.httpRequestCounts.get(status) ?? 0) + 1);
    }

    private enforceIpRateLimit(request: Request, clientIp?: string): void {
        if (this.rateLimiter === undefined || this.rateLimiter.enabled === false) {
            return;
        }

        const path = new URL(request.url).pathname;
        // 健康检查/就绪探针不应被限流，否则反向代理或监控会把服务打成 429。
        if (path === "/health" || path === "/ready") return;

        const decision = this.rateLimiter.consumeIp(this.resolveClientIp(request, clientIp));
        if (decision.allowed === false) {
            throw new HttpError(429, "请求过于频繁，请稍后再试", {
                "retry-after": String(decision.retryAfterSeconds),
                "x-ratelimit-limit": String(decision.limit),
                "x-ratelimit-remaining": "0",
            });
        }
    }

    private enforceUserRateLimit(request: Request, userId: string): void {
        if (this.rateLimiter === undefined || this.rateLimiter.enabled === false) {
            return;
        }
        if (this.userRateLimited.has(request)) return;
        this.userRateLimited.add(request);

        const decision = this.rateLimiter.consumeUser(userId);
        if (decision.allowed === false) {
            throw new HttpError(429, "用户请求过于频繁，请稍后再试", {
                "retry-after": String(decision.retryAfterSeconds),
                "x-ratelimit-limit": String(decision.limit),
                "x-ratelimit-remaining": "0",
            });
        }
    }

    private resolveClientIp(request: Request, clientIp?: string): string {
        if (this.trustProxy) {
            const forwarded = request.headers.get("x-forwarded-for");
            const first = forwarded?.split(",")[0]?.trim();
            if (first !== undefined && first.length > 0) return first;
        }
        return clientIp ?? "unknown";
    }

    private async route(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const segments = url.pathname
            .split("/")
            .filter(Boolean)
            .map((segment) => decodeURIComponent(segment));
        const ctx: HttpRouteContext = this;

        const authResponse = await handleAuthRoute(request, segments, ctx);
        if (authResponse !== null) return authResponse;

        const systemResponse = await handleSystemRoute(request, segments, ctx);
        if (systemResponse !== null) return systemResponse;

        const workspacesResponse = await handleWorkspacesRoute(request, segments, ctx);
        if (workspacesResponse !== null) return workspacesResponse;

        const conversationsResponse = await handleConversationsRoute(request, segments, ctx);
        if (conversationsResponse !== null) return conversationsResponse;

        const runsResponse = await handleRunsRoute(request, segments, ctx);
        if (runsResponse !== null) return runsResponse;

        const gatewayResponse = await handleGatewayRoute(request, segments, ctx);
        if (gatewayResponse !== null) return gatewayResponse;

        throw new HttpError(404, "找不到 HTTP 路由");
    }

    getRequiredRun(
        runId: string,
        request?: Request,
        scope = "tasks:read",
    ): AgentRun {
        const run = this.application.getRun(runId);

        if (run === null) {
            throw new HttpError(404, `找不到 AgentRun：${runId}`);
        }
        if (request !== undefined && this.accessControl !== undefined) {
            const principal = this.requirePrincipal(request, scope);
            if (run.userId !== principal.userId) {
                throw new HttpError(404, `找不到 AgentRun：${runId}`);
            }
        }

        return run;
    }

    requirePrincipal(request: Request, scope: string): RequestPrincipal {
        if (this.accessControl === undefined) {
            // Retained only for direct legacy unit tests; composition always injects auth.
            this.enforceUserRateLimit(request, "legacy");
            return { userId: "legacy", scopes: ["*"] };
        }
        const rawKey = bearerToken(request)
            ?? request.headers.get("x-api-key")?.trim();
        if (rawKey === undefined || rawKey.length === 0) {
            this.audit("AUTHENTICATE", "DENY", null, "missing_api_key");
            throw new HttpError(401, "缺少 API Key");
        }
        const principal = this.accessControl.authenticate(rawKey);
        if (principal === null) {
            // D4：DENY 记录被尝试密钥的摘要（不存明文），用户归属对
            // 无效密钥天然不可知，因此 userId 保持 NULL。
            this.audit("AUTHENTICATE", "DENY", null, "invalid_or_revoked_api_key", {
                attemptedKeyDigest: digest(rawKey),
            });
            throw new HttpError(401, "API Key 无效或已撤销");
        }
        if (hasScope(principal, scope) === false) {
            this.audit(scope, "DENY", principal, "missing_scope");
            throw new HttpError(403, `缺少权限：${scope}`);
        }
        this.enforceUserRateLimit(request, principal.userId);
        this.audit(scope, "ALLOW", principal, "scope_granted");
        return principal;
    }

    audit(
        action: string,
        outcome: "ALLOW" | "DENY",
        principal: RequestPrincipal | null,
        reason: string,
        extra: { resourceId?: string; attemptedKeyDigest?: string } = {},
    ): void {
        this.accessControl?.auditStore?.record({
            action, outcome,
            userId: principal?.userId ?? null,
            resourceType: "HTTP_REQUEST",
            resourceId: extra.resourceId ?? null,
            reason,
            attemptedKeyDigest: extra.attemptedKeyDigest ?? null,
        });
    }

    /**
     * D4：资源级审计——interrupt/resume/提交等动作直接落在具体资源上，
     * 而不是只有 "HTTP_REQUEST + scope" 一层。
     */
    auditResource(
        resourceType: "RUN" | "SESSION",
        resourceId: string | null,
        action: string,
        outcome: "ALLOW" | "DENY",
        userId: string | null,
        reason: string,
    ): void {
        this.accessControl?.auditStore?.record({
            action, outcome,
            userId,
            resourceType,
            resourceId,
            reason,
            attemptedKeyDigest: null,
        });
    }
}
