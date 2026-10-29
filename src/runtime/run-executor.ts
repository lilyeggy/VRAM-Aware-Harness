import { LazySandboxLease } from "../sandbox/lazy-sandbox-lease.ts";
import type { SandboxHandle } from "../sandbox/sandbox-provider.ts";
import {
    createRunAttempt,
    finishRunAttempt,
    startRunAttempt,
    type RunAttemptKind,
} from "../runs/run-attempt.ts";
import type { RunAttemptStore } from "../runs/run-attempt-store.ts";
import type { RunLeaseManager } from "../runs/run-lease-manager.ts";
import type { RunStore } from "../runs/runstore.ts";
import { bindRuntimeSession } from "../sessions/harness-session.ts";
import type { HarnessSessionStore } from "../sessions/harness-session-store.ts";
import {
    assertNetworkRequestAllowed,
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
        private readonly leaseManager?: RunLeaseManager,
        private readonly sandboxAcquirers?: Map<string, () => Promise<SandboxHandle>>,
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
        // Model completion is provisional until sandbox finalization has
        // delivered its files. Forward all other runtime events immediately.
        const unsubscribeInner = this.inner.subscribe(runId, (event) => {
            if (event.type !== "agent_completed") handler(event);
        });
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

        const session = this.ensureSession(run.userId, run.harnessSessionId, run.workspaceId);
        const now = new Date().toISOString();
        const snapshot = withSandboxProfile(
            computeEffectivePolicy({
                id: crypto.randomUUID(),
                runId: run.id,
                userId: run.userId,
                layers: this.policyLayers(run),
                createdAt: now,
            }),
            this.sandboxProfile,
        );
        // B2：请求级 allowNetwork=true 若被平台/用户交集拒绝，必须在创建 VM
        // 之前 fail-closed，不能静默降级为无网运行。
        assertNetworkRequestAllowed(run.runPolicy, snapshot);
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

        if (this.leaseManager !== undefined) {
            attempt = this.leaseManager.acquire(attempt);
        }

        this.emit({
            type: "control_prepared",
            runId: run.id,
            timestamp: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startedAt),
        });

        let handle: SandboxHandle | undefined;
        let terminal: "SUCCEEDED" | "FAILED" | "INTERRUPTED" | null = null;
        let terminalReason: string | null = null;
        const acquire = async () => {
            const sandboxStartedAt = performance.now();
            const created = await this.sandbox.create({
                id: crypto.randomUUID(), runId: run.id, workspacePath: run.workspacePath, policy: snapshot,
            });
            handle = created;
            this.activeBySandboxId.set(created.id, { attemptId: attempt.id });
            try {
                const current = this.attempts.get(attempt.id);
                if (current?.status !== "RUNNING") throw new Error("Sandbox 创建完成时 Attempt 已结束");
                this.attempts.update({ ...current, sandboxId: created.id }, "RUNNING");
            } catch (error) {
                // A successfully allocated sandbox must still be finalized if
                // recording its identity fails. Never hand it to the worker.
                markCommitStarted(created.id);
                await this.sandbox.terminate(created.id);
                this.activeBySandboxId.delete(created.id);
                throw error;
            }
            this.emit({ type: "sandbox_acquired", sandboxId: created.id, attemptId: attempt.id,
                runId: run.id, timestamp: new Date().toISOString(),
                durationMs: Math.round(performance.now() - sandboxStartedAt),
                warmHit: created.acquisition?.warmHit ?? false,
                runtime: snapshot.sandboxProfile ?? this.sandboxProfile });
            return created;
        };
        const markCommitStarted = (sandboxId: string) => {
            this.runs.appendEvent({ eventId: crypto.randomUUID(), runId: run.id,
                sequence: this.runs.getLastEventSequence(run.id) + 1,
                type: "WORKSPACE_COMMIT_STARTED", timestamp: new Date().toISOString(),
                payloadVersion: 1, payload: { attemptId: attempt.id, sandboxId, terminal } });
        };
        const lease = new LazySandboxLease(acquire, async (created) => {
            markCommitStarted(created.id);
            await this.sandbox.terminate(created.id);
        });
        attempt = startRunAttempt(attempt, new Date().toISOString(), snapshot.id, null);
        this.attempts.update(attempt, "PENDING");
        this.leaseManager?.startHeartbeat(attempt.id);
        if (this.sandboxAcquirers) this.sandboxAcquirers.set(run.id, () => lease.getOrCreate());
        else {
            try { handle = await lease.getOrCreate(); }
            catch (error) {
                const current = this.attempts.get(attempt.id);
                if (current?.status === "RUNNING") this.attempts.update(finishRunAttempt(current, "FAILED", new Date().toISOString(), error instanceof Error ? error.message : String(error)), "RUNNING");
                this.leaseManager?.release(attempt.id);
                throw error;
            }
        }

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
                ...(handle === undefined ? { lazySandbox: true } : {
                    sandboxId: handle.id, sandboxToken: handle.capabilityToken,
                    sandboxEnforcement: handle.enforcement, sandboxMountRoot: handle.mountRoot,
                    sandboxWorkdir: handle.containerWorkdir,
                }),
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
            // Finalization may fail (for example, an export or commit conflict).
            // Do not publish success or finish the attempt before it completes.
            await lease.close();
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
            if (terminal === "SUCCEEDED" && this.attempts.get(attempt.id)?.status === "SUCCEEDED") {
                this.emit({ type: "agent_completed", runId: run.id, timestamp: new Date().toISOString() });
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
            this.leaseManager?.release(attempt.id);
            this.sandboxAcquirers?.delete(run.id);
            try { await lease.close(); } finally {
                if (handle !== undefined) this.activeBySandboxId.delete(handle.id);
            }
        }
    }

    private ensureSession(userId: string, sessionId: string, workspaceId?: string) {
        if (workspaceId === undefined) {
            throw new Error(`Run 缺少可验证的 Workspace：${sessionId}`);
        }
        const existing = this.sessions.get(sessionId);
        if (existing !== null) {
            if (existing.userId !== userId) {
                throw new Error(`HarnessSession 归属不匹配：${sessionId}`);
            }
            if (existing.workspaceId !== workspaceId) {
                throw new Error(`HarnessSession Workspace 绑定不匹配：${sessionId}`);
            }
            return existing;
        }
        throw new Error(`受管 HarnessSession 不存在：${sessionId}`);
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
            this.policyRegistry.getUserPolicy(run.userId),
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
            this.leaseManager?.stopHeartbeat(attempt.id);
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
