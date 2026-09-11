import { resolve } from "node:path";

import type {
    ResourceThresholds,
} from "../resources/resource-classifier.ts";
import type { SandboxProfile } from "../sandbox/sandbox-profile.ts";
import type { TenantBudget } from "../resources/tenant-budget.ts";
import type {
    LlmBackend,
    LoadBalancingStrategy,
} from "../llm-gateway/model-router.ts";

export interface HarnessConfig {
    databasePath:string;
    httpHost:string;
    httpPort:number;
    workspaceRoot:string;
    bootstrapApiKey:string | undefined;
    /** Pi/Worker 经 LLM 网关调用模型的专用凭证（仅 models:generate scope）。 */
    agentApiKey:string | undefined;
    sandboxProvider:"managed-local" | "container";
    sandboxProfile:SandboxProfile;
    sandboxRuntime:"runsc" | "runc";
    containerImage:string;
    containerUserId:number;
    /** N14：沙箱容器的 PID 上限（docker --pids-limit）。未配置时沿用 128。 */
    containerPidsLimit?:number;
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
    /**
     * 支柱 3：排队 TTL。Run 在队列中等待超过该时长且未获得调度准入时，
     * 状态机安全流转到 FAILED（QUEUE_TIMEOUT），杜绝任务永久饥饿死等。
     */
    queueTtlMs:number;
    /**
     * N10：调度老化阈值（ms）。队首 Run 等待超过该时长即可插队优先调度，
     * 给被洪泛租户挡在后面的正常租户一个确定的等待上界；0 = 关闭老化。
     * 未配置时不启用（保持纯轮转），生产由 harness-config 默认注入。
     */
    schedulerAgingMs?:number;
    executionTimeoutMs?:number;
    interruptGraceMs?:number;
    /** Master-Worker 进程隔离模式："process" 为独立子进程隔离，"in-process" 为主进程内运行 */
    workerIsolation: "process" | "in-process";
    workerScriptPath?: string;
    workerHandshakeTimeoutMs?: number;
    /** 方向 C：LLM 网关后端列表（空数组=网关未启用）。 */
    llmBackends:LlmBackend[];
    /**
     * 支柱 2：后端负载均衡策略。
     * priority=配置顺序主备；round-robin=双卡轮询；least-active=最少活跃连接。
     */
    llmGatewayStrategy:LoadBalancingStrategy;
    /** 支柱 2：后端健康探测周期 ms；0 = 关闭周期探测。 */
    llmHealthProbeIntervalMs:number;
    llmHealthProbePath:string;
    llmRequestTimeoutMs:number;
    /**
     * N28：会话上下文预算（token）。> 0 时网关在转发前按轮次边界压缩过长的
     * 会话历史，避免会话撞上模型窗口后每个请求都被上游 400 拒绝且永不恢复。
     * 0 = 关闭压缩（保持旧行为）。部署时应设在「模型上下文窗口 − 预留输出」以内。
     */
    llmContextBudgetTokens:number;
    /**
     * N8：提交期单次任务输入的上界（字符数）。超过即在提交时拒绝，
     * 不再先 202 接受、等模型侧 400 才失败。
     * 部署时应按所用模型上下文校准（默认 100000 字符，远高于常规任务）。
     */
    maxUserInputChars:number;
    /**
     * N28 主机制：Pi 会话自身的摘要式压缩开关。
     *
     * Pi 侧原先沿用上游默认 reserveTokens=16384 / keepRecentTokens=20000。
     * 那组默认是给大窗口模型调的：在 32768 窗口下触发点是 16384，而它被要求
     * 「至少保留 20000 token 的近期历史」——保留目标比触发点还大，切点只能一路
     * 退到会话开头，prepareCompaction 判定「无可摘要内容」返回 undefined，
     * 压缩静默不执行。真机 8 小时长稳里 87 个 Pi 会话只有 7 个产生过压缩记录，
     * 会话撞窗后每个请求被上游 400 拒绝，且 _overflowRecoveryAttempted 只允许
     * 重试一次，失败后该会话永久不可用（实测出现过 142 次连续失败）。
     *
     * 因此这里必须由 Harness 显式下发适合本部署窗口的参数。
     */
    piCompactionEnabled:boolean;
    /**
     * N28 主机制：Pi 压缩触发时预留给「模型输出 + 下一轮新增内容」的 token 数。
     * 触发点 = 模型窗口 − reserveTokens。必须同时满足：
     *   1) > 单次输出上限（本部署 maxTokens=4096），否则触发时已无输出空间；
     *   2) 大于 keepRecentTokens，否则保留目标够不到切点，压缩退化成空操作。
     */
    piCompactionReserveTokens:number;
    /**
     * N28 主机制：压缩后保留的近期历史 token 数。必须是「切点能落在历史中间」
     * 的量级：取值越小保留越少、摘要越频繁；取值接近触发点则压缩又会退化成
     * 空操作（见 piCompactionReserveTokens 的说明）。
     */
    piCompactionKeepRecentTokens:number;
    /** 支柱 2：是否启用稳定前缀规范化（vLLM Prefix Caching 优化）。 */
    llmPrefixCacheEnabled:boolean;
    /** 支柱 2：流式请求是否由网关注入 include_usage 并采集末尾 usage chunk。 */
    llmStreamUsageCapture:boolean;
    /**
     * B7：租户预算/fair-share 配置（tenantId → weight + maxUnits）。
     * 空 Record = 不启用预算策略（ admission 行为与历史完全一致）；
     * 非空时 BudgetAwareExecutionPolicy 叠加在并发策略之上，
     * 租户超出 min(fairShare, maxUnits) 的 START 决策降级为
     * QUEUE(TENANT_BUDGET_EXCEEDED)。
     */
    tenantBudgets:Record<string, TenantBudget>;
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
    // 支柱 2：工具执行与模型等待期间 GPU 不应空转——默认并发上限放开到
    // 20~30 档位，工具与文件 I/O 在沙箱内并发执行，不独占 GPU 槽位。
    // 每租户并发仍然可配（HARNESS_MAX_ACTIVE_RUNS_PER_TENANT）。
    const maxActiveRuns = positiveInteger(
        environment,
        "HARNESS_MAX_ACTIVE_RUNS",
        30,
    );
    const maxActiveRunsPerTenant = positiveInteger(
        environment,
        "HARNESS_MAX_ACTIVE_RUNS_PER_TENANT",
        10,
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
        agentApiKey:environment.HARNESS_AGENT_API_KEY,
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
        containerPidsLimit:positiveInteger(
            environment,
            "HARNESS_CONTAINER_PIDS_LIMIT",
            128,
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

        llmBackends:loadLlmBackends(environment, piModelId),
        llmGatewayStrategy:loadLlmGatewayStrategy(
            environment.LLM_GATEWAY_STRATEGY,
        ),
        llmHealthProbeIntervalMs:nonNegativeInteger(
            environment,
            "LLM_HEALTH_PROBE_INTERVAL_MS",
            10_000,
        ),
        // N4：探活路径可配置。默认 "/models"——与 /chat/completions 同一
        // 拼接约定（baseUrl 已含 /v1），得到 OpenAI 标准端点 /v1/models；
        // 个别后端只暴露其它端点时用 LLM_HEALTH_PROBE_PATH 覆盖。
        llmHealthProbePath:environment.LLM_HEALTH_PROBE_PATH ?? "/models",
        // N6：单次模型请求（含流式全程）超时。旧实现硬编码 60s 且不可配置，
        // 长输入/长输出任务必然被掐断（真机实测：50k 字符任务连续 4 次
        // ~60s 中止后 RUN_FAILED）。默认放宽到 300s，可用
        // LLM_REQUEST_TIMEOUT_MS 覆盖（大输出/慢后端可调至 600s 以上）。
        llmRequestTimeoutMs:positiveInteger(
            environment,
            "LLM_REQUEST_TIMEOUT_MS",
            300_000,
        ),
        // N28：会话历史超预算时按轮次边界压缩。旧行为下会话累积超过模型窗口后
        // 每个请求都会被上游 400 拒绝且永不恢复（8h 长稳实测 21.3% 的任务因此失败，
        // 最惨会话 142 连败 0 成功）。默认 24000：本部署模型窗口 32768、预留输出
        // 4096，留出安全余量。0 = 关闭压缩。
        llmContextBudgetTokens:nonNegativeInteger(
            environment,
            "LLM_CONTEXT_BUDGET_TOKENS",
            24_000,
        ),
        // N8：提交期输入上界。旧实现不校验，78 万字符会被 202 接受，
        // 直到模型侧返回 400 才失败，且提交响应回显全量输入。
        maxUserInputChars:positiveInteger(
            environment,
            "HARNESS_MAX_USER_INPUT_CHARS",
            100_000,
        ),
        // N28 主机制：Pi 自身摘要式压缩。默认值按本部署的模型窗口（32768）与
        // 单次输出上限（4096）标定——触发点 32768-12288=20480，压缩后保留约
        // 8192，为输出留出 12288 的余量。详见 HarnessConfig 字段注释。
        piCompactionEnabled:environment.PI_COMPACTION_ENABLED
            !== "false"
            && environment.PI_COMPACTION_ENABLED !== "0",
        piCompactionReserveTokens:positiveInteger(
            environment,
            "PI_COMPACTION_RESERVE_TOKENS",
            12_288,
        ),
        piCompactionKeepRecentTokens:positiveInteger(
            environment,
            "PI_COMPACTION_KEEP_RECENT_TOKENS",
            8_192,
        ),
        llmPrefixCacheEnabled:environment.LLM_PREFIX_CACHE
            !== "false"
            && environment.LLM_PREFIX_CACHE !== "0",
        llmStreamUsageCapture:environment.LLM_STREAM_USAGE_CAPTURE
            !== "false"
            && environment.LLM_STREAM_USAGE_CAPTURE !== "0",
        tenantBudgets:parseTenantBudgets(environment.HARNESS_TENANT_BUDGETS),

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
            // N5：同机推理服务（如 vLLM，默认预占 90% 显存）的稳态基线。
            // 准入按「基线之上的增量」判定；无同机推理服务的部署应显式设为 0。
            gpuMemoryBaselinePercent:numberValue(
                environment,
                "HARNESS_GPU_MEMORY_BASELINE_PERCENT",
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
        queueTtlMs:positiveInteger(
            environment,
            "HARNESS_QUEUE_TTL_MS",
            300_000,
        ),
        schedulerAgingMs:nonNegativeInteger(
            environment,
            "HARNESS_SCHEDULER_AGING_MS",
            60_000,
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
        workerIsolation: environment.HARNESS_WORKER_ISOLATION === "in-process"
            ? "in-process"
            : "process",
        workerScriptPath: environment.HARNESS_WORKER_SCRIPT_PATH !== undefined
            ? resolve(cwd, environment.HARNESS_WORKER_SCRIPT_PATH)
            : resolve(cwd, "src/worker/worker-main.ts"),
        workerHandshakeTimeoutMs: environment.HARNESS_WORKER_HANDSHAKE_TIMEOUT_MS !== undefined
            ? positiveInteger(environment, "HARNESS_WORKER_HANDSHAKE_TIMEOUT_MS", 15_000)
            : 15_000,
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

/**
 * B7：HARNESS_TENANT_BUDGETS——JSON Record<tenantId, { weight, maxUnits }>。
 * 例：{"team-a":{"weight":2,"maxUnits":8},"team-b":{"weight":1,"maxUnits":4}}
 * 未设置或空对象 = 不启用预算策略。
 */
function parseTenantBudgets(
    raw:string | undefined,
):Record<string, TenantBudget> {
    if (raw === undefined || raw.trim() === "") {
        return {};
    }
    let parsed:unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("HARNESS_TENANT_BUDGETS 不是合法 JSON");
    }
    if (
        typeof parsed !== "object"
        || parsed === null
        || Array.isArray(parsed)
    ) {
        throw new Error("HARNESS_TENANT_BUDGETS 必须是 JSON 对象");
    }
    const budgets:Record<string, TenantBudget> = {};
    for (const [tenantId, value] of Object.entries(parsed)) {
        const budget = value as Partial<TenantBudget> | null;
        if (
            typeof budget?.weight !== "number"
            || !Number.isFinite(budget.weight)
            || budget.weight <= 0
            || typeof budget?.maxUnits !== "number"
            || !Number.isFinite(budget.maxUnits)
            || budget.maxUnits <= 0
        ) {
            throw new Error(
                `HARNESS_TENANT_BUDGETS[${tenantId}] 需要 weight > 0 和 maxUnits > 0（数字）`,
            );
        }
        budgets[tenantId] = {
            tenantId,
            weight: budget.weight,
            maxUnits: budget.maxUnits,
        };
    }
    return budgets;
}

function parseLlmBackends(raw:string | undefined):LlmBackend[] {    if (raw === undefined || raw.trim() === "") {
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

function loadLlmGatewayStrategy(
    value:string | undefined,
):LoadBalancingStrategy {
    const strategy = value ?? "round-robin";
    if (
        strategy !== "priority"
        && strategy !== "round-robin"
        && strategy !== "least-active"
    ) {
        throw new Error(
            "LLM_GATEWAY_STRATEGY 只支持 priority / round-robin / least-active",
        );
    }
    return strategy;
}

/**
 * 支柱 2：解析 LLM 网关后端。
 * - LLM_BACKENDS（JSON 数组）显式配置优先；
 * - 否则 VLLM_BASE_URLS（逗号分隔，如本地双卡 "http://127.0.0.1:8000/v1,
 *   http://127.0.0.1:8001/v1"）自动展开为 vllm-gpu0 / vllm-gpu1 两个后端；
 * - 都没有时返回空数组（网关未启用，行为与支柱 1 兼容）。
 */
function loadLlmBackends(
    environment:HarnessEnvironment,
    piModelId:string,
):LlmBackend[] {
    if (environment.LLM_BACKENDS !== undefined) {
        return parseLlmBackends(environment.LLM_BACKENDS);
    }
    const rawUrls = environment.VLLM_BASE_URLS;
    if (rawUrls === undefined || rawUrls.trim() === "") {
        return [];
    }
    const urls = rawUrls
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    if (urls.length === 0) {
        throw new Error("VLLM_BASE_URLS 至少需要一个 baseUrl");
    }
    return urls.map((baseUrl, index) => ({
        id:`vllm-gpu${index}`,
        baseUrl,
        model:piModelId,
        logicalModel:piModelId,
    }));
}

function metricsUrlFromBaseUrl(baseUrl:string):string {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/?v1\/?$/, "/metrics");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}
