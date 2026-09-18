import type { RequestPrincipal } from "../../auth/request-principal.ts";
import type { AgentRun } from "../../runs/agent-run.ts";
import type { LlmGateway } from "../../llm-gateway/llm-gateway.ts";
import type { ResourceMetricsSampler } from "../../resources/resource-metrics-sampler.ts";
import type {
    CheckpointLookup,
    HarnessHttpApplication,
    HttpAccessControl,
} from "../http-contracts.ts";

/**
 * 路由模块共享上下文：只注入依赖和统一 middleware，不携带具体路由实现。
 * HarnessHttpApi 在分发时把自身按此接口传入，保持 auth 路由的既有模式。
 */
export interface HttpRouteContext {
    readonly application: HarnessHttpApplication;
    readonly checkpointLookup: CheckpointLookup;
    readonly accessControl?: HttpAccessControl;
    readonly llmGateway?: LlmGateway;
    readonly resourceMetrics?: ResourceMetricsSampler;
    readonly limits?: { maxUserInputChars: number };

    requirePrincipal(request: Request, scope: string): RequestPrincipal;
    getRequiredRun(runId: string, request?: Request, scope?: string): AgentRun;
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
