import {
    transitionHarnessInstance,
} from "../instances/harness-instance.ts";
import type { HarnessInstanceStore } from "../instances/harness-instance-store.ts";
import {
    computeEffectivePolicy,
    createPolicyLayer,
    withSandboxProfile,
    unrestrictedPolicy,
    type PolicyConstraints,
} from "../policies/effective-policy.ts";
import type { EffectivePolicyStore } from "../policies/effective-policy-store.ts";
import {
    compilePiPolicy,
    type PolicyCompilationRecord,
} from "../policies/policy-compilation.ts";
import type { PolicyRegistry } from "../policies/policy-registry.ts";
import {
    validateRuntimeCapabilities,
} from "./runtime-capability.ts";
import type { RuntimeCapabilityProfileStore } from "./runtime-capability-store.ts";
import {
    createRunAttempt,
    finishRunAttempt,
    startRunAttempt,
    type RunAttempt,
    type RunAttemptKind,
} from "../runs/run-attempt.ts";
import type { RunAttemptStore } from "../runs/run-attempt-store.ts";
import type { RunStore } from "../runs/runstore.ts";
import {
    bindRuntimeSession,
} from "../sessions/harness-session.ts";
import type { HarnessSessionStore } from "../sessions/harness-session-store.ts";
import type { SandboxProvider, SandboxLifecycleEvent } from "../sandbox/sandbox-provider.ts";
import type { SandboxProfile } from "../sandbox/sandbox-profile.ts";
import type { HarnessTemplateStore } from "../templates/harness-template-store.ts";
import type {
    AgentRuntime,
    RuntimeEvent,
    RuntimeEventHandler,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "./agent-runtime.ts";

interface ActiveExecution {
    attemptId: string;
    instanceId: string;
}

/**
 * 将模板、能力、有效策略、Sandbox 和 Attempt 包在具体 Runtime 外层。
 * 缺少 Stage 1 绑定的旧直接调用继续透传；正式应用入口始终走受管路径。
 */
export class ManagedAgentRuntime implements AgentRuntime {
    private readonly handlers = new Map<string, Set<RuntimeEventHandler>>();
    private readonly activeBySandboxId = new Map<string, ActiveExecution>();

    constructor(
        private readonly inner: AgentRuntime,
        private readonly runs: RunStore,
        private readonly templates: HarnessTemplateStore,
        private readonly instances: HarnessInstanceStore,
        private readonly sessions: HarnessSessionStore,
        private readonly capabilities: RuntimeCapabilityProfileStore,
        private readonly attempts: RunAttemptStore,
        private readonly policies: EffectivePolicyStore,
        private readonly policyRegistry: PolicyRegistry,
        private readonly sandbox: SandboxProvider,
        private readonly sandboxProfile: SandboxProfile = "development",
    ) {
        this.sandbox.subscribe((event) => this.onSandboxFailure(event));
    }

    start(request: RuntimeStartRequest): Promise<void> {
        if (!hasControlBinding(request)) return this.inner.start(request);
        return this.execute("START", request, (managed) => this.inner.start(managed));
    }

    resume(request: RuntimeResumeRequest): Promise<void> {
        if (!hasControlBinding(request)) return this.inner.resume(request);
        return this.execute("RESUME", request, (managed) => this.inner.resume(managed));
    }

    interrupt(runId: string): Promise<void> {
        return this.inner.interrupt(runId);
    }

    subscribe(runId: string, handler: RuntimeEventHandler): () => void {
        let handlers = this.handlers.get(runId);
        if (handlers === undefined) {
            handlers = new Set();
            this.handlers.set(runId, handlers);
        }
        handlers.add(handler);
        const unsubscribeInner = this.inner.subscribe(runId, handler);
        return () => {
            unsubscribeInner();
            handlers?.delete(handler);
            if (handlers?.size === 0) this.handlers.delete(runId);
        };
    }

    private async execute<T extends RuntimeStartRequest | RuntimeResumeRequest>(
        kind: RunAttemptKind,
        request: T,
        invoke: (request: T) => Promise<void>,
    ): Promise<void> {
        const run = this.runs.get(request.run.runId);
        if (
            run === null
            || run.templateVersionId === undefined
            || run.harnessInstanceId === undefined
        ) throw new Error(`Run 缺少控制面绑定：${request.run.runId}`);

        const template = this.templates.getVersion(run.templateVersionId);
        const instance = this.instances.get(run.harnessInstanceId);
        const session = this.sessions.get(run.harnessSessionId);
        if (template === null || instance === null || session === null) {
            throw new Error(`Run 控制面引用不完整：${run.id}`);
        }
        if (
            instance.tenantId !== run.tenantId
            || instance.templateVersionId !== template.id
            || session.tenantId !== run.tenantId
            || session.instanceId !== instance.id
        ) throw new Error(`Run 控制面归属不一致：${run.id}`);

        const profile = this.capabilities.get(instance.capabilityProfileId);
        if (profile === null) {
            throw new Error(`找不到 RuntimeCapabilityProfile：${instance.capabilityProfileId}`);
        }

        const now = new Date().toISOString();
        const computedSnapshot = computeEffectivePolicy({
            id: crypto.randomUUID(),
            runId: run.id,
            tenantId: run.tenantId,
            templateVersionId: template.id,
            layers: this.policyLayers(run, template.spec),
            createdAt: now,
        });
        const snapshot = withSandboxProfile(computedSnapshot, this.sandboxProfile);
        this.policies.saveSnapshot(snapshot);

        // Attempt 从创建时就绑定不可变策略快照。这样即使能力校验、策略编译或
        // Sandbox 创建在真正启动 Runtime 前失败，拒绝记录仍可完整解释。
        let attempt = createRunAttempt({
            id: crypto.randomUUID(),
            runId: run.id,
            attemptNumber: this.attempts.nextAttemptNumber(run.id),
            kind,
            instanceId: instance.id,
            templateVersionId: template.id,
            capabilityProfileId: profile.id,
            policySnapshotId: snapshot.id,
            sandboxId: null,
            createdAt: now,
        });
        this.attempts.create(attempt);

        const validation = validateRuntimeCapabilities(profile, {
            required: template.spec.requiredCapabilities ?? [],
            optional: template.spec.optionalCapabilities ?? [],
        });
        if (!validation.accepted) {
            const reason = `Runtime 缺少强制能力：${validation.missingRequired.join(",")}`;
            this.saveCompilation(snapshot.id, "REJECTED", null, [reason], now);
            const rejected = finishRunAttempt(attempt, "REJECTED", now, reason);
            this.attempts.update(rejected, attempt.status);
            throw new Error(reason);
        }

        let compiled;
        try {
            compiled = compilePiPolicy(template.spec, snapshot);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.saveCompilation(snapshot.id, "REJECTED", null, [reason], now);
            const rejected = finishRunAttempt(attempt, "REJECTED", now, reason);
            this.attempts.update(rejected, attempt.status);
            throw error;
        }
        const degradations = validation.missingOptional.map(
            (item) => `缺少非关键能力：${item}`,
        );
        this.saveCompilation(
            snapshot.id,
            degradations.length === 0 ? "APPLIED" : "DEGRADED",
            compiled,
            degradations,
            now,
        );

        const sandboxId = crypto.randomUUID();
        let handle;
        try {
            handle = await this.sandbox.create({
                id: sandboxId,
                runId: run.id,
                instanceId: instance.id,
                workspacePath: run.workspacePath,
                policy: snapshot,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const failed = finishRunAttempt(attempt, "FAILED", new Date().toISOString(), reason);
            this.attempts.update(failed, attempt.status);
            throw error;
        }

        attempt = startRunAttempt(attempt, new Date().toISOString(), snapshot.id, handle.id);
        this.attempts.update(attempt, "PENDING");
        const activeInstance = transitionHarnessInstance(
            instance,
            "ACTIVE",
            new Date().toISOString(),
        );
        this.instances.update(activeInstance, instance.actualState);
        this.activeBySandboxId.set(handle.id, {
            attemptId: attempt.id,
            instanceId: instance.id,
        });

        let terminal: "SUCCEEDED" | "FAILED" | "INTERRUPTED" | null = null;
        let terminalReason: string | null = null;
        const unsubscribe = this.inner.subscribe(run.id, (event) => {
            if (event.type === "agent_started" || event.type === "agent_resumed") {
                const current = this.sessions.get(run.harnessSessionId);
                if (current !== null) {
                    this.sessions.update(bindRuntimeSession(
                        current,
                        event.runtimeSessionRef,
                        event.timestamp,
                    ));
                }
            } else if (event.type === "agent_completed") {
                terminal = "SUCCEEDED";
            } else if (event.type === "agent_failed") {
                terminal = "FAILED";
                terminalReason = event.message;
            } else if (event.type === "agent_interrupted") {
                terminal = "INTERRUPTED";
            }
        });

        const managedRequest = {
            ...request,
            execution: {
                attemptId: attempt.id,
                policySnapshotId: snapshot.id,
                sandboxId: handle.id,
                runtimeConfig: compiled,
            },
        } as T;

        try {
            await invoke(managedRequest);
            const current = this.attempts.get(attempt.id);
            if (current?.status === "RUNNING") {
                const status = (terminal as
                    | "SUCCEEDED"
                    | "FAILED"
                    | "INTERRUPTED"
                    | null) ?? "SUCCEEDED";
                const finished = finishRunAttempt(
                    current,
                    status,
                    new Date().toISOString(),
                    status === "FAILED" ? (terminalReason ?? "Runtime 执行失败") : null,
                );
                this.attempts.update(finished, current.status);
            }
        } catch (error) {
            const current = this.attempts.get(attempt.id);
            if (current?.status === "RUNNING") {
                const reason = error instanceof Error ? error.message : String(error);
                const failed = finishRunAttempt(current, "FAILED", new Date().toISOString(), reason);
                this.attempts.update(failed, current.status);
            }
            throw error;
        } finally {
            unsubscribe();
            this.activeBySandboxId.delete(handle.id);
            await this.sandbox.terminate(handle.id);
            const currentInstance = this.instances.get(instance.id);
            if (currentInstance?.actualState === "ACTIVE") {
                const ready = transitionHarnessInstance(
                    currentInstance,
                    "READY",
                    new Date().toISOString(),
                );
                this.instances.update(ready, currentInstance.actualState);
            }
        }
    }

    private policyLayers(
        run: NonNullable<ReturnType<RunStore["get"]>>,
        spec: NonNullable<ReturnType<HarnessTemplateStore["getVersion"]>>["spec"],
    ) {
        const limits = unrestrictedPolicy.resourceLimits;
        const templatePolicy: PolicyConstraints = {
            ...unrestrictedPolicy,
            allowedTools: spec.tools,
            allowedSkills: spec.skills ?? [],
            allowedModels: [`${spec.provider}/${spec.modelId}`],
        };
        const workspacePolicy: PolicyConstraints = {
            ...unrestrictedPolicy,
            workspaceRoots: [run.workspacePath],
        };
        const platform = this.policyRegistry.getPlatformPolicy();
        const platformForSandbox = this.sandboxProfile === "development"
            ? platform
            : createPolicyLayer(platform.id, platform.kind, {
                ...platform,
                allowNetwork: false,
            });
        return [
            platformForSandbox,
            this.policyRegistry.getTenantPolicy(run.tenantId),
            createPolicyLayer(`template:${run.templateVersionId}`, "TEMPLATE", templatePolicy),
            createPolicyLayer(`workspace:${run.workspacePath}`, "WORKSPACE", workspacePolicy),
            createPolicyLayer(`run:${run.id}`, "RUN", run.runPolicy ?? {
                ...unrestrictedPolicy,
                resourceLimits: limits,
            }),
        ];
    }

    private saveCompilation(
        snapshotId: string,
        status: PolicyCompilationRecord["status"],
        compiled: PolicyCompilationRecord["compiled"],
        reasons: readonly string[],
        createdAt: string,
    ): void {
        this.policies.saveCompilation({
            id: crypto.randomUUID(),
            snapshotId,
            runtimeKind: "PI",
            status,
            compiled,
            reasons,
            createdAt,
        });
    }

    private onSandboxFailure(event: SandboxLifecycleEvent): void {
        const active = this.activeBySandboxId.get(event.sandboxId);
        if (active === undefined) return;
        const instance = this.instances.get(active.instanceId);
        if (instance?.actualState === "ACTIVE") {
            const failed = transitionHarnessInstance(
                instance,
                "FAILED",
                event.timestamp,
                `SANDBOX_${event.status}:${event.reason}`,
            );
            this.instances.update(failed, instance.actualState);
        }
        const attempt = this.attempts.get(active.attemptId);
        if (attempt?.status === "RUNNING") {
            const interrupted = finishRunAttempt(
                attempt,
                "INTERRUPTED",
                event.timestamp,
            );
            this.attempts.update(interrupted, attempt.status);
        }
        this.emit({
            type: "agent_interrupted",
            runId: event.runId,
            timestamp: event.timestamp,
        });
        void this.inner.interrupt(event.runId).catch(() => undefined);
    }

    private emit(event: RuntimeEvent): void {
        for (const handler of this.handlers.get(event.runId) ?? []) {
            handler(event);
        }
    }
}

function hasControlBinding(
    request: RuntimeStartRequest | RuntimeResumeRequest,
): boolean {
    return request.run.templateVersionId !== undefined
        || request.run.harnessInstanceId !== undefined;
}
