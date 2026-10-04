import { buildRecoveryContinuationInput } from "../../runs/run-service.ts";
import {
    HttpError,
    jsonResponse,
    optionalString,
    parseRunPolicy,
    parseThinkingLevel,
    readJsonObject,
    readOptionalJsonObject,
    requiredString,
    requireUserInput,
    runForResponse,
} from "../http-utils.ts";
import type { HttpRouteContext } from "./route-context.ts";
import { requireOwnedRun } from "./route-helpers.ts";

export async function handleRunsRoute(
    request: Request,
    segments: readonly string[],
    ctx: HttpRouteContext,
): Promise<Response | null> {
    if (segments.length === 1 && segments[0] === "runs") {
        if (request.method === "POST") return submitRun(request, ctx);
        if (request.method === "GET") {
            const principal = ctx.requirePrincipal(request, "tasks:read");
            return jsonResponse({
                runs: ctx.accessControl === undefined
                    ? []
                    : ctx.application.getRunsForTenant(principal.tenantId),
            });
        }
        return null;
    }

    if (segments[0] !== "runs" || segments.length < 2) {
        return null;
    }

    const runId = segments[1];
    if (runId === undefined || runId.length === 0) {
        throw new HttpError(400, "runId 不能为空");
    }

    if (request.method === "GET" && segments.length === 2) {
        return getRunDetail(request, runId, ctx);
    }

    if (request.method === "GET" && segments.length === 3 && segments[2] === "events") {
        ctx.getRequiredRun(runId, request, "tasks:read");
        return jsonResponse({ events: ctx.application.getRunEvents(runId) });
    }

    if (request.method === "GET" && segments.length === 3 && segments[2] === "output") {
        ctx.getRequiredRun(runId, request, "tasks:read");
        return jsonResponse(ctx.application.getRunOutput(runId));
    }

    if (request.method === "GET" && segments.length === 3 && segments[2] === "workspace-diff") {
        ctx.getRequiredRun(runId, request, "tasks:read");
        return jsonResponse({ diff: ctx.application.getRunWorkspaceDiff(runId) });
    }

    if (request.method === "GET" && segments.length === 3 && segments[2] === "artifacts") {
        ctx.getRequiredRun(runId, request, "tasks:read");
        return jsonResponse({ artifacts: ctx.application.getRunArtifacts(runId) });
    }

    if (request.method === "GET" && segments.length === 4 && segments[2] === "artifacts") {
        ctx.getRequiredRun(runId, request, "tasks:read");
        const body = await ctx.application.getRunArtifact(runId, segments[3] ?? "");
        if (body === null) throw new HttpError(404, "找不到 Artifact");
        return new Response(body, {
            headers: {
                "content-type": "application/octet-stream",
                "content-disposition": "attachment",
            },
        });
    }

    if (request.method === "POST" && segments.length === 3 && segments[2] === "interrupt") {
        return interruptRun(request, runId, ctx);
    }
    if (request.method === "POST" && segments.length === 3 && segments[2] === "resume") {
        return resumeRun(request, runId, ctx);
    }
    if (request.method === "POST" && segments.length === 3 && segments[2] === "resolve-unknown-effect") {
        return resolveUnknownEffect(request, runId, ctx);
    }

    return null;
}

async function submitRun(request: Request, ctx: HttpRouteContext): Promise<Response> {
    const body = await readJsonObject(request);
    const principal = ctx.requirePrincipal(request, "tasks:write");
    const workspace = ctx.accessControl === undefined
        ? null
        : ctx.accessControl.workspaceService.getForTenant(
            requiredString(body, "workspaceId"),
            principal.tenantId,
        );
    if (ctx.accessControl !== undefined && workspace === null) {
        // Deliberately indistinguishable from an absent resource (anti-enumeration).
        throw new HttpError(404, "找不到 Workspace");
    }
    const requestedSessionId =
        optionalString(body, "sessionId")
        ?? optionalString(body, "harnessSessionId");

    // B6：会话归属校验——sessionId 首次使用即认领给提交租户；已被
    // 其他租户使用过则拒绝。防止客户端自选 sessionId 抢注/污染他人会话。
    if (requestedSessionId !== null) {
        const sessionOwner = ctx.application.resolveSessionOwner?.(requestedSessionId);
        if (sessionOwner !== null && sessionOwner !== undefined) {
            const submitterTenantId = ctx.accessControl === undefined
                ? requiredString(body, "tenantId")
                : principal.tenantId;
            if (sessionOwner !== submitterTenantId) {
                throw new HttpError(409, "harnessSessionId 已被其他租户占用");
            }
        }
    }

    // N15：请求级策略层（RUN 层）。此前 StartRunInput.runPolicy
    // 没有任何产品调用方，受限运行只能靠测试直接调 Runtime。
    const runPolicy = parseRunPolicy(body);
    const run = ctx.application.submitRun({
        tenantId: ctx.accessControl === undefined
            ? requiredString(body, "tenantId")
            : principal.tenantId,
        harnessSessionId: requestedSessionId ?? crypto.randomUUID(),
        userInput: requireUserInput(body, ctx.limits?.maxUserInputChars),
        thinkingLevel: parseThinkingLevel(body),
        ...(runPolicy === undefined ? {} : { runPolicy }),
        workspacePath: ctx.accessControl === undefined
            ? requiredString(body, "workspacePath")
            : (workspace as NonNullable<typeof workspace>).rootPath,
    });
    ctx.auditResource("RUN", run.id, "RUN_SUBMIT", "ALLOW", principal.tenantId, "run_submitted");
    return jsonResponse({ run: runForResponse(run) }, 202);
}

function getRunDetail(request: Request, runId: string, ctx: HttpRouteContext): Response {
    const run = ctx.getRequiredRun(runId, request, "tasks:read");

    // N16：把"结果不确定的副作用"显式暴露给界面，否则用户只看到
    // 一个 INTERRUPTED 的 Run，不知道需要人工核对什么。
    const unknownEffects = (
        ctx.application.getRunUnknownEffects?.(runId) ?? []
    ).map((execution) => ({
        executionId: execution.id,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        effect: execution.effect,
        createdAt: execution.createdAt,
    }));

    return jsonResponse({
        run,
        decisions: ctx.application.getRunDecisions(runId),
        limitations: ctx.application.getRunLimitations?.(runId) ?? [],
        unknownEffects,
    });
}

async function interruptRun(
    request: Request,
    runId: string,
    ctx: HttpRouteContext,
): Promise<Response> {
    const { principal } = requireOwnedRun(request, runId, ctx, "RUN_INTERRUPT");
    ctx.auditResource("RUN", runId, "RUN_INTERRUPT", "ALLOW", principal.tenantId, "interrupt_requested");
    return jsonResponse({ run: await ctx.application.interruptRun(runId) });
}

async function resumeRun(
    request: Request,
    runId: string,
    ctx: HttpRouteContext,
): Promise<Response> {
    const { principal, run } = requireOwnedRun(request, runId, ctx, "RUN_RESUME");

    if (run.checkpointId === null) {
        ctx.auditResource("RUN", runId, "RUN_RESUME", "DENY", principal.tenantId, "no_checkpoint");
        throw new HttpError(409, `Run 没有可用 Checkpoint：${runId}`);
    }

    const checkpoint = ctx.checkpointLookup.get(run.checkpointId);
    if (checkpoint === null || checkpoint.runId !== runId) {
        ctx.auditResource("RUN", runId, "RUN_RESUME", "DENY", principal.tenantId, "checkpoint_mismatch");
        throw new HttpError(409, `Run 的 Checkpoint 不存在或不匹配：${runId}`);
    }

    const body = await readOptionalJsonObject(request);
    const queuedRun = ctx.application.resumeRun({
        runId,
        checkpoint,
        // B3：手动恢复未提供续跑输入时，也携带原始任务语境。
        continuationInput: optionalString(body, "continuationInput")
            ?? buildRecoveryContinuationInput(run.userInput, checkpoint.id),
    });
    ctx.auditResource("RUN", runId, "RUN_RESUME", "ALLOW", principal.tenantId, "run_resumed");
    return jsonResponse({ run: queuedRun }, 202);
}

/**
 * N16：人工核对 UNKNOWN_EFFECT 后的消解出口。
 *
 * 背景：工具在 PREPARED 之后崩溃/超时，"副作用是否已发生"无法由系统
 * 判定（canAutomaticallyReplay 对 UNKNOWN_EFFECT 一律 fail-closed），
 * Run 停在 INTERRUPTED。此前没有任何产品流程能消解它。
 */
async function resolveUnknownEffect(
    request: Request,
    runId: string,
    ctx: HttpRouteContext,
): Promise<Response> {
    const { principal } = requireOwnedRun(request, runId, ctx, "RUN_RESOLVE_UNKNOWN_EFFECT");

    if (ctx.application.resolveUnknownEffect === undefined) {
        throw new HttpError(503, "人工消解服务未装配");
    }

    const body = await readJsonObject(request);
    const resolution = requiredString(body, "resolution");
    if (resolution !== "NO_EFFECT" && resolution !== "EFFECT_OCCURRED") {
        throw new HttpError(
            400,
            "resolution 必须是 NO_EFFECT（确认无副作用）或 EFFECT_OCCURRED（确认副作用已发生）",
        );
    }

    try {
        const result = ctx.application.resolveUnknownEffect(runId, {
            resolution,
            note: optionalString(body, "note") ?? undefined,
            actor: principal.tenantId,
        });
        ctx.auditResource(
            "RUN", runId, "RUN_RESOLVE_UNKNOWN_EFFECT", "ALLOW",
            principal.tenantId, `resolution=${resolution}`,
        );
        return jsonResponse(result);
    } catch (error) {
        ctx.auditResource(
            "RUN", runId, "RUN_RESOLVE_UNKNOWN_EFFECT", "DENY",
            principal.tenantId, "resolution_rejected",
        );
        throw new HttpError(
            409,
            error instanceof Error ? error.message : String(error),
        );
    }
}
