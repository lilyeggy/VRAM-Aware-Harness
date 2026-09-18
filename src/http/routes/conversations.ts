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
 * 为什么把两步合成一步：一个会话的所有 Run 共用同一个工作区，而预热池的
 * 匹配键里含挂载源（bind mount 在容器创建时固化），所以「会话 = 一个工作区」
 * 正是池能在连续对话里反复命中的前提。让调用方先手工建工作区、再把 id 传进来，
 * 只会把内部概念泄露给使用者，也让"同一会话内复用"退化成一个需要人配合的约定。
 *
 * 显式传 workspaceId 仍然支持（走归属校验），留给需要固定目录的场景。
 */
async function createConversationWithAutoWorkspace(
    request: Request,
    ctx: HttpRouteContext,
): Promise<Response> {
    const principal = ctx.requirePrincipal(request, "tasks:write");
    const createConversation = ctx.application.createConversation;
    if (ctx.accessControl === undefined || createConversation === undefined) {
        throw new HttpError(501, "对话服务未启用");
    }
    const body = await readOptionalJsonObject(request);
    const title = optionalString(body, "title");
    const requestedWorkspaceId = optionalString(body, "workspaceId");

    let workspaceId: string;
    if (requestedWorkspaceId !== null) {
        const workspace = ctx.accessControl.workspaceService.getForTenant(
            requestedWorkspaceId,
            principal.tenantId,
        );
        if (workspace === null) throw new HttpError(404, "找不到 Workspace");
        workspaceId = requestedWorkspaceId;
    } else {
        // 自动建出来的工作区同样是资源创建，权限不因为"包装成建会话"而豁免。
        ctx.requirePrincipal(request, "workspaces:write");
        workspaceId = ctx.accessControl.workspaceService.create(
            principal.tenantId,
            autoWorkspaceName(),
        ).id;
    }

    return jsonResponse({
        conversation: createConversation({
            tenantId: principal.tenantId,
            workspaceId,
            ...(title == null ? {} : { title }),
        }),
    }, 201);
}

async function createConversation(
    request: Request,
    workspaceId: string,
    ctx: HttpRouteContext,
): Promise<Response> {
    const principal = ctx.requirePrincipal(request, "tasks:write");
    const createConversation = ctx.application.createConversation;
    if (ctx.accessControl === undefined || createConversation === undefined) {
        throw new HttpError(501, "对话服务未启用");
    }
    const workspace = ctx.accessControl.workspaceService.getForTenant(
        workspaceId,
        principal.tenantId,
    );
    if (workspace === null) throw new HttpError(404, "找不到 Workspace");
    const body = await readOptionalJsonObject(request);
    const title = optionalString(body, "title");
    return jsonResponse({
        conversation: createConversation({
            tenantId: principal.tenantId,
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
    if (ctx.accessControl === undefined) throw new HttpError(501, "Workspace 服务未启用");
    const workspace = ctx.accessControl.workspaceService.getForTenant(workspaceId, principal.tenantId);
    if (workspace === null) throw new HttpError(404, "找不到 Workspace");
    return jsonResponse({
        conversations: ctx.application.getConversationsForWorkspace?.(
            principal.tenantId,
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
        principal.tenantId,
    ) ?? null;
    if (conversation === null) throw new HttpError(404, "找不到对话");
    return jsonResponse({
        conversation,
        runs: ctx.application.getRunsForConversation?.(
            principal.tenantId,
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
        principal.tenantId,
    ) ?? null;
    if (conversation === null) throw new HttpError(404, "找不到对话");
    if (ctx.accessControl === undefined) throw new HttpError(501, "Workspace 服务未启用");
    const workspace = ctx.accessControl.workspaceService.getForTenant(
        conversation.workspaceId,
        principal.tenantId,
    );
    if (workspace === null) throw new HttpError(404, "找不到 Workspace");
    const body = await readJsonObject(request);
    const run = ctx.application.submitRun({
        tenantId: principal.tenantId,
        harnessSessionId: conversation.id,
        userInput: requireUserInput(body, ctx.limits?.maxUserInputChars),
        thinkingLevel: parseThinkingLevel(body),
        workspacePath: workspace.rootPath,
    });
    ctx.application.touchConversation?.(conversation.id, principal.tenantId);
    return jsonResponse({ run: runForResponse(run) }, 202);
}
