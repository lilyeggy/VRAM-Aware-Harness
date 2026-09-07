import { resolve } from "node:path";

import type {
    ResourceThresholds,
} from "../resources/resource-classifier.ts";
import type { SandboxProfile } from "../sandbox/sandbox-profile.ts";
import type { LlmBackend } from "../llm-gateway/model-router.ts";

export interface HarnessConfig {
    databasePath:string;
    httpHost:string;
    httpPort:number;
    workspaceRoot:string;
    bootstrapApiKey:string | undefined;
    sandboxProvider:"managed-local" | "container";
    sandboxProfile:SandboxProfile;
    sandboxRuntime:"runsc" | "runc";
    containerImage:string;
    containerUserId:number;
    sandboxWarmPoolSize?:number;

    piProvider:string;
    piModelId:string;
    piTools:string[];
    piModelsPath:string;
    piAuthPath:string | undefined;

    vllmMetricsUrl:string;
    resourceObservationTimeoutMs:number;
    resourceMetricsIntervalMs:number;
    gpuIds:string[];
    resourceThresholds:ResourceThresholds;

    maxActiveRuns:number;
    maxActiveRunsPerTenant:number;
    pumpIntervalMs:number;
    executionTimeoutMs?:number;
    interruptGraceMs?:number;
    /** 方向 C：LLM 网关后端列表（空数组=网关未启用）。 */
    llmBackends:LlmBackend[];
}

export type HarnessEnvironment = Record<string,string | undefined>;

export function loadHarnessConfig(
    environment:HarnessEnvironment = process.env,
    cwd = process.cwd(),
):HarnessConfig {
    const piModelId = requiredString(
        environment,
        "VLLM_MODEL_ID",
    );
    const vllmBaseUrl = environment.VLLM_BASE_URL
        ?? "http://127.0.0.1:8000/v1";
    const maxActiveRuns = positiveInteger(
        environment,
        "HARNESS_MAX_ACTIVE_RUNS",
        2,
    );
    const maxActiveRunsPerTenant = positiveInteger(
        environment,
        "HARNESS_MAX_ACTIVE_RUNS_PER_TENANT",
        1,
    );

    if (maxActiveRunsPerTenant > maxActiveRuns) {
        throw new Error(
            "HARNESS_MAX_ACTIVE_RUNS_PER_TENANT 不能大于 HARNESS_MAX_ACTIVE_RUNS",
        );
    }
    const sandboxProvider = environment.HARNESS_SANDBOX_PROVIDER === "container"
        ? "container"
        : "managed-local";
    const sandboxProfile = loadSandboxProfile(
        environment.HARNESS_SANDBOX_PROFILE,
        sandboxProvider === "container" ? "default" : "development",
    );
    const sandboxRuntime = loadSandboxRuntime(
        environment.HARNESS_SANDBOX_RUNTIME,
        sandboxProvider === "container" ? "runsc" : "runc",
    );
    if (sandboxProvider === "managed-local" && sandboxProfile !== "development") {
        throw new Error("MANAGED_LOCAL 只能使用 development sandbox profile");
    }
    if (sandboxProvider === "container" && sandboxProfile === "development") {
        throw new Error("Container Provider 不能使用 development profile");
    }
    if (
        (sandboxProfile === "default" || sandboxProfile === "restricted-egress")
        && sandboxRuntime !== "runsc"
    ) {
        throw new Error(`${sandboxProfile} sandbox profile 禁止回退到 ${sandboxRuntime}`);
    }

    return {
        ...(environment.HARNESS_SANDBOX_WARM_POOL_SIZE === undefined ? {} : {
            sandboxWarmPoolSize: positiveInteger(environment, 'HARNESS_SANDBOX_WARM_POOL_SIZE', 2),
        }),
        databasePath:environment.HARNESS_DATABASE_PATH
            ?? resolve(cwd, "data/harness.sqlite"),
        httpHost:environment.HARNESS_HOST ?? "127.0.0.1",
        httpPort:port(environment, "HARNESS_PORT", 3000),
        workspaceRoot:resolve(
            cwd,
            environment.HARNESS_WORKSPACE_ROOT ?? "data/workspaces",
        ),
        bootstrapApiKey:environment.HARNESS_BOOTSTRAP_API_KEY,
        sandboxProvider:environment.HARNESS_SANDBOX_PROVIDER === "container"
            ? "container"
            : "managed-local",
        sandboxProfile,
        sandboxRuntime,
        containerImage:environment.HARNESS_CONTAINER_IMAGE ?? "alpine:3.20",
        containerUserId:positiveInteger(
            environment,
            "HARNESS_CONTAINER_USER_ID",
            65532,
        ),

        piProvider:environment.PI_PROVIDER ?? "local-vllm",
        piModelId,
        piTools:stringList(
            environment.PI_TOOLS,
            ["read", "bash", "edit", "write", "grep", "find", "ls"],
        ),
        piModelsPath:resolve(
            cwd,
            environment.PI_MODELS_PATH ?? ".pi/spike/models.json",
        ),
        piAuthPath:environment.PI_AUTH_PATH === undefined
            ? undefined
            : resolve(cwd, environment.PI_AUTH_PATH),

        llmBackends:parseLlmBackends(environment.LLM_BACKENDS),

        vllmMetricsUrl:environment.VLLM_METRICS_URL
            ?? metricsUrlFromBaseUrl(vllmBaseUrl),
        resourceObservationTimeoutMs:positiveInteger(
            environment,
            "HARNESS_RESOURCE_TIMEOUT_MS",
            3_000,
        ),
        resourceMetricsIntervalMs:positiveInteger(environment, "HARNESS_RESOURCE_METRICS_INTERVAL_MS", 1_000),
        gpuIds:stringList(environment.HARNESS_GPU_IDS, ["0"]),
        resourceThresholds:{
            busyGpuMemoryPercent:numberValue(
                environment,
                "HARNESS_BUSY_GPU_MEMORY_PERCENT",
                70,
            ),
            criticalGpuMemoryPercent:numberValue(
                environment,
                "HARNESS_CRITICAL_GPU_MEMORY_PERCENT",
                90,
            ),
            busyKvCachePercent:numberValue(
                environment,
                "HARNESS_BUSY_KV_CACHE_PERCENT",
                60,
            ),
            criticalKvCachePercent:numberValue(
                environment,
                "HARNESS_CRITICAL_KV_CACHE_PERCENT",
                85,
            ),
            busyRunningRequests:nonNegativeInteger(
                environment,
                "HARNESS_BUSY_RUNNING_REQUESTS",
                4,
            ),
            criticalRunningRequests:nonNegativeInteger(
                environment,
                "HARNESS_CRITICAL_RUNNING_REQUESTS",
                8,
            ),
            busyWaitingRequests:nonNegativeInteger(
                environment,
                "HARNESS_BUSY_WAITING_REQUESTS",
                1,
            ),
            criticalWaitingRequests:nonNegativeInteger(
                environment,
                "HARNESS_CRITICAL_WAITING_REQUESTS",
                4,
            ),
        },

        maxActiveRuns,
        maxActiveRunsPerTenant,
        pumpIntervalMs:positiveInteger(
            environment,
            "HARNESS_PUMP_INTERVAL_MS",
            1_000,
        ),
        executionTimeoutMs:positiveInteger(
            environment,
            "HARNESS_EXECUTION_TIMEOUT_MS",
            30 * 60_000,
        ),
        interruptGraceMs:positiveInteger(
            environment,
            "HARNESS_INTERRUPT_GRACE_MS",
            10_000,
        ),
    };
}

function requiredString(
    environment:HarnessEnvironment,
    name:string,
):string {
    const value = environment[name]?.trim();

    if (value === undefined || value.length === 0) {
        throw new Error(`必须设置环境变量 ${name}`);
    }

    return value;
}

function positiveInteger(
    environment:HarnessEnvironment,
    name:string,
    defaultValue:number,
):number {
    const value = numberValue(environment, name, defaultValue);

    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} 必须是正整数`);
    }

    return value;
}

function nonNegativeInteger(
    environment:HarnessEnvironment,
    name:string,
    defaultValue:number,
):number {
    const value = numberValue(environment, name, defaultValue);

    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} 必须是非负整数`);
    }

    return value;
}

function numberValue(
    environment:HarnessEnvironment,
    name:string,
    defaultValue:number,
):number {
    const rawValue = environment[name];

    if (rawValue === undefined) {
        return defaultValue;
    }

    const value = Number(rawValue);

    if (!Number.isFinite(value)) {
        throw new Error(`${name} 必须是有限数字`);
    }

    return value;
}

function port(
    environment:HarnessEnvironment,
    name:string,
    defaultValue:number,
):number {
    const value = positiveInteger(environment, name, defaultValue);

    if (value > 65_535) {
        throw new Error(`${name} 必须小于或等于 65535`);
    }

    return value;
}

function stringList(
    value:string | undefined,
    defaultValue:string[],
):string[] {
    if (value === undefined) {
        return [...defaultValue];
    }

    const values = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    if (values.length === 0) {
        throw new Error("逗号分隔配置至少需要一个值");
    }

    return values;
}

function loadSandboxProfile(
    value:string | undefined,
    defaultValue:SandboxProfile,
):SandboxProfile {
    const profile = value ?? defaultValue;
    if (
        profile !== "development"
        && profile !== "default"
        && profile !== "restricted-egress"
        && profile !== "strict"
    ) {
        throw new Error(`HARNESS_SANDBOX_PROFILE 不支持：${profile}`);
    }
    return profile;
}

function parseLlmBackends(raw:string | undefined):LlmBackend[] {
    if (raw === undefined || raw.trim() === "") {
        return [];
    }
    let parsed:unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("LLM_BACKENDS 不是合法 JSON");
    }
    if (!Array.isArray(parsed)) {
        throw new Error("LLM_BACKENDS 必须是 JSON 数组");
    }
    return parsed.map((item, index) => {
        const b = item as Partial<LlmBackend>;
        if (!b?.id || !b?.baseUrl || !b?.model || !b?.logicalModel) {
            throw new Error(
                `LLM_BACKENDS[${index}] 缺少 id/baseUrl/model/logicalModel`,
            );
        }
        return {
            id:b.id,
            baseUrl:b.baseUrl,
            apiKey:b.apiKey,
            model:b.model,
            logicalModel:b.logicalModel,
        };
    });
}

function loadSandboxRuntime(
    value:string | undefined,
    defaultValue:"runsc" | "runc",
):"runsc" | "runc" {
    const runtime = value ?? defaultValue;
    if (runtime !== "runsc" && runtime !== "runc") {
        throw new Error(`HARNESS_SANDBOX_RUNTIME 不支持：${runtime}`);
    }
    return runtime;
}

function metricsUrlFromBaseUrl(baseUrl:string):string {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/?v1\/?$/, "/metrics");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}
