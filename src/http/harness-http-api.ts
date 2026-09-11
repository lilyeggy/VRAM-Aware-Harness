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
import {
    buildRecoveryContinuationInput,
    type ResumeRunInput,
    type StartRunInput,
} from "../runs/run-service.ts";
import type {
    QueueEntry,
} from "../scheduling/tenant-run-scheduler.ts";
import type { RequestPrincipal } from "../auth/request-principal.ts";
import { digest } from "../auth/api-credential-store.ts";
import { hasScope } from "../auth/request-principal.ts";
import type { WorkspaceService } from "../workspaces/workspace-service.ts";
import type { RunLimitation } from "../policies/run-limitations.ts";
import type { RunOutputChunk } from "../runs/run-output-store.ts";
import type { WorkspaceDiff } from "../workspaces/workspace-snapshot.ts";
import type { RunArtifact } from "../workspaces/run-artifact-store.ts";
import type { AccessAuditStore } from "../audit/access-audit-store.ts";
import type { HarnessInstance } from "../instances/harness-instance.ts";
import type { EvaluationAggregator } from "../eval/evaluation-aggregator.ts";
import type { LlmGateway } from "../llm-gateway/llm-gateway.ts";
import { platformDashboardResponse } from "./harness-platform-dashboard.ts";
import { userConsoleResponse } from "./harness-user-console.ts";
import type { Conversation } from "../conversations/conversation.ts";

export interface HarnessHttpApplication {
    isStarted():boolean;
    submitRun(input:StartRunInput):AgentRun;
    getRun(runId:string):AgentRun | null;
    getRunsForTenant(tenantId:string):AgentRun[];
    createConversation?(input: { tenantId: string; workspaceId: string; title?: string }): Conversation;
    getConversation?(id: string, tenantId: string): Conversation | null;
    getConversationsForWorkspace?(tenantId: string, workspaceId: string): Conversation[];
    getRunsForConversation?(tenantId: string, conversationId: string): AgentRun[];
    touchConversation?(id: string, tenantId: string): void;
    /** B6：会话归属查询；未提供时跳过会话抢注校验（兼容最小装配）。 */
    resolveSessionOwner?(harnessSessionId: string): string | null;
    getAgentsForTenant?(tenantId:string):HarnessInstance[];
    getRunEvents(runId:string):RunEvent[];
    getRunOutput(runId:string):{ chunks: RunOutputChunk[]; finalText: string; thinkingText?: string };
    getRunWorkspaceDiff(runId:string):WorkspaceDiff | null;
    getRunArtifacts(runId:string):RunArtifact[];
    getRunArtifact(runId:string, path:string):Promise<Uint8Array | null>;
    getRunDecisions(runId:string):PolicyDecision[];
    /** N3：完成但受限的 Run 的 DENY 聚合；未装配时为空数组。 */
    getRunLimitations?(runId:string):RunLimitation[];
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
    registerUser?(email: string, password: string): Promise<{ userId: string; tenantId: string }>;
    loginUser?(email: string, password: string): Promise<{ token: string; userId: string; tenantId: string; expiresAt: string } | null>;
    revokeSession?(token: string): boolean;
    revokeAllSessions?(userId: string): number;
    /** D4：会话归属查询，供登出审计归因。 */
    sessionOwner?(token: string): string | null;
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
import type { ResourceMetricsSampler } from "../resources/resource-metrics-sampler.ts";
import { summarizeRunObservation } from "../resources/run-observation.ts";

export class HarnessHttpApi {
    constructor(
        private readonly application:HarnessHttpApplication,
        private readonly checkpointLookup:CheckpointLookup,
        private readonly accessControl?:HttpAccessControl,
        private readonly evaluation?:EvaluationAggregator,
        private readonly llmGateway?:LlmGateway,
        private readonly resourceMetrics?: ResourceMetricsSampler,
        private readonly limits?: { maxUserInputChars: number },
    ) {}

    /** N8：提交期输入校验——超限直接 413，不创建 Run。 */
    private requireUserInput(body: Record<string, unknown>): string {
        const value = requiredString(body, "userInput");
        const max = this.limits?.maxUserInputChars;
        if (max !== undefined && value.length > max) {
            throw new HttpError(
                413,
                `任务输入过长：${value.length} 字符，超过上限 ${max} 字符（可用 HARNESS_MAX_USER_INPUT_CHARS 调整）`,
            );
        }
        return value;
    }

    /**
     * N8：提交响应只回显输入摘要，不再把全量输入回传一遍
     * （客户端渲染走 /runs 查询，不依赖这里的回显）。
     */
    private runForResponse(run: AgentRun): Record<string, unknown> {
        const preview = 200;
        if (run.userInput.length <= preview) return { ...run };
        return {
            ...run,
            userInput: run.userInput.slice(0, preview),
            userInputTruncated: true,
            userInputLength: run.userInput.length,
        };
    }

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

        if (request.method === "POST" && segments.join("/") === "auth/register") {
            if (!this.accessControl?.registerUser) throw new HttpError(503, "账户服务未启用");
            const body = await readJsonObject(request);
            try {
                return jsonResponse({ user: await this.accessControl.registerUser(requiredString(body, "email"), requiredString(body, "password")) }, 201);
            } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
        }
        if (request.method === "POST" && segments.join("/") === "auth/login") {
            if (!this.accessControl?.loginUser) throw new HttpError(503, "账户服务未启用");
            const body = await readJsonObject(request);
            const result = await this.accessControl.loginUser(requiredString(body, "email"), requiredString(body, "password"));
            if (result === null) throw new HttpError(401, "邮箱或密码错误");
            return jsonResponse(result);
        }
        if (request.method === "POST" && segments.join("/") === "auth/logout") {
            const authorization = request.headers.get("authorization");
            const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
            // D7：无效/已撤销的 token 不再静默成功——撤销失败返回 401，
            // 让客户端能区分"已登出"与"本来就无效"。
            if (this.accessControl?.revokeSession === undefined) {
                throw new HttpError(503, "账户服务未启用");
            }
            if (token === "") {
                this.audit("SESSION_REVOKE", "DENY", null, "missing_session_token");
                throw new HttpError(401, "无效或已过期的会话");
            }
            // D4：登出动作的审计归因到会话所有者；resourceId 用 token 摘要而非明文。
            const owner = this.accessControl.sessionOwner?.(token) ?? null;
            if (!this.accessControl.revokeSession(token)) {
                this.auditResource("SESSION", digest(token), "SESSION_REVOKE", "DENY", owner, "invalid_or_revoked_session");
                throw new HttpError(401, "无效或已过期的会话");
            }
            this.auditResource("SESSION", digest(token), "SESSION_REVOKE", "ALLOW", owner, "session_revoked");
            return jsonResponse({ ok: true });
        }
        if (request.method === "DELETE" && segments.join("/") === "auth/sessions") {
            // D7：撤销当前用户的全部活跃会话（"退出所有设备"）。
            const principal = this.requirePrincipal(request, "auth:revoke");
            if (this.accessControl?.revokeAllSessions === undefined) {
                throw new HttpError(503, "账户服务未启用");
            }
            const revoked = this.accessControl.revokeAllSessions(principal.tenantId);
            this.auditResource("SESSION", null, "SESSION_REVOKE_ALL", "ALLOW", principal.tenantId, `revoked_${revoked}_sessions`);
            return jsonResponse({ ok: true, revoked });
        }

        if (request.method === "GET" && segments.length === 0) {
            return platformDashboardResponse();
        }

        // 用户工作台：面向最终用户的对话式任务页面（与运营控制台分离）。
        if (
            request.method === "GET"
            && segments.length === 1
            && segments[0] === "app"
        ) {
            return userConsoleResponse();
        }

        if (request.method === "GET" && segments.length === 1) {
            switch (segments[0]) {
                case "health":
                    return jsonResponse({
                        ok:this.application.isStarted(),
                        started:this.application.isStarted(),
                    });
                case "ready": {
                    const ready = this.application.isStarted();
                    return jsonResponse({ ready }, ready ? 200 : 503);
                }
                case "queue":
                    return this.getQueue(request);
                case "agents": {
                    const principal = this.requirePrincipal(request, "tasks:read");
                    return jsonResponse({
                        agents:this.application.getAgentsForTenant?.(principal.tenantId) ?? [],
                    });
                }
                case "workspaces":
                    return this.listWorkspaces(request);
                case "resources": {
                    const principal = this.requirePrincipal(request, "resources:read");
                    // D3：主机级资源遥测（共享 GPU 池/vLLM 后端）不含跨租户数据，
                    // 但可见性是"有意的主机级"而非"遗漏的租户过滤"——显式标注，
                    // 并保留 principal 供将来引入租户切片视图（如按租户 token 配额）。
                    return jsonResponse({
                        visibility: "HOST_WIDE",
                        requestedByTenant: principal.tenantId,
                        samples: this.resourceMetrics?.getSamples() ?? [],
                        observation:
                            await this.application.observeResources(),
                    });
                }
                case "audit":
                    return this.listAuditEvents(request);
                case "eval": {
                    if (this.evaluation === undefined) {
                        throw new HttpError(503, "评测能力未启用");
                    }
                    // 无认证模式（本地/演示）可用 ?tenant= 过滤；有认证则按租户隔离。
                    if (this.accessControl === undefined) {
                        const evaluation = this.evaluation;
                        const tenantFilter =
                            url.searchParams.get("tenant") ?? undefined;
                        const runs = evaluation.listRunMetrics(tenantFilter);
                        const tenants = evaluation.listTenants();
                        // 每个租户各自的指标，供观测页画租户对比图。
                        const perTenant = tenants.map((t) => ({
                            tenant: t,
                            summary: evaluation.summarize(
                                evaluation.listRunMetrics(t),
                            ),
                        }));
                        return jsonResponse({
                            scope: tenantFilter ?? "all-tenants",
                            tenants,
                            perTenant,
                            executionQuality: evaluation.summarize(runs),
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
            segments.length === 3
            && segments[0] === "workspaces"
            && segments[2] === "conversations"
        ) {
            return request.method === "POST"
                ? this.createConversation(request, segments[1] ?? "")
                : request.method === "GET"
                    ? this.listConversations(request, segments[1] ?? "")
                    : (() => { throw new HttpError(405, "不支持的请求方法"); })();
        }

        if (segments[0] === "conversations" && segments.length >= 2) {
            const conversationId = segments[1] ?? "";
            if (request.method === "GET" && segments.length === 2) {
                return this.getConversation(request, conversationId);
            }
            if (
                request.method === "POST"
                && segments.length === 3
                && segments[2] === "messages"
            ) {
                return this.sendConversationMessage(request, conversationId);
            }
        }

        if (
            request.method === "POST"
            && segments.length === 1
            && segments[0] === "runs"
        ) {
            return this.submitRun(request);
        }

        // 方向 C：LLM 网关——OpenAI 兼容模型路由入口。
        if (
            request.method === "POST"
            && segments.length === 3
            && segments[0] === "v1"
            && segments[1] === "chat"
            && segments[2] === "completions"
        ) {
            if (this.llmGateway === undefined) {
                throw new HttpError(503, "LLM 网关未启用");
            }
            // 方向 C 的便利门也走统一身份主干：任何调用方都必须先证明自己是谁。
            // 无 accessControl（纯单测/演示）时降级为 legacy Principal，与其它路由一致。
            this.requirePrincipal(request, "models:generate");
            return this.llmGateway.handleChatCompletions(request);
        }

        // A6000 真机补齐：Pi 启动时经网关做 GET /v1/models 模型发现。
        if (
            request.method === "GET"
            && segments.length === 2
            && segments[0] === "v1"
            && segments[1] === "models"
        ) {
            if (this.llmGateway === undefined) {
                throw new HttpError(503, "LLM 网关未启用");
            }
            this.requirePrincipal(request, "models:generate");
            return this.llmGateway.handleListModels();
        }

        // 方向 C：LLM 网关路由统计与近期决策（观测用）。
        if (
            request.method === "GET"
            && segments.length === 2
            && segments[0] === "llm-gateway"
            && segments[1] === "stats"
        ) {
            if (this.llmGateway === undefined) {
                throw new HttpError(503, "LLM 网关未启用");
            }
            this.requirePrincipal(request, "models:observe");
            return jsonResponse({
                enabled:true,
                ...this.llmGateway.router.stats(),
                recentDecisions:this.llmGateway.router.recentDecisions(50),
                // 支柱 2：前缀缓存命中指标（cached_tokens 采集）。
                cacheMetrics:this.llmGateway.cacheMetrics(),
            });
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
                    limitations:this.application.getRunLimitations?.(runId) ?? [],
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

            if (request.method === "GET" && segments.length === 3 && segments[2] === "observability") {
                const run = this.getRequiredRun(runId, request, "tasks:read");
                this.requirePrincipal(request, "resources:read");
                return jsonResponse(summarizeRunObservation(run, this.application.getRunEvents(runId), this.resourceMetrics?.getSamples() ?? []));
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
                const principal = this.requirePrincipal(request, "tasks:write");
                const run = this.getRequiredRun(runId);
                if (this.accessControl !== undefined && run.tenantId !== principal.tenantId) {
                    this.auditResource("RUN", runId, "RUN_INTERRUPT", "DENY", principal.tenantId, "run_not_owned");
                    throw new HttpError(404, `找不到 AgentRun：${runId}`);
                }
                this.auditResource("RUN", runId, "RUN_INTERRUPT", "ALLOW", principal.tenantId, "interrupt_requested");

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
        const requestedSessionId =
            optionalString(body, "sessionId")
            ?? optionalString(body, "harnessSessionId");

        // B6：会话归属校验——sessionId 首次使用即认领给提交租户；已被
        // 其他租户使用过则拒绝。防止客户端自选 sessionId 抢注/污染他人会话。
        if (requestedSessionId !== null) {
            const sessionOwner = this.application.resolveSessionOwner?.(requestedSessionId);
            if (sessionOwner !== null && sessionOwner !== undefined) {
                const submitterTenantId = this.accessControl === undefined
                    ? requiredString(body, "tenantId")
                    : principal.tenantId;
                if (sessionOwner !== submitterTenantId) {
                    throw new HttpError(409, "harnessSessionId 已被其他租户占用");
                }
            }
        }

        const run = this.application.submitRun({
            tenantId:this.accessControl === undefined
                ? requiredString(body, "tenantId")
                : principal.tenantId,
            harnessSessionId:
                requestedSessionId
                ?? crypto.randomUUID(),
            userInput:this.requireUserInput(body),
            thinkingLevel: parseThinkingLevel(body),
            workspacePath:this.accessControl === undefined
                ? requiredString(body, "workspacePath")
                : (workspace as NonNullable<typeof workspace>).rootPath,
        });
        this.auditResource("RUN", run.id, "RUN_SUBMIT", "ALLOW", principal.tenantId, "run_submitted");

        return jsonResponse({ run: this.runForResponse(run) }, 202);
    }

    private async createConversation(request: Request, workspaceId: string): Promise<Response> {
        const principal = this.requirePrincipal(request, "tasks:write");
        if (this.accessControl === undefined || this.application.createConversation === undefined) {
            throw new HttpError(501, "对话服务未启用");
        }
        const workspace = this.accessControl.workspaceService.getForTenant(
            workspaceId,
            principal.tenantId,
        );
        if (workspace === null) throw new HttpError(404, "找不到 Workspace");
        const body = await readOptionalJsonObject(request);
        const title = optionalString(body, "title");
        return jsonResponse({
            conversation: this.application.createConversation({
                tenantId: principal.tenantId,
                workspaceId,
                ...(title == null ? {} : { title }),
            }),
        }, 201);
    }

    private listConversations(request: Request, workspaceId: string): Response {
        const principal = this.requirePrincipal(request, "tasks:read");
        if (this.accessControl === undefined) throw new HttpError(501, "Workspace 服务未启用");
        const workspace = this.accessControl.workspaceService.getForTenant(workspaceId, principal.tenantId);
        if (workspace === null) throw new HttpError(404, "找不到 Workspace");
        return jsonResponse({
            conversations: this.application.getConversationsForWorkspace?.(
                principal.tenantId,
                workspaceId,
            ) ?? [],
        });
    }

    private getConversation(request: Request, conversationId: string): Response {
        const principal = this.requirePrincipal(request, "tasks:read");
        const conversation = this.application.getConversation?.(
            conversationId,
            principal.tenantId,
        ) ?? null;
        if (conversation === null) throw new HttpError(404, "找不到对话");
        return jsonResponse({
            conversation,
            runs: this.application.getRunsForConversation?.(
                principal.tenantId,
                conversationId,
            ) ?? [],
        });
    }

    private async sendConversationMessage(request: Request, conversationId: string): Promise<Response> {
        const principal = this.requirePrincipal(request, "tasks:write");
        const conversation = this.application.getConversation?.(
            conversationId,
            principal.tenantId,
        ) ?? null;
        if (conversation === null) throw new HttpError(404, "找不到对话");
        if (this.accessControl === undefined) throw new HttpError(501, "Workspace 服务未启用");
        const workspace = this.accessControl.workspaceService.getForTenant(
            conversation.workspaceId,
            principal.tenantId,
        );
        if (workspace === null) throw new HttpError(404, "找不到 Workspace");
        const body = await readJsonObject(request);
        const run = this.application.submitRun({
            tenantId: principal.tenantId,
            harnessSessionId: conversation.id,
            userInput: this.requireUserInput(body),
            thinkingLevel: parseThinkingLevel(body),
            workspacePath: workspace.rootPath,
        });
        this.application.touchConversation?.(conversation.id, principal.tenantId);
        return jsonResponse({ run: this.runForResponse(run) }, 202);
    }

    private async resumeRun(
        request:Request,
        runId:string,
    ):Promise<Response> {
        const principal = this.requirePrincipal(request, "tasks:write");
        const run = this.getRequiredRun(runId);
        if (this.accessControl !== undefined && run.tenantId !== principal.tenantId) {
            this.auditResource("RUN", runId, "RUN_RESUME", "DENY", principal.tenantId, "run_not_owned");
            throw new HttpError(404, `找不到 AgentRun：${runId}`);
        }

        if (run.checkpointId === null) {
            this.auditResource("RUN", runId, "RUN_RESUME", "DENY", principal.tenantId, "no_checkpoint");
            throw new HttpError(409, `Run 没有可用 Checkpoint：${runId}`);
        }

        const checkpoint = this.checkpointLookup.get(run.checkpointId);

        if (checkpoint === null || checkpoint.runId !== runId) {
            this.auditResource("RUN", runId, "RUN_RESUME", "DENY", principal.tenantId, "checkpoint_mismatch");
            throw new HttpError(
                409,
                `Run 的 Checkpoint 不存在或不匹配：${runId}`,
            );
        }

        const body = await readOptionalJsonObject(request);
        const queuedRun = this.application.resumeRun({
            runId,
            checkpoint,
            // B3：手动恢复未提供续跑输入时，也携带原始任务语境。
            continuationInput:
                optionalString(body, "continuationInput")
                ?? buildRecoveryContinuationInput(run.userInput, checkpoint.id),
        });
        this.auditResource("RUN", runId, "RUN_RESUME", "ALLOW", principal.tenantId, "run_resumed");

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
        const url = new URL(request.url);
        const limitParam = Number(url.searchParams.get("limit") ?? undefined);
        const offsetParam = Number(url.searchParams.get("offset") ?? undefined);
        return jsonResponse({
            events: this.accessControl.auditStore.listForTenant(principal.tenantId, {
                ...(Number.isFinite(limitParam) ? { limit: limitParam } : {}),
                ...(Number.isFinite(offsetParam) ? { offset: offsetParam } : {}),
            }),
        });
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

function parseThinkingLevel(body:Record<string,unknown>): StartRunInput["thinkingLevel"] {
    const value = optionalString(body, "thinkingLevel");
    if (value === null) return undefined;
    if (!["off", "minimal", "low", "medium", "high"].includes(value)) {
        throw new HttpError(400, "thinkingLevel 必须是 off、minimal、low、medium 或 high");
    }
    return value as StartRunInput["thinkingLevel"];
}

function jsonResponse(value:unknown, status = 200):Response {
    return new Response(JSON.stringify(value), {
        status,
        headers:{
            "content-type":"application/json; charset=utf-8",
        },
    });
}
