import type { RequestPrincipal } from "../auth/request-principal.ts";
import { digest } from "../auth/api-credential-store.ts";
import { hasScope } from "../auth/request-principal.ts";
import type { LlmGateway } from "../llm-gateway/llm-gateway.ts";
import type { ResourceMetricsSampler } from "../resources/resource-metrics-sampler.ts";
import type { AgentRun } from "../runs/agent-run.ts";
import type {
    CheckpointLookup,
    HarnessHttpApplication,
    HttpAccessControl,
} from "./http-contracts.ts";
import { HttpError, jsonResponse } from "./http-utils.ts";
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
export class HarnessHttpApi {
    constructor(
        private readonly application: HarnessHttpApplication,
        private readonly checkpointLookup: CheckpointLookup,
        private readonly accessControl?: HttpAccessControl,
        private readonly llmGateway?: LlmGateway,
        private readonly resourceMetrics?: ResourceMetricsSampler,
        private readonly limits?: { maxUserInputChars: number },
    ) {}

    async fetch(request: Request): Promise<Response> {
        try {
            return await this.route(request);
        } catch (error) {
            if (error instanceof HttpError) {
                return jsonResponse({ error: error.message }, error.status);
            }

            return jsonResponse({
                error: error instanceof Error
                    ? error.message
                    : String(error),
            }, 409);
        }
    }

    private async route(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const segments = url.pathname
            .split("/")
            .filter(Boolean)
            .map((segment) => decodeURIComponent(segment));
        const ctx = this as unknown as HttpRouteContext;

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

    private getRequiredRun(
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
            if (run.tenantId !== principal.tenantId) {
                throw new HttpError(404, `找不到 AgentRun：${runId}`);
            }
        }

        return run;
    }

    private requirePrincipal(request: Request, scope: string): RequestPrincipal {
        if (this.accessControl === undefined) {
            // Retained only for direct legacy unit tests; composition always injects auth.
            return { tenantId: "legacy", scopes: ["*"] };
        }
        const authorization = request.headers.get("authorization");
        const rawKey = authorization?.startsWith("Bearer ")
            ? authorization.slice("Bearer ".length).trim()
            : request.headers.get("x-api-key")?.trim();
        if (rawKey === undefined || rawKey.length === 0) {
            this.audit("AUTHENTICATE", "DENY", null, "missing_api_key");
            throw new HttpError(401, "缺少 API Key");
        }
        const principal = this.accessControl.authenticate(rawKey);
        if (principal === null) {
            // D4：DENY 记录被尝试密钥的摘要（不存明文），租户归属对
            // 无效密钥天然不可知，因此 tenantId 保持 NULL。
            this.audit("AUTHENTICATE", "DENY", null, "invalid_or_revoked_api_key", {
                attemptedKeyDigest: digest(rawKey),
            });
            throw new HttpError(401, "API Key 无效或已撤销");
        }
        if (hasScope(principal, scope) === false) {
            this.audit(scope, "DENY", principal, "missing_scope");
            throw new HttpError(403, `缺少权限：${scope}`);
        }
        this.audit(scope, "ALLOW", principal, "scope_granted");
        return principal;
    }

    private audit(
        action: string,
        outcome: "ALLOW" | "DENY",
        principal: RequestPrincipal | null,
        reason: string,
        extra: { resourceId?: string; attemptedKeyDigest?: string } = {},
    ): void {
        this.accessControl?.auditStore?.record({
            action, outcome,
            tenantId: principal?.tenantId ?? null,
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
    private auditResource(
        resourceType: "RUN" | "SESSION",
        resourceId: string | null,
        action: string,
        outcome: "ALLOW" | "DENY",
        tenantId: string | null,
        reason: string,
    ): void {
        this.accessControl?.auditStore?.record({
            action, outcome,
            tenantId,
            resourceType,
            resourceId,
            reason,
            attemptedKeyDigest: null,
        });
    }
}
