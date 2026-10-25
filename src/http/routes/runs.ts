import { buildRecoveryContinuationInput } from "../../runs/run-service.ts";
import { QueueBackpressureError } from "../../scheduling/run-scheduler.ts";
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
                    : ctx.application.getRunsForUser(principal.userId),
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

    // 分步时间线：每步耗时 + token/成本归因（只读聚合）。
    if (request.method === "GET" && segments.length === 3 && segments[2] === "trace") {
        ctx.getRequiredRun(runId, request, "tasks:read");
        const trace = ctx.application.getRunTrace(runId);

        if (trace === null) {
            throw new HttpError(404, "Run 不存在");
        }

        return jsonResponse(trace);
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
        : ctx.accessControl.workspaceService.getForUser(
            requiredString(body, "workspaceId"),
            principal.userId,
        );
    if (ctx.accessControl !== undefined && workspace === null) {
        // Deliberately indistinguishable from an absent resource (anti-enumeration).
        throw new HttpError(404, "找不到 Workspace");
    }
    const requestedSessionId =
        optionalString(body, "sessionId")
        ?? optionalString(body, "harnessSessionId");

    // B6：会话归属校验——sessionId 首次使用即认领给提交用户；已被
    // 其他用户使用过则拒绝。防止客户端自选 sessionId 抢注/污染他人会话。
    if (requestedSessionId !== null) {
        const sessionOwner = ctx.application.resolveSessionOwner?.(requestedSessionId);
        if (sessionOwner !== null && sessionOwner !== undefined) {
            const submitterUserId = ctx.accessControl === undefined
                ? requiredString(body, "userId")
                : principal.userId;
            if (sessionOwner !== submitterUserId) {
                throw new HttpError(409, "harnessSessionId 已被其他用户占用");
            }
        }
    }

    // N15：请求级策略层（RUN 层）。此前 StartRunInput.runPolicy
    // 没有任何产品调用方，受限运行只能靠测试直接调 Runtime。
    const runPolicy = parseRunPolicy(body);
    // §9.8 v1.4 Phase 3：可选幂等键；同用户重复提交返回既有 Run。
    const idempotencyKey = optionalString(body, "idempotencyKey");
    if (idempotencyKey !== null && idempotencyKey.length > 200) {
        throw new HttpError(400, "idempotencyKey 长度不能超过 200");
    }
    let run;
    try {
        run = ctx.application.submitRun({
            userId: ctx.accessControl === undefined
                ? requiredString(body, "userId")
                : principal.userId,
            harnessSessionId: requestedSessionId ?? crypto.randomUUID(),
            userInput: requireUserInput(body, ctx.limits?.maxUserInputChars),
            thinkingLevel: parseThinkingLevel(body),
            ...(idempotencyKey === null ? {} : { idempotencyKey }),
            ...(runPolicy === undefined ? {} : { runPolicy }),
            workspacePath: ctx.accessControl === undefined
                ? requiredString(body, "workspacePath")
                : (workspace as NonNullable<typeof workspace>).rootPath,
        });
    } catch (error) {
        if (error instanceof QueueBackpressureError) {
            throw new HttpError(429, error.message, {
                "retry-after": String(error.retryAfterSeconds),
                "x-queue-limit": String(error.limit),
                "x-queue-current": String(error.current),
            });
        }
        throw error;
    }
    ctx.auditResource("RUN", run.id, "RUN_SUBMIT", "ALLOW", principal.userId, "run_submitted");
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
        limitations: ctx.application.getRunLimitations?.(runId) ?? [],
        unknownEffects,
    });
}

async function interruptRun(
    request: Request,
    runId: string,
    ctx: HttpRouteContext,
): Promise<Response> {
    const { principal, run } = requireOwnedRun(request, runId, ctx, "RUN_INTERRUPT");

    // 终态 Run 的中断是客户端可预期的冲突，不是服务端错误：显式 409，
    // 否则会穿透到 HTTP 兜底变成 500「内部错误」（真机全流程实测）。
    if (run.status === "COMPLETED" || run.status === "FAILED") {
        ctx.auditResource("RUN", runId, "RUN_INTERRUPT", "DENY", principal.userId, "terminal_run");
        throw new HttpError(409, `终态 Run 不能中断：${runId}`);
    }

    ctx.auditResource("RUN", runId, "RUN_INTERRUPT", "ALLOW", principal.userId, "interrupt_requested");
    return jsonResponse({ run: await ctx.application.interruptRun(runId) });
}

async function resumeRun(
    request: Request,
    runId: string,
    ctx: HttpRouteContext,
): Promise<Response> {
    const { principal, run } = requireOwnedRun(request, runId, ctx, "RUN_RESUME");

    // 只有 INTERRUPTED 的 Run 可以恢复；其它状态（尤其终态）显式 409，
    // 避免状态机异常穿透成 500「内部错误」（真机全流程实测）。
    if (run.status !== "INTERRUPTED") {
        ctx.auditResource("RUN", runId, "RUN_RESUME", "DENY", principal.userId, `not_interrupted:${run.status}`);
        throw new HttpError(409, `只有 INTERRUPTED 的 Run 可以恢复，当前状态：${run.status}`);
    }

    if (run.checkpointId === null) {
        ctx.auditResource("RUN", runId, "RUN_RESUME", "DENY", principal.userId, "no_checkpoint");
        throw new HttpError(409, `Run 没有可用 Checkpoint：${runId}`);
    }

    const checkpoint = ctx.checkpointLookup.get(run.checkpointId);
    if (checkpoint === null || checkpoint.runId !== runId) {
        ctx.auditResource("RUN", runId, "RUN_RESUME", "DENY", principal.userId, "checkpoint_mismatch");
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
    ctx.auditResource("RUN", runId, "RUN_RESUME", "ALLOW", principal.userId, "run_resumed");
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
            actor: principal.userId,
        });
        ctx.auditResource(
            "RUN", runId, "RUN_RESOLVE_UNKNOWN_EFFECT", "ALLOW",
            principal.userId, `resolution=${resolution}`,
        );
        return jsonResponse(result);
    } catch (error) {
        ctx.auditResource(
            "RUN", runId, "RUN_RESOLVE_UNKNOWN_EFFECT", "DENY",
            principal.userId, "resolution_rejected",
        );
        throw new HttpError(
            409,
            error instanceof Error ? error.message : String(error),
        );
    }
}
