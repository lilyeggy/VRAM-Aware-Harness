import {
    autoWorkspaceName,
    HttpError,
    jsonResponse,
    optionalString,
    readJsonObject,
    readOptionalJsonObject,
    parseThinkingLevel,
    requireUserInput,
    runForResponse,
} from "../http-utils.ts";
import type { HttpRouteContext } from "./route-context.ts";
import { requireOwnedWorkspace } from "./route-helpers.ts";

export async function handleConversationsRoute(
    request: Request,
    segments: readonly string[],
    ctx: HttpRouteContext,
): Promise<Response | null> {
    if (request.method === "POST" && segments.length === 1 && segments[0] === "conversations") {
        return createConversationWithAutoWorkspace(request, ctx);
    }

    if (segments.length === 3 && segments[0] === "workspaces" && segments[2] === "conversations") {
        if (request.method === "POST") {
            return createConversation(request, segments[1] ?? "", ctx);
        }
        if (request.method === "GET") {
            return listConversations(request, segments[1] ?? "", ctx);
        }
        throw new HttpError(405, "不支持的请求方法");
    }

    if (segments[0] === "conversations" && segments.length >= 2) {
        const conversationId = segments[1] ?? "";
        if (request.method === "GET" && segments.length === 2) {
            return getConversation(request, conversationId, ctx);
        }
        if (request.method === "POST" && segments.length === 3 && segments[2] === "messages") {
            return sendConversationMessage(request, conversationId, ctx);
        }
    }

    return null;
}

/**
 * 自动建工作区并开一个会话 —— 会话成为用户唯一需要管理的单位。
 *
 * 为什么把两步合成一步：一个会话的所有 Run 共用同一个工作区，免去调用方
 * 手工建工作区再传 id 的样板；「会话 = 一个工作区」也让同一会话内的文件
 * 自然连续。让调用方先手工建工作区、再把 id 传进来，只会把内部概念泄露给使用者。
 *
 * 显式传 workspaceId 仍然支持（走归属校验），留给需要固定目录的场景。
 */
async function createConversationWithAutoWorkspace(
    request: Request,
    ctx: HttpRouteContext,
): Promise<Response> {
    const principal = ctx.requirePrincipal(request, "tasks:write");
    if (ctx.accessControl === undefined) {
        throw new HttpError(501, "对话服务未启用");
    }
    const body = await readOptionalJsonObject(request);
    const title = optionalString(body, "title");
    const requestedWorkspaceId = optionalString(body, "workspaceId");

    let workspaceId: string;
    if (requestedWorkspaceId !== null) {
        requireOwnedWorkspace(ctx, requestedWorkspaceId, principal.userId);
        workspaceId = requestedWorkspaceId;
    } else {
        // 自动建出来的工作区同样是资源创建，权限不因为"包装成建会话"而豁免。
        ctx.requirePrincipal(request, "workspaces:write");
        workspaceId = ctx.accessControl.workspaceService.create(
            principal.userId,
            autoWorkspaceName(),
        ).id;
    }

    return createConversationResponse(ctx, principal.userId, workspaceId, title);
}

async function createConversation(
    request: Request,
    workspaceId: string,
    ctx: HttpRouteContext,
): Promise<Response> {
    const principal = ctx.requirePrincipal(request, "tasks:write");
    requireOwnedWorkspace(ctx, workspaceId, principal.userId);
    const body = await readOptionalJsonObject(request);
    return createConversationResponse(
        ctx,
        principal.userId,
        workspaceId,
        optionalString(body, "title"),
    );
}

/** 两条建会话入口（自动建工作区 / 指定工作区）共用的创建与响应。 */
function createConversationResponse(
    ctx: HttpRouteContext,
    userId: string,
    workspaceId: string,
    title: string | null,
): Response {
    if (ctx.application.createConversation === undefined) {
        throw new HttpError(501, "对话服务未启用");
    }
    return jsonResponse({
        conversation: ctx.application.createConversation({
            userId,
            workspaceId,
            ...(title == null ? {} : { title }),
        }),
    }, 201);
}

function listConversations(
    request: Request,
    workspaceId: string,
    ctx: HttpRouteContext,
): Response {
    const principal = ctx.requirePrincipal(request, "tasks:read");
    requireOwnedWorkspace(ctx, workspaceId, principal.userId);
    return jsonResponse({
        conversations: ctx.application.getConversationsForWorkspace?.(
            principal.userId,
            workspaceId,
        ) ?? [],
    });
}

function getConversation(
    request: Request,
    conversationId: string,
    ctx: HttpRouteContext,
): Response {
    const principal = ctx.requirePrincipal(request, "tasks:read");
    const conversation = ctx.application.getConversation?.(
        conversationId,
        principal.userId,
    ) ?? null;
    if (conversation === null) throw new HttpError(404, "找不到对话");
    return jsonResponse({
        conversation,
        runs: ctx.application.getRunsForConversation?.(
            principal.userId,
            conversationId,
        ) ?? [],
    });
}

async function sendConversationMessage(
    request: Request,
    conversationId: string,
    ctx: HttpRouteContext,
): Promise<Response> {
    const principal = ctx.requirePrincipal(request, "tasks:write");
    const conversation = ctx.application.getConversation?.(
        conversationId,
        principal.userId,
    ) ?? null;
    if (conversation === null) throw new HttpError(404, "找不到对话");
    const workspace = requireOwnedWorkspace(
        ctx,
        conversation.workspaceId,
        principal.userId,
    );
    const body = await readJsonObject(request);
    const idempotencyKey = optionalString(body, "idempotencyKey");
    if (idempotencyKey !== null && idempotencyKey.length > 200) {
        throw new HttpError(400, "idempotencyKey 长度不能超过 200");
    }
    const run = ctx.application.submitRun({
        userId: principal.userId,
        harnessSessionId: conversation.id,
        userInput: requireUserInput(body, ctx.limits?.maxUserInputChars),
        thinkingLevel: parseThinkingLevel(body),
        ...(idempotencyKey === null ? {} : { idempotencyKey }),
        workspacePath: workspace.rootPath,
    });
    ctx.application.touchConversation?.(conversation.id, principal.userId);
    return jsonResponse({ run: runForResponse(run) }, 202);
}
