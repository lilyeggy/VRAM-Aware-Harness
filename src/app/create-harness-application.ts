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

export interface HarnessComposition {
    application:HarnessApplication;
    httpApi:HarnessHttpApi;
    database:Database;
    runStore:RunStore;
    checkpointStore:CheckpointStore;
    decisionStore:PolicyDecisionStore;
    templateStore:HarnessTemplateStore;
    instanceStore:HarnessInstanceStore;
    sessionStore:HarnessSessionStore;
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
                subjectId: "bootstrap-operator",
                tenantId: "bootstrap",
                scopes: ["*"],
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

    const baseRuntime = dependencies.runtime
        ?? await createPiRuntime(
            config,
            dependencies.modelRuntime,
            toolGateway,
            runStore,
            sandboxProvider as Partial<SandboxCommandExecutor>,
        );
    const runtime = new ManagedAgentRuntime(
        baseRuntime,
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
    const scheduler = new TenantRunScheduler({
        maxActiveRuns:config.maxActiveRuns,
        maxActiveRunsPerTenant:config.maxActiveRunsPerTenant,
    });
    const policy = new DeterministicExecutionPolicy({
        maxActiveRuns:config.maxActiveRuns,
    });
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
    const recoveryExecutor = new RecoveryExecutor(coordinator);
    const queuedRunRestorer = new QueuedRunRecoveryService(
        runStore,
        checkpointStore,
        coordinator,
    );
    const startupRecovery = new RecoveryStartupCoordinator(
        recoveryService,
        recoveryExecutor,
        queuedRunRestorer,
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
    );
    const httpApi = new HarnessHttpApi(
        application,
        checkpointStore,
        {
            authenticate: (rawKey) => credentialStore.authenticate(rawKey),
            workspaceService,
            auditStore: accessAuditStore,
        },
    );

    let closed = false;

    return {
        application,
        httpApi,
        database,
        runStore,
        checkpointStore,
        decisionStore,
        templateStore,
        instanceStore,
        sessionStore,
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
        async close() {
            if (closed) {
                return;
            }

            await application.stop();

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
