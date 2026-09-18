import { HttpError } from "../http-utils.ts";
import type { HttpRouteContext } from "./route-context.ts";

export async function handleGatewayRoute(
    request: Request,
    segments: readonly string[],
    ctx: HttpRouteContext,
): Promise<Response | null> {
    // 方向 C：LLM 网关——OpenAI 兼容模型路由入口。
    if (
        request.method === "POST"
        && segments.length === 3
        && segments[0] === "v1"
        && segments[1] === "chat"
        && segments[2] === "completions"
    ) {
        if (ctx.llmGateway === undefined) {
            throw new HttpError(503, "LLM 网关未启用");
        }
        // 方向 C 的便利门也走统一身份主干：任何调用方都必须先证明自己是谁。
        // 无 accessControl（纯单测/演示）时降级为 legacy Principal，与其它路由一致。
        ctx.requirePrincipal(request, "models:generate");
        return ctx.llmGateway.handleChatCompletions(request);
    }

    // A6000 真机补齐：Pi 启动时经网关做 GET /v1/models 模型发现。
    if (
        request.method === "GET"
        && segments.length === 2
        && segments[0] === "v1"
        && segments[1] === "models"
    ) {
        if (ctx.llmGateway === undefined) {
            throw new HttpError(503, "LLM 网关未启用");
        }
        ctx.requirePrincipal(request, "models:generate");
        return ctx.llmGateway.handleListModels();
    }

    return null;
}
