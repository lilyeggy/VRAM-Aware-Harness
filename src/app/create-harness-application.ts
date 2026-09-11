import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { DefaultPiControlPlane } from "../control-plane/default-pi-control-plane.ts";
import { HarnessInstanceStore } from "../instances/harness-instance-store.ts";
import { HarnessHttpApi } from "../http/harness-http-api.ts";
import { ApiCredentialStore } from "../auth/api-credential-store.ts";
import { AccessAuditStore } from "../audit/access-audit-store.ts";
import { WorkspaceStore } from "../workspaces/workspace-store.ts";
import { WorkspaceService } from "../workspaces/workspace-service.ts";
import { RunWorkspaceResultCoordinator } from "../workspaces/run-workspace-result.ts";
import { RunWorkspaceResultStore } from "../workspaces/run-workspace-result-store.ts";
import { RunArtifactStore } from "../workspaces/run-artifact-store.ts";
import { CheckpointStore } from "../checkpoints/checkpoint-store.ts";
import { RecoveryExecutor } from "../checkpoints/recovery-executor.ts";
import { RecoveryService } from "../checkpoints/recovery-service.ts";
import {
    RecoveryStartupCoordinator,
} from "../checkpoints/recovery-startup-coordinator.ts";
import {
    DeterministicExecutionPolicy,
} from "../resources/execution-policy.ts";
import {
    BudgetAwareExecutionPolicy,
    SchedulerCapacityBudgetUsage,
} from "../resources/budget-aware-policy.ts";
import {
    PolicyDecisionStore,
} from "../resources/policy-decision-store.ts";
import {
    ResourceAdmissionService,
} from "../resources/resource-admission-service.ts";
import type {
    ResourceObserver,
} from "../resources/resource-observer.ts";
import {
    VllmResourceObserver,
} from "../resources/vllm-resource-observer.ts";
import type {
    AgentRuntime,
} from "../runtime/agent-runtime.ts";
import { PiAdapter } from "../runtime/pi-adapter.ts";
import { RuntimeCapabilityProfileStore } from "../runtime/runtime-capability-store.ts";
import type { RuntimeCapabilityProfile } from "../runtime/runtime-capability.ts";
import { ManagedAgentRuntime } from "../runtime/managed-agent-runtime.ts";
import { SupervisedAgentRuntime } from "../runtime/supervised-agent-runtime.ts";
import { WorkerProcessAgentRuntime } from "../runtime/worker-process-runtime.ts";
import { EffectivePolicyStore } from "../policies/effective-policy-store.ts";
import { PolicyRegistry } from "../policies/policy-registry.ts";
import { PersistentToolPolicyGuard } from "../policies/tool-policy-guard.ts";
import type { SandboxProvider, SecretProvider } from "../sandbox/sandbox-provider.ts";
import type { SandboxCommandExecutor } from "../sandbox/sandbox-provider.ts";
import {
    SandboxProviderRouter,
    UnavailableStrictSandboxProvider,
} from "../sandbox/sandbox-provider-router.ts";
import { SandboxStore } from "../sandbox/sandbox-store.ts";
import { SandboxStartupReconciler } from "../sandbox/sandbox-startup-reconciler.ts";
import {
    EnvironmentSecretProvider,
    ManagedLocalSandboxProvider,
} from "../sandbox/managed-local-sandbox.ts";
import { ContainerSandboxProvider } from "../sandbox/container-sandbox-provider.ts";
import { RunService } from "../runs/run-service.ts";
import { RunStore } from "../runs/runstore.ts";
import { RunAttemptStore } from "../runs/run-attempt-store.ts";
import { RunOutputStore } from "../runs/run-output-store.ts";
import { HarnessSessionStore } from "../sessions/harness-session-store.ts";
import { ConversationStore } from "../conversations/conversation-store.ts";
import {
    QueuedRunRecoveryService,
} from "../scheduling/queued-run-recovery-service.ts";
import {
    RunQueueCoordinator,
} from "../scheduling/run-queue-coordinator.ts";
import { RunQueuePump } from "../scheduling/run-queue-pump.ts";
import {
    TenantRunScheduler,
} from "../scheduling/tenant-run-scheduler.ts";
import { openHarnessDatabase } from "../storage/database.ts";
import { EvaluationAggregator } from "../eval/evaluation-aggregator.ts";
import {
    LlmCacheMetricsStore,
} from "../eval/llm-cache-metrics-store.ts";
import { ModelRouter } from "../llm-gateway/model-router.ts";
import { LlmGateway } from "../llm-gateway/llm-gateway.ts";
import {
    BackendHealthMonitor,
} from "../llm-gateway/backend-health-monitor.ts";
import { HarnessTemplateStore } from "../templates/harness-template-store.ts";
import { ToolExecutionStore } from "../tools/tool-execution-store.ts";
import { ToolGateway } from "../tools/tool-gateway.ts";
import { HarnessApplication } from "./harness-application.ts";
import type { HarnessConfig } from "./harness-config.ts";

export interface HarnessCompositionDependencies {
    database?:Database;
    runtime?:AgentRuntime;
    resourceObserver?:ResourceObserver;
    modelRuntime?:ModelRuntime;
    onPumpError?:(error:unknown) => void;
    policyRegistry?:PolicyRegistry;
    sandboxProvider?:SandboxProvider;
    secretProvider?:SecretProvider;
    capabilityProfile?:RuntimeCapabilityProfile;
}

import { ResourceMetricsSampler } from "../resources/resource-metrics-sampler.ts";

export interface HarnessComposition {
    resourceMetrics: ResourceMetricsSampler;
    application:HarnessApplication;
    httpApi:HarnessHttpApi;
    database:Database;
    runStore:RunStore;
    checkpointStore:CheckpointStore;
    decisionStore:PolicyDecisionStore;
    templateStore:HarnessTemplateStore;
    instanceStore:HarnessInstanceStore;
    sessionStore:HarnessSessionStore;
    conversationStore:ConversationStore;
    attemptStore:RunAttemptStore;
    capabilityStore:RuntimeCapabilityProfileStore;
    effectivePolicyStore:EffectivePolicyStore;
    policyRegistry:PolicyRegistry;
    sandboxStore:SandboxStore;
    sandboxProvider:SandboxProvider;
    toolExecutionStore:ToolExecutionStore;
    toolGateway:ToolGateway;
    runOutputStore:RunOutputStore;
    workspaceResultStore:RunWorkspaceResultStore;
    artifactStore:RunArtifactStore;
    workspaceResultCoordinator:RunWorkspaceResultCoordinator;
    credentialStore:ApiCredentialStore;
    workspaceStore:WorkspaceStore;
    workspaceService:WorkspaceService;
    accessAuditStore:AccessAuditStore;
    scheduler:TenantRunScheduler;
    queuePump:RunQueuePump;
    runtime:AgentRuntime;
    resourceObserver:ResourceObserver;
    /** 支柱 2：双卡 vLLM 网关（未配置后端时为 undefined）。 */
    llmGateway:LlmGateway | undefined;
    /** 支柱 2：后端健康探测（网关未启用或探测周期为 0 时为 undefined）。 */
    llmHealthMonitor:BackendHealthMonitor | undefined;
    /** 支柱 2：缓存命中指标持久化台账（网关未启用时为 undefined）。 */
    llmCacheMetricsStore:LlmCacheMetricsStore | undefined;
    /** 支柱 3：恢复执行器（含 MANUAL_REVIEW 审计与 fail-closed 重校验）。 */
    recoveryExecutor:RecoveryExecutor;
    close():Promise<void>;
}

export async function createHarnessApplication(
    config:HarnessConfig,
    dependencies:HarnessCompositionDependencies = {},
):Promise<HarnessComposition> {
    const ownsDatabase = dependencies.database === undefined;

    if (ownsDatabase && config.databasePath !== ":memory:") {
        mkdirSync(dirname(config.databasePath), { recursive:true });
    }

    const database = dependencies.database
        ?? openHarnessDatabase(config.databasePath);
    const runStore = new RunStore(database);
    const runOutputStore = new RunOutputStore(database);
    const checkpointStore = new CheckpointStore(database);
    const toolExecutionStore = new ToolExecutionStore(database);
    const decisionStore = new PolicyDecisionStore(database);
    const templateStore = new HarnessTemplateStore(database);
    const instanceStore = new HarnessInstanceStore(database);
    const sessionStore = new HarnessSessionStore(database);
    const conversationStore = new ConversationStore(database);
    const attemptStore = new RunAttemptStore(database);
    const capabilityStore = new RuntimeCapabilityProfileStore(database);
    const effectivePolicyStore = new EffectivePolicyStore(database);
    const policyRegistry = dependencies.policyRegistry ?? new PolicyRegistry();
    const sandboxStore = new SandboxStore(database);
    const credentialStore = new ApiCredentialStore(database);
    const accessAuditStore = new AccessAuditStore(database);
    const workspaceStore = new WorkspaceStore(database);
    const workspaceService = new WorkspaceService(
        config.workspaceRoot,
        workspaceStore,
        config.sandboxProvider === "container" ? config.containerUserId : undefined,
    );
    const workspaceResultStore = new RunWorkspaceResultStore(database);
    const artifactStore = new RunArtifactStore(
        database,
        resolve(config.workspaceRoot, "..", "artifacts"),
    );
    const workspaceResultCoordinator = new RunWorkspaceResultCoordinator(
        workspaceResultStore,
        artifactStore,
    );
    if (config.bootstrapApiKey !== undefined) {
        // A repeat start must not overwrite credentials or make a second bootstrap identity.
        try {
            credentialStore.create({
                rawKey: config.bootstrapApiKey,
                tenantId: "bootstrap",
                scopes: ["*"],
            });
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("UNIQUE")) {
                throw error;
            }
        }
    }
    if (config.agentApiKey !== undefined) {
        // Pi/Worker 经 LLM 网关调用模型时使用这把专用凭证：只授 models:generate，
        // 与人工 bootstrap key 分离，泄露时可单独撤销（最小权限 + 可审计归属）。
        try {
            credentialStore.create({
                rawKey: config.agentApiKey,
                tenantId: "agent-runtime",
                scopes: ["models:generate"],
            });
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("UNIQUE")) {
                throw error;
            }
        }
    }
    const secretProvider = dependencies.secretProvider
        ?? new EnvironmentSecretProvider(process.env);
    const sandboxProvider = dependencies.sandboxProvider
        ?? (config.sandboxProvider === "container"
            ? createContainerSandboxRouter(
                sandboxStore,
                secretProvider,
                config,
            )
            : new ManagedLocalSandboxProvider(sandboxStore, secretProvider, {
                profile: config.sandboxProfile,
            }));
    const toolGateway = new ToolGateway(
        toolExecutionStore,
        new PersistentToolPolicyGuard(effectivePolicyStore),
    );

    // B1：WAITING_TOOL 接线——RunService 在 baseRuntime 之后创建，
    // 通过晚绑定引用把工具执行阶段回调接到状态机。
    let runServiceRef: RunService | undefined;
    const notifyToolExecutionPhase = (
        runId: string,
        phase: "STARTED" | "ENDED",
        info: { toolName: string; toolCallId: string },
    ): void => {
        try {
            runServiceRef?.markToolPhase(runId, phase, info);
        } catch (error) {
            console.error("[Harness] Tool phase transition failed:", error);
        }
    };

    const baseRuntime = dependencies.runtime
        ?? (config.workerIsolation === "process"
            ? new WorkerProcessAgentRuntime({
                workerScriptPath: config.workerScriptPath,
                bunCommand: "bun",
                cwd: process.cwd(),
                interruptGraceMs: config.interruptGraceMs ?? 10_000,
                workerHandshakeTimeoutMs: config.workerHandshakeTimeoutMs ?? 15_000,
                workerConfig: {
                    piProvider: config.piProvider,
                    piModelId: config.piModelId,
                    piTools: config.piTools,
                    piModelsPath: config.piModelsPath,
                    piAuthPath: config.piAuthPath,
                    sandboxProvider: config.sandboxProvider,
                    sandboxProfile: config.sandboxProfile,
                    sandboxRuntime: config.sandboxRuntime,
                    containerImage: config.containerImage,
                    containerUserId: config.containerUserId,
                },
                orphanSandboxCleaner: async (sandboxId: string) => {
                    await (sandboxProvider as SandboxProvider).terminate(sandboxId).catch(() => undefined);
                },
                // 支柱 0 × 支柱 1 合龙：Worker 内真实工具执行经此桥回到 Master
                // 走完整 ToolGateway 流水线（策略守卫 + PREPARED 记账 + Checkpoint）。
                toolGatewayBridge: toolGateway,
                getRunEventSequence: (runId: string) => runStore.getLastEventSequence(runId),
                onToolExecutionPhase: notifyToolExecutionPhase,
            })
            : await createPiRuntime(
                config,
                dependencies.modelRuntime,
                toolGateway,
                runStore,
                sandboxProvider as Partial<SandboxCommandExecutor>,
            ));
    const supervisedRuntime = new SupervisedAgentRuntime(
        baseRuntime,
        sandboxProvider,
        {
            executionTimeoutMs: config.executionTimeoutMs ?? 30 * 60_000,
            interruptGraceMs: config.interruptGraceMs ?? 10_000,
        },
    );
    const runtime = new ManagedAgentRuntime(
        supervisedRuntime,
        runStore,
        templateStore,
        instanceStore,
        sessionStore,
        capabilityStore,
        attemptStore,
        effectivePolicyStore,
        policyRegistry,
        sandboxProvider,
        config.sandboxProfile,
    );
    const resourceObserver = dependencies.resourceObserver
        ?? new VllmResourceObserver({
            metricsUrl:config.vllmMetricsUrl,
            timeoutMs:config.resourceObservationTimeoutMs,
            gpuIds:config.gpuIds,
        });
    const controlPlane = new DefaultPiControlPlane(
        templateStore,
        instanceStore,
        sessionStore,
        capabilityStore,
        {
            provider: config.piProvider,
            modelId: config.piModelId,
            tools: config.piTools,
            capabilityProfile: dependencies.capabilityProfile
                ?? baseRuntime.getCapabilityProfile?.(),
        },
    );
    const runService = new RunService(
        runStore, runtime, controlPlane, undefined, runOutputStore,
        workspaceResultCoordinator,
    );
    runServiceRef = runService;
    const scheduler = new TenantRunScheduler({
        maxActiveRuns:config.maxActiveRuns,
        maxActiveRunsPerTenant:config.maxActiveRunsPerTenant,
    });
    const basePolicy = new DeterministicExecutionPolicy({
        maxActiveRuns:config.maxActiveRuns,
    });
    // B7：预算/fair-share 策略接线——仅在显式配置租户预算时叠加；
    // 未配置时 admission 行为与历史完全一致（opt-in 组合，非默认开启）。
    const budgetTenantIds = Object.keys(config.tenantBudgets);
    const policy = budgetTenantIds.length > 0
        ? new BudgetAwareExecutionPolicy(
            basePolicy,
            new SchedulerCapacityBudgetUsage(
                scheduler,
                config.tenantBudgets,
                config.maxActiveRuns,
                Object.fromEntries(
                    budgetTenantIds.map((tenantId) => [
                        tenantId,
                        config.tenantBudgets[tenantId]!.weight,
                    ]),
                ),
            ),
        )
        : basePolicy;
    const admission = new ResourceAdmissionService(
        resourceObserver,
        config.resourceThresholds,
        policy,
        decisionStore,
    );
    const coordinator = new RunQueueCoordinator(
        runService,
        scheduler,
        admission,
        undefined,
        undefined,
        null,
        false,
        {
            // 支柱 3：排队 TTL——队列等待超过门限的 Run 安全熔断为
            // FAILED(QUEUE_TIMEOUT)，防止多租户调度器被死等任务拖垮。
            queueTtlMs: config.queueTtlMs,
            // B4/B5：DB 对账——孤儿 QUEUED Run 重入队 + TTL 不依赖 pump 存活。
            queuedRunReader: runStore,
        },
    );
    const queuePump = new RunQueuePump(coordinator, {
        intervalMs:config.pumpIntervalMs,
        onError:dependencies.onPumpError ?? ((error) => {
            console.error("RunQueuePump 推进失败", error);
        }),
    });
    const recoveryService = new RecoveryService(
        runStore,
        toolExecutionStore,
        checkpointStore,
    );
    const recoveryExecutor = new RecoveryExecutor(
        coordinator,
        // 支柱 3：MANUAL_REVIEW 落审计证据。Run 保持 INTERRUPTED，
        // 阻断原因与工具副作用证据进入事件时间线，等待人工确认后
        // 才能通过既有恢复 API 继续推进。
        (plan, decision) => {
            const current = runStore.get(plan.run.id);
            if (current === null || current.status !== "INTERRUPTED") {
                return;
            }
            runStore.appendEvent({
                eventId: crypto.randomUUID(),
                runId: plan.run.id,
                sequence: runStore.getLastEventSequence(plan.run.id) + 1,
                type: "RUN_INTERRUPTED",
                timestamp: new Date().toISOString(),
                payloadVersion: 1,
                payload: {
                    reason: "MANUAL_REVIEW_REQUIRED",
                    recoveryAction: decision.action,
                    recoveryReason: decision.reason,
                    blockingToolExecutionId:
                        decision.blockingToolExecutionId,
                },
            });
        },
    );
    const queuedRunRestorer = new QueuedRunRecoveryService(
        runStore,
        checkpointStore,
        coordinator,
    );
    const sandboxReconciler = new SandboxStartupReconciler(
        sandboxStore,
        sandboxProvider,
        attemptStore,
        instanceStore,
    );
    const startupRecovery = new RecoveryStartupCoordinator(
        recoveryService,
        recoveryExecutor,
        queuedRunRestorer,
        sandboxReconciler,
    );
    const application = new HarnessApplication(
        coordinator,
        queuePump,
        runStore,
        decisionStore,
        scheduler,
        resourceObserver,
        startupRecovery,
        runOutputStore,
        workspaceResultCoordinator,
        instanceStore,
        conversationStore,
        effectivePolicyStore,
    );
    const evaluationAggregator = new EvaluationAggregator(database);
    // Separate observer instance: token-rate counters must not race admission probes.
    const resourceMetrics = new ResourceMetricsSampler(dependencies.resourceObserver ?? new VllmResourceObserver({
        metricsUrl: config.vllmMetricsUrl,
        timeoutMs: config.resourceObservationTimeoutMs,
        gpuIds: config.gpuIds,
    }), { intervalMs: config.resourceMetricsIntervalMs });
    // 支柱 2：LLM 网关（仅当配置了后端时启用）。
    // - 双卡负载均衡：策略来自 config.llmGatewayStrategy（默认 round-robin）；
    // - 健康探测：周期回填 ModelRouter 健康状态；
    // - 缓存命中：cached_tokens 样本同步落 SQLite（llm_cache_metrics）。
    let llmGateway:LlmGateway | undefined;
    let llmHealthMonitor:BackendHealthMonitor | undefined;
    let llmCacheMetricsStore:LlmCacheMetricsStore | undefined;
    if (config.llmBackends.length > 0) {
        const llmRouter = new ModelRouter(config.llmBackends, {
            loadBalancing: config.llmGatewayStrategy,
        });
        llmCacheMetricsStore = new LlmCacheMetricsStore(database);
        llmGateway = new LlmGateway(llmRouter, {
            cacheSampleSink: (sample) => {
                llmCacheMetricsStore?.record(sample);
            },
            prefixCacheEnabled: config.llmPrefixCacheEnabled,
            streamUsageCapture: config.llmStreamUsageCapture,
            requestTimeoutMs: config.llmRequestTimeoutMs,
            contextBudgetTokens: config.llmContextBudgetTokens,
        });
        if (config.llmHealthProbeIntervalMs > 0) {
            llmHealthMonitor = new BackendHealthMonitor(
                llmRouter,
                config.llmBackends,
                {
                    probeIntervalMs: config.llmHealthProbeIntervalMs,
                    probePath: config.llmHealthProbePath,
                },
            );
            llmHealthMonitor.start();
        }
    }
    const httpApi = new HarnessHttpApi(
        application,
        checkpointStore,
        {
            authenticate: (rawKey) => credentialStore.authenticate(rawKey),
            registerUser: (email, password) => credentialStore.registerUser(email, password),
            loginUser: (email, password) => credentialStore.loginUser(email, password),
            revokeSession: (token) => credentialStore.revokeSession(token),
            sessionOwner: (token) => credentialStore.sessionOwner(token),
            revokeAllSessions: (userId) => credentialStore.revokeAllSessions(userId),
            workspaceService,
            auditStore: accessAuditStore,
        },
        evaluationAggregator,
        llmGateway,
        resourceMetrics,
        // N8：提交期输入上界。
        { maxUserInputChars: config.maxUserInputChars },
    );

    let closed = false;

    return {
        resourceMetrics,
        application,
        httpApi,
        database,
        runStore,
        checkpointStore,
        decisionStore,
        templateStore,
        instanceStore,
        sessionStore,
        conversationStore,
        attemptStore,
        capabilityStore,
        effectivePolicyStore,
        policyRegistry,
        sandboxStore,
        sandboxProvider,
        toolExecutionStore,
        toolGateway,
        runOutputStore,
        workspaceResultStore,
        artifactStore,
        workspaceResultCoordinator,
        credentialStore,
        workspaceStore,
        workspaceService,
        accessAuditStore,
        scheduler,
        queuePump,
        runtime,
        resourceObserver,
        llmGateway,
        llmHealthMonitor,
        llmCacheMetricsStore,
        recoveryExecutor,
        async close() {
            if (closed) {
                return;
            }

            await application.stop();
            llmHealthMonitor?.stop();
            resourceMetrics.stop();
            await (sandboxProvider as SandboxProvider).close?.();

            if (ownsDatabase) {
                database.close();
            }

            closed = true;
        },
    };
}

function createContainerSandboxRouter(
    sandboxStore:SandboxStore,
    secretProvider:SecretProvider,
    config:HarnessConfig,
):SandboxProvider {
    const strict = new UnavailableStrictSandboxProvider();
    if (config.sandboxProfile === "strict") {
        return new SandboxProviderRouter({ strict }, "strict");
    }
    const container = new ContainerSandboxProvider(sandboxStore, secretProvider, {
        image: config.containerImage,
        profile: config.sandboxProfile,
        sandboxRuntime: config.sandboxRuntime,
        userId: config.containerUserId,
        warmPoolSize: config.sandboxWarmPoolSize,
        warmPoolOwner: `port-${config.httpPort}`,
    });
    return new SandboxProviderRouter({
        default: container,
        "restricted-egress": container,
        strict,
    }, config.sandboxProfile);
}

async function createPiRuntime(
    config:HarnessConfig,
    injectedModelRuntime:ModelRuntime | undefined,
    toolGateway:ToolGateway,
    runStore:RunStore,
    sandboxProvider?: Partial<SandboxCommandExecutor>,
):Promise<PiAdapter> {
    const modelRuntime = injectedModelRuntime
        ?? await ModelRuntime.create({
            modelsPath:config.piModelsPath,
            ...(config.piAuthPath === undefined
                ? {}
                : { authPath:config.piAuthPath }),
        });

    if (
        modelRuntime.getModel(
            config.piProvider,
            config.piModelId,
        ) === undefined
    ) {
        throw new Error(
            `Pi 模型配置中找不到 ${config.piProvider}/${config.piModelId}`,
        );
    }

    return new PiAdapter(modelRuntime, {
        provider:config.piProvider,
        modelId:config.piModelId,
        tools:config.piTools,
    }, {
        gateway:toolGateway,
        getLastEventSequence(runId) {
            return runStore.getLastEventSequence(runId);
        },
        ...(sandboxProvider?.execute === undefined
            ? {}
            : { sandboxExecutor: sandboxProvider as SandboxCommandExecutor }),
    });
}
