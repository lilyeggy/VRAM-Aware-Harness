import type {
    Checkpoint,
} from "../checkpoints/checkpoint.ts";
import type {
    PolicyDecision,
} from "../resources/execution-policy.ts";
import type {
    ResourceObservation,
} from "../resources/resource-observer.ts";
import type {
    AgentRun,
    RunEvent,
} from "../runs/agent-run.ts";
import type {
    ResumeRunInput,
    StartRunInput,
} from "../runs/run-service.ts";
import type {
    QueueEntry,
} from "../scheduling/tenant-run-scheduler.ts";
import type { RequestPrincipal } from "../auth/request-principal.ts";
import { hasScope } from "../auth/request-principal.ts";
import type { WorkspaceService } from "../workspaces/workspace-service.ts";
import type { RunOutputChunk } from "../runs/run-output-store.ts";
import type { WorkspaceDiff } from "../workspaces/workspace-snapshot.ts";
import type { RunArtifact } from "../workspaces/run-artifact-store.ts";
import type { AccessAuditStore } from "../audit/access-audit-store.ts";
import type { EvaluationAggregator } from "../eval/evaluation-aggregator.ts";
import { dashboardResponse } from "./harness-dashboard.ts";
import { observePageResponse } from "./harness-observe-page.ts";

export interface HarnessHttpApplication {
    isStarted():boolean;
    submitRun(input:StartRunInput):AgentRun;
    getRun(runId:string):AgentRun | null;
    getRunsForTenant(tenantId:string):AgentRun[];
    getRunEvents(runId:string):RunEvent[];
    getRunOutput(runId:string):{ chunks: RunOutputChunk[]; finalText: string };
    getRunWorkspaceDiff(runId:string):WorkspaceDiff | null;
    getRunArtifacts(runId:string):RunArtifact[];
    getRunArtifact(runId:string, path:string):Promise<Uint8Array | null>;
    getRunDecisions(runId:string):PolicyDecision[];
    getQueue():QueueEntry[];
    observeResources():Promise<ResourceObservation>;
    interruptRun(runId:string):Promise<AgentRun>;
    resumeRun(input:ResumeRunInput):AgentRun;
}

export interface CheckpointLookup {
    get(checkpointId:string):Checkpoint | null;
}

export interface HttpAccessControl {
    authenticate(rawKey: string): RequestPrincipal | null;
    workspaceService: WorkspaceService;
    auditStore?: AccessAuditStore;
}

class HttpError extends Error {
    constructor(
        readonly status:number,
        message:string,
    ) {
        super(message);
    }
}

/**
 * Day7 的最小 HTTP 协议层。
 *
 * 它只负责路由、输入校验和 JSON 转换；调度、恢复、资源准入和持久化
 * 都继续由 HarnessApplication 及其下层组件负责。
 */
export class HarnessHttpApi {
    constructor(
        private readonly application:HarnessHttpApplication,
        private readonly checkpointLookup:CheckpointLookup,
        private readonly accessControl?:HttpAccessControl,
        private readonly evaluation?:EvaluationAggregator,
    ) {}

    async fetch(request:Request):Promise<Response> {
        try {
            return await this.route(request);
        } catch (error) {
            if (error instanceof HttpError) {
                return jsonResponse({ error:error.message }, error.status);
            }

            return jsonResponse({
                error:error instanceof Error
                    ? error.message
                    : String(error),
            }, 409);
        }
    }

    private async route(request:Request):Promise<Response> {
        const url = new URL(request.url);
        const segments = url.pathname
            .split("/")
            .filter(Boolean)
            .map((segment) => decodeURIComponent(segment));

        if (request.method === "GET" && segments.length === 0) {
            return dashboardResponse();
        }

        if (request.method === "GET" && segments.length === 1) {
            switch (segments[0]) {
                case "health":
                    return jsonResponse({
                        ok:this.application.isStarted(),
                        started:this.application.isStarted(),
                    });
                case "queue":
                    return this.getQueue(request);
                case "workspaces":
                    return this.listWorkspaces(request);
                case "resources": {
                    const principal = this.requirePrincipal(request, "resources:read");
                    void principal;
                    return jsonResponse({
                        observation:
                            await this.application.observeResources(),
                    });
                }
                case "audit":
                    return this.listAuditEvents(request);
                case "observe":
                    return observePageResponse();
                case "eval": {
                    if (this.evaluation === undefined) {
                        throw new HttpError(503, "评测能力未启用");
                    }
                    // 无认证模式（本地/演示）可用 ?tenant= 过滤；有认证则按租户隔离。
                    if (this.accessControl === undefined) {
                        const tenantFilter =
                            url.searchParams.get("tenant") ?? undefined;
                        const runs = this.evaluation.listRunMetrics(tenantFilter);
                        return jsonResponse({
                            scope: tenantFilter ?? "all-tenants",
                            tenants: this.evaluation.listTenants(),
                            executionQuality: this.evaluation.summarize(runs),
                            resourceAdmission:
                                this.evaluation.computeResourceEvaluation(
                                    tenantFilter,
                                ),
                            runs,
                        });
                    }
                    const principal =
                        this.requirePrincipal(request, "tasks:read");
                    const runs =
                        this.evaluation.listRunMetrics(principal.tenantId);
                    return jsonResponse({
                        scope: principal.tenantId,
                        tenants: [principal.tenantId],
                        executionQuality: this.evaluation.summarize(runs),
                        resourceAdmission:
                            this.evaluation.computeResourceEvaluation(
                                principal.tenantId,
                            ),
                        runs,
                    });
                }
            }
        }

        if (
            request.method === "POST"
            && segments.length === 1
            && segments[0] === "workspaces"
        ) {
            return this.createWorkspace(request);
        }

        if (
            request.method === "POST"
            && segments.length === 1
            && segments[0] === "runs"
        ) {
            return this.submitRun(request);
        }

        if (
            request.method === "GET"
            && segments.length === 1
            && segments[0] === "runs"
        ) {
            const principal = this.requirePrincipal(request, "tasks:read");
            return jsonResponse({
                runs: this.accessControl === undefined
                    ? []
                    : this.application.getRunsForTenant(principal.tenantId),
            });
        }

        if (segments[0] === "runs" && segments.length >= 2) {
            const runId = segments[1];

            if (runId === undefined || runId.length === 0) {
                throw new HttpError(400, "runId 不能为空");
            }

            if (
                request.method === "GET"
                && segments.length === 2
            ) {
                const run = this.getRequiredRun(runId, request, "tasks:read");

                return jsonResponse({
                    run,
                    decisions:this.application.getRunDecisions(runId),
                });
            }

            if (
                request.method === "GET"
                && segments.length === 3
                && segments[2] === "events"
            ) {
                this.getRequiredRun(runId, request, "tasks:read");

                return jsonResponse({
                    events:this.application.getRunEvents(runId),
                });
            }

            if (
                request.method === "GET"
                && segments.length === 3
                && segments[2] === "output"
            ) {
                this.getRequiredRun(runId, request, "tasks:read");
                return jsonResponse(this.application.getRunOutput(runId));
            }

            if (
                request.method === "GET"
                && segments.length === 3
                && segments[2] === "workspace-diff"
            ) {
                this.getRequiredRun(runId, request, "tasks:read");
                return jsonResponse({ diff: this.application.getRunWorkspaceDiff(runId) });
            }

            if (request.method === "GET" && segments.length === 3 && segments[2] === "artifacts") {
                this.getRequiredRun(runId, request, "tasks:read");
                return jsonResponse({ artifacts: this.application.getRunArtifacts(runId) });
            }

            if (request.method === "GET" && segments.length === 4 && segments[2] === "artifacts") {
                this.getRequiredRun(runId, request, "tasks:read");
                const body = await this.application.getRunArtifact(runId, segments[3] ?? "");
                if (body === null) throw new HttpError(404, "找不到 Artifact");
                return new Response(body, { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment" } });
            }

            if (
                request.method === "POST"
                && segments.length === 3
                && segments[2] === "interrupt"
            ) {
                this.getRequiredRun(runId, request, "tasks:write");

                return jsonResponse({
                    run:await this.application.interruptRun(runId),
                });
            }

            if (
                request.method === "POST"
                && segments.length === 3
                && segments[2] === "resume"
            ) {
                return this.resumeRun(request, runId);
            }
        }

        throw new HttpError(404, "找不到 HTTP 路由");
    }

    private async submitRun(request:Request):Promise<Response> {
        const body = await readJsonObject(request);
        const principal = this.requirePrincipal(request, "tasks:write");
        const workspace = this.accessControl === undefined
            ? null
            : this.accessControl.workspaceService.getForTenant(
                requiredString(body, "workspaceId"),
                principal.tenantId,
            );
        if (this.accessControl !== undefined && workspace === null) {
            // Deliberately indistinguishable from an absent resource (anti-enumeration).
            throw new HttpError(404, "找不到 Workspace");
        }
        const run = this.application.submitRun({
            tenantId:this.accessControl === undefined
                ? requiredString(body, "tenantId")
                : principal.tenantId,
            harnessSessionId:
                optionalString(body, "sessionId")
                ?? optionalString(body, "harnessSessionId")
                ?? crypto.randomUUID(),
            userInput:requiredString(body, "userInput"),
            workspacePath:this.accessControl === undefined
                ? requiredString(body, "workspacePath")
                : (workspace as NonNullable<typeof workspace>).rootPath,
        });

        return jsonResponse({ run }, 202);
    }

    private async resumeRun(
        request:Request,
        runId:string,
    ):Promise<Response> {
        const run = this.getRequiredRun(runId, request, "tasks:write");

        if (run.checkpointId === null) {
            throw new HttpError(409, `Run 没有可用 Checkpoint：${runId}`);
        }

        const checkpoint = this.checkpointLookup.get(run.checkpointId);

        if (checkpoint === null || checkpoint.runId !== runId) {
            throw new HttpError(
                409,
                `Run 的 Checkpoint 不存在或不匹配：${runId}`,
            );
        }

        const body = await readOptionalJsonObject(request);
        const queuedRun = this.application.resumeRun({
            runId,
            checkpoint,
            continuationInput:
                optionalString(body, "continuationInput")
                ?? "请从恢复点继续完成任务",
        });

        return jsonResponse({ run:queuedRun }, 202);
    }

    private getRequiredRun(
        runId:string,
        request?:Request,
        scope = "tasks:read",
    ):AgentRun {
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

    private getQueue(request: Request): Response {
        const principal = this.requirePrincipal(request, "tasks:read");
        return jsonResponse({
            queue: this.accessControl === undefined
                ? this.application.getQueue()
                : this.application.getQueue().filter((entry) =>
                    entry.tenantId === principal.tenantId),
        });
    }

    private async createWorkspace(request: Request): Promise<Response> {
        const principal = this.requirePrincipal(request, "workspaces:write");
        if (this.accessControl === undefined) {
            throw new HttpError(501, "未配置受管 Workspace 服务");
        }
        const body = await readJsonObject(request);
        return jsonResponse({
            workspace: this.accessControl.workspaceService.create(
                principal.tenantId,
                requiredString(body, "name"),
            ),
        }, 201);
    }

    private listWorkspaces(request: Request): Response {
        const principal = this.requirePrincipal(request, "workspaces:read");
        if (this.accessControl === undefined) {
            throw new HttpError(501, "未配置受管 Workspace 服务");
        }
        return jsonResponse({
            workspaces: this.accessControl.workspaceService.listForTenant(
                principal.tenantId,
            ),
        });
    }

    private listAuditEvents(request: Request): Response {
        const principal = this.requirePrincipal(request, "audits:read");
        if (this.accessControl?.auditStore === undefined) {
            throw new HttpError(501, "未配置访问审计服务");
        }
        return jsonResponse({
            events: this.accessControl.auditStore.listForTenant(principal.tenantId),
        });
    }

    private requirePrincipal(request: Request, scope: string): RequestPrincipal {
        if (this.accessControl === undefined) {
            // Retained only for direct legacy unit tests; composition always injects auth.
            return { subjectId: "legacy-test", tenantId: "legacy", scopes: ["*"] };
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
            this.audit("AUTHENTICATE", "DENY", null, "invalid_or_revoked_api_key");
            throw new HttpError(401, "API Key 无效或已撤销");
        }
        if (!hasScope(principal, scope)) {
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
    ): void {
        this.accessControl?.auditStore?.record({
            action, outcome,
            subjectId: principal?.subjectId ?? null,
            tenantId: principal?.tenantId ?? null,
            resourceType: "HTTP_REQUEST",
            resourceId: null,
            reason,
        });
    }
}

async function readJsonObject(
    request:Request,
):Promise<Record<string,unknown>> {
    let body:unknown;

    try {
        body = await request.json();
    } catch {
        throw new HttpError(400, "请求体必须是有效 JSON");
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new HttpError(400, "请求体必须是 JSON 对象");
    }

    return body as Record<string,unknown>;
}

async function readOptionalJsonObject(
    request:Request,
):Promise<Record<string,unknown>> {
    const text = await request.text();

    if (text.trim().length === 0) {
        return {};
    }

    let body:unknown;

    try {
        body = JSON.parse(text) as unknown;
    } catch {
        throw new HttpError(400, "请求体必须是有效 JSON");
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new HttpError(400, "请求体必须是 JSON 对象");
    }

    return body as Record<string,unknown>;
}

function requiredString(
    body:Record<string,unknown>,
    field:string,
):string {
    const value = optionalString(body, field);

    if (value === null) {
        throw new HttpError(400, `${field} 必须是非空字符串`);
    }

    return value;
}

function optionalString(
    body:Record<string,unknown>,
    field:string,
):string | null {
    const value = body[field];

    if (value === undefined) {
        return null;
    }

    if (typeof value !== "string" || value.trim().length === 0) {
        throw new HttpError(400, `${field} 必须是非空字符串`);
    }

    return value;
}

function jsonResponse(value:unknown, status = 200):Response {
    return new Response(JSON.stringify(value), {
        status,
        headers:{
            "content-type":"application/json; charset=utf-8",
        },
    });
}
