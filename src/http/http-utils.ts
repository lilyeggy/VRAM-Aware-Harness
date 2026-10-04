import type {
    PolicyConstraints,
    ResourceLimits,
} from "../policies/effective-policy.ts";
import type { StartRunInput } from "../runs/run-service.ts";
import type { AgentRun } from "../runs/agent-run.ts";

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/**
 * 解析 `Authorization: Bearer <token>`。鉴权（requirePrincipal）与
 * 登出（auth/logout）共用同一份解析，避免两处各自 slice。
 */
export function bearerToken(request: Request): string | undefined {
    const authorization = request.headers.get("authorization");
    return authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : undefined;
}

export async function readJsonObject(
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

export async function readOptionalJsonObject(
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

export function requiredString(
    body:Record<string,unknown>,
    field:string,
):string {
    const value = optionalString(body, field);

    if (value === null) {
        throw new HttpError(400, `${field} 必须是非空字符串`);
    }

    return value;
}

/**
 * 自动工作区名。
 *
 * WorkspaceService 只接受 [a-zA-Z0-9_-] 且最长 64 位，所以不能直接用会话标题
 * （可能含中文）——否则建会话会被命名校验拒掉。改用时间戳加随机后缀。
 */
export function autoWorkspaceName(): string {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    return `conv-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

export function optionalString(
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

export function parseThinkingLevel(body:Record<string,unknown>): StartRunInput["thinkingLevel"] {
    const value = optionalString(body, "thinkingLevel");
    if (value === null) return undefined;
    if (!["off", "minimal", "low", "medium", "high"].includes(value)) {
        throw new HttpError(400, "thinkingLevel 必须是 off、minimal、low、medium 或 high");
    }
    return value as StartRunInput["thinkingLevel"];
}

/**
 * N15：解析 PolicyConstraints。策略管理面（PUT /admin/policies/*）与请求级
 * `runPolicy` 共用同一套校验：未提供的字段按 unrestricted 语义取默认值，
 * 类型错误一律 400（不静默降级成"无限额"）。
 */
export function parsePolicyConstraints(value:unknown, field:string):PolicyConstraints {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(400, `${field} 必须是 JSON 对象`);
    }

    const raw = value as Record<string, unknown>;

    return {
        allowedTools: optionalStringArray(raw.allowedTools, `${field}.allowedTools`),
        allowedSkills: optionalStringArray(raw.allowedSkills, `${field}.allowedSkills`),
        allowedModels: optionalStringArray(raw.allowedModels, `${field}.allowedModels`),
        workspaceRoots: optionalStringArray(raw.workspaceRoots, `${field}.workspaceRoots`),
        allowNetwork: optionalBoolean(raw.allowNetwork, `${field}.allowNetwork`, true),
        allowProcess: optionalBoolean(raw.allowProcess, `${field}.allowProcess`, true),
        allowedSecrets: optionalStringArray(raw.allowedSecrets, `${field}.allowedSecrets`),
        resourceLimits: parseResourceLimits(raw.resourceLimits, `${field}.resourceLimits`),
    };
}

export function parseRunPolicy(body:Record<string,unknown>):PolicyConstraints | undefined {
    if (body.runPolicy === undefined) {
        return undefined;
    }
    return parsePolicyConstraints(body.runPolicy, "runPolicy");
}

export function optionalStringArray(value:unknown, field:string):string[] | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (
        !Array.isArray(value)
        || value.some((item) => typeof item !== "string" || item.length === 0)
    ) {
        throw new HttpError(400, `${field} 必须是非空字符串数组`);
    }
    return value as string[];
}

export function optionalBoolean(value:unknown, field:string, fallback:boolean):boolean {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value !== "boolean") {
        throw new HttpError(400, `${field} 必须是布尔值`);
    }
    return value;
}

export function parseResourceLimits(value:unknown, field:string):ResourceLimits {
    if (value === undefined || value === null) {
        return { cpuCores: null, memoryMiB: null, diskMiB: null };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(400, `${field} 必须是 JSON 对象`);
    }

    const raw = value as Record<string, unknown>;

    return {
        cpuCores: optionalPositiveNumber(raw.cpuCores, `${field}.cpuCores`),
        memoryMiB: optionalPositiveInteger(raw.memoryMiB, `${field}.memoryMiB`),
        diskMiB: optionalPositiveInteger(raw.diskMiB, `${field}.diskMiB`),
    };
}

export function optionalPositiveNumber(value:unknown, field:string):number | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new HttpError(400, `${field} 必须是正数`);
    }
    return value;
}

export function optionalPositiveInteger(value:unknown, field:string):number | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new HttpError(400, `${field} 必须是正整数`);
    }
    return value;
}

/**
 * N8：提交期输入校验——超限直接 413，不创建 Run。
 */
export function requireUserInput(
    body: Record<string, unknown>,
    maxUserInputChars?: number,
): string {
    const value = requiredString(body, "userInput");
    if (maxUserInputChars !== undefined && value.length > maxUserInputChars) {
        throw new HttpError(
            413,
            `任务输入过长：${value.length} 字符，超过上限 ${maxUserInputChars} 字符（可用 HARNESS_MAX_USER_INPUT_CHARS 调整）`,
        );
    }
    return value;
}

/**
 * N8：提交响应只回显输入摘要，不再把全量输入回传一遍
 * （客户端渲染走 /runs 查询，不依赖这里的回显）。
 */
export function runForResponse(run: AgentRun): Record<string, unknown> {
    const preview = 200;
    if (run.userInput.length <= preview) return { ...run };
    return {
        ...run,
        userInput: run.userInput.slice(0, preview),
        userInputTruncated: true,
        userInputLength: run.userInput.length,
    };
}

export function jsonResponse(value:unknown, status = 200):Response {
    return new Response(JSON.stringify(value), {
        status,
        headers:{
            "content-type":"application/json; charset=utf-8",
        },
    });
}
