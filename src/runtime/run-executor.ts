import {
    createRunAttempt,
    finishRunAttempt,
    startRunAttempt,
    type RunAttemptKind,
} from "../runs/run-attempt.ts";
import type { RunAttemptStore } from "../runs/run-attempt-store.ts";
import type { RunStore } from "../runs/runstore.ts";
import {
    bindRuntimeSession,
    createHarnessSession,
} from "../sessions/harness-session.ts";
import type { HarnessSessionStore } from "../sessions/harness-session-store.ts";
import {
    computeEffectivePolicy,
    createPolicyLayer,
    unrestrictedPolicy,
    withSandboxProfile,
} from "../policies/effective-policy.ts";
import type { EffectivePolicyStore } from "../policies/effective-policy-store.ts";
import type { PolicyRegistry } from "../policies/policy-registry.ts";
import type {
    SandboxLifecycleEvent,
    SandboxProvider,
} from "../sandbox/sandbox-provider.ts";
import type { SandboxProfile } from "../sandbox/sandbox-profile.ts";
import type {
    AgentRuntime,
    RuntimeEvent,
    RuntimeEventHandler,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "./agent-runtime.ts";

export interface RunExecutorRuntimeConfig {
    readonly provider: string;
    readonly modelId: string;
    readonly tools: readonly string[];
    readonly skills?: readonly string[];
}

interface ActiveExecution {
    readonly attemptId: string;
}

/**
 * Run 执行器：把 Attempt、Policy、Sandbox、Runtime 串起来。
 *
 * 它不再依赖 Template / Instance / CapabilityProfile 这些旧控制面对象；
 * 运行时配置来自组合根注入的 RunExecutorRuntimeConfig。
 */
export class RunExecutor implements AgentRuntime {
    private readonly handlers = new Map<string, Set<RuntimeEventHandler>>();
    private readonly activeBySandboxId = new Map<string, ActiveExecution>();

    constructor(
        private readonly inner: AgentRuntime,
        private readonly runs: RunStore,
        private readonly sessions: HarnessSessionStore,
        private readonly attempts: RunAttemptStore,
        private readonly policies: EffectivePolicyStore,
        private readonly policyRegistry: PolicyRegistry,
        private readonly sandbox: SandboxProvider,
        private readonly config: RunExecutorRuntimeConfig,
        private readonly sandboxProfile: SandboxProfile = "development",
    ) {
        this.sandbox.subscribe((event) => this.onSandboxFailure(event));
    }

    start(request: RuntimeStartRequest): Promise<void> {
        return this.execute("START", request, (managed) => this.inner.start(managed));
    }

    resume(request: RuntimeResumeRequest): Promise<void> {
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
            if (handlers?.size === 0) {
                this.handlers.delete(runId);
            }
        };
    }

    private async execute<T extends RuntimeStartRequest | RuntimeResumeRequest>(
        kind: RunAttemptKind,
        request: T,
        invoke: (request: T) => Promise<void>,
    ): Promise<void> {
        const startedAt = performance.now();
        const run = this.runs.get(request.run.runId);
        if (run === null) {
            throw new Error(`找不到 AgentRun：${request.run.runId}`);
        }

        const session = this.ensureSession(run.tenantId, run.harnessSessionId);
        const now = new Date().toISOString();
        const snapshot = withSandboxProfile(
            computeEffectivePolicy({
                id: crypto.randomUUID(),
                runId: run.id,
                tenantId: run.tenantId,
                templateVersionId: "runtime:default",
                layers: this.policyLayers(run),
                createdAt: now,
            }),
            this.sandboxProfile,
        );
        this.policies.saveSnapshot(snapshot);

        let attempt = createRunAttempt({
            id: crypto.randomUUID(),
            runId: run.id,
            attemptNumber: this.attempts.nextAttemptNumber(run.id),
            kind,
            policySnapshotId: snapshot.id,
            sandboxId: null,
            createdAt: now,
        });
        this.attempts.create(attempt);

        this.emit({
            type: "control_prepared",
            runId: run.id,
            timestamp: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startedAt),
        });

        const sandboxStartedAt = performance.now();
        let handle;
        try {
            handle = await this.sandbox.create({
                id: crypto.randomUUID(),
                runId: run.id,
                    workspacePath: run.workspacePath,
                policy: snapshot,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const failed = finishRunAttempt(
                attempt,
                "FAILED",
                new Date().toISOString(),
                reason,
            );
            this.attempts.update(failed, attempt.status);
            throw error;
        }

        this.emit({
            type: "sandbox_acquired",
            sandboxId: handle.id,
            attemptId: attempt.id,
            runId: run.id,
            timestamp: new Date().toISOString(),
            durationMs: Math.round(performance.now() - sandboxStartedAt),
            warmHit: handle.acquisition?.warmHit ?? false,
            runtime: snapshot.sandboxProfile ?? this.sandboxProfile,
        });

        attempt = startRunAttempt(attempt, new Date().toISOString(), snapshot.id, handle.id);
        this.attempts.update(attempt, "PENDING");
        this.activeBySandboxId.set(handle.id, { attemptId: attempt.id });

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
            run: {
                ...request.run,
                ...(kind === "START"
                    ? { runtimeSessionRef: session.runtimeSessionRef }
                    : {}),
            },
            execution: {
                attemptId: attempt.id,
                policySnapshotId: snapshot.id,
                sandboxId: handle.id,
                sandboxEnforcement: handle.enforcement,
                sandboxMountRoot: handle.mountRoot,
                sandboxWorkdir: handle.containerWorkdir,
                runtimeConfig: {
                    runtimeKind: "PI" as const,
                    provider: this.config.provider,
                    modelId: this.config.modelId,
                    tools: this.config.tools,
                    skills: this.config.skills ?? [],
                    thinkingLevel: request.run.thinkingLevel ?? "off",
                },
            },
        } as T;

        try {
            await invoke(managedRequest);
            const current = this.attempts.get(attempt.id);
            if (current?.status === "RUNNING") {
                const status = (terminal ?? "SUCCEEDED") as
                    | "SUCCEEDED" | "FAILED" | "INTERRUPTED";
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
        }
    }

    private ensureSession(tenantId: string, sessionId: string) {
        const existing = this.sessions.get(sessionId);
        if (existing !== null) {
            if (existing.tenantId !== tenantId) {
                throw new Error(`HarnessSession 归属不匹配：${sessionId}`);
            }
            return existing;
        }
        const created = createHarnessSession({
            id: sessionId,
            tenantId,
            createdAt: new Date().toISOString(),
        });
        this.sessions.create(created);
        return created;
    }

    private policyLayers(run: NonNullable<ReturnType<RunStore["get"]>>) {
        const templatePolicy = {
            ...unrestrictedPolicy,
            allowedTools: this.config.tools,
            allowedSkills: this.config.skills ?? [],
            allowedModels: [`${this.config.provider}/${this.config.modelId}`],
        };
        const workspacePolicy = {
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
            createPolicyLayer("template:default", "TEMPLATE", templatePolicy),
            createPolicyLayer(`workspace:${run.workspacePath}`, "WORKSPACE", workspacePolicy),
            createPolicyLayer(`run:${run.id}`, "RUN", run.runPolicy ?? unrestrictedPolicy),
        ];
    }

    private onSandboxFailure(event: SandboxLifecycleEvent): void {
        const active = this.activeBySandboxId.get(event.sandboxId);
        if (active === undefined) {
            return;
        }

        const attempt = this.attempts.get(active.attemptId);
        if (attempt?.status === "RUNNING") {
            const interrupted = finishRunAttempt(attempt, "INTERRUPTED", event.timestamp);
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
