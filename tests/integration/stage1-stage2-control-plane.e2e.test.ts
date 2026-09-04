import { expect, test } from "bun:test";

import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import {
    unrestrictedPolicy,
    type PolicyConstraints,
} from "../../src/policies/effective-policy.ts";
import { PolicyRegistry } from "../../src/policies/policy-registry.ts";
import { createRuntimeCapabilityProfile } from "../../src/runtime/runtime-capability.ts";
import type { ResourceSnapshot } from "../../src/resources/resource-observer.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import { FakeResourceObserver } from "../fakes/fake-resource-observer.ts";
import type {
    AgentRuntime,
    RuntimeEvent,
    RuntimeEventHandler,
    RuntimeStartRequest,
    RuntimeResumeRequest,
} from "../../src/runtime/agent-runtime.ts";
import { ManagedLocalSandboxProvider } from "../../src/sandbox/managed-local-sandbox.ts";

class BlockingRuntime implements AgentRuntime {
    private readonly handlers = new Map<string, Set<RuntimeEventHandler>>();
    private resolveCurrent: (() => void) | null = null;

    subscribe(runId: string, handler: RuntimeEventHandler): () => void {
        let handlers = this.handlers.get(runId);
        if (handlers === undefined) {
            handlers = new Set();
            this.handlers.set(runId, handlers);
        }
        handlers.add(handler);
        return () => handlers?.delete(handler);
    }

    async start(request: RuntimeStartRequest): Promise<void> {
        this.emit({
            type: "agent_started",
            runId: request.run.runId,
            timestamp: new Date().toISOString(),
            runtimeSessionRef: `blocking-${request.run.runId}`,
        });
        await new Promise<void>((resolve) => {
            this.resolveCurrent = resolve;
        });
    }

    resume(_request: RuntimeResumeRequest): Promise<void> {
        throw new Error("测试不执行 resume");
    }

    async interrupt(runId: string): Promise<void> {
        this.emit({
            type: "agent_interrupted",
            runId,
            timestamp: new Date().toISOString(),
        });
        this.resolveCurrent?.();
        this.resolveCurrent = null;
    }

    private emit(event: RuntimeEvent): void {
        for (const handler of this.handlers.get(event.runId) ?? []) {
            handler(event);
        }
    }
}

const normalSnapshot: ResourceSnapshot = {
    snapshotId: "stage2-normal",
    observedAt: "2026-08-10T10:00:00.000Z",
    sources: ["FAKE"],
    gpuTotalMemoryMiB: 100,
    gpuUsedMemoryMiB: 10,
    gpuFreeMemoryMiB: 90,
    gpuUtilizationPercent: 10,
    runningRequests: 0,
    waitingRequests: 0,
    kvCacheUsagePercent: 10,
    inputTokensPerSecond: 100,
    outputTokensPerSecond: 50,
};

const criticalSnapshot: ResourceSnapshot = {
    ...normalSnapshot,
    snapshotId: "stage1-critical",
    gpuUsedMemoryMiB: 95,
    gpuFreeMemoryMiB: 5,
    gpuUtilizationPercent: 95,
    kvCacheUsagePercent: 95,
};

function policy(
    allowedTools: readonly string[],
    overrides: Partial<PolicyConstraints> = {},
): PolicyConstraints {
    return {
        ...unrestrictedPolicy,
        allowedTools,
        ...overrides,
    };
}

function config() {
    return loadHarnessConfig({
        VLLM_MODEL_ID: "fake-model",
        PI_PROVIDER: "fake-provider",
        PI_TOOLS: "read,write,bash",
        HARNESS_DATABASE_PATH: ":memory:",
        HARNESS_PUMP_INTERVAL_MS: "60000",
        HARNESS_MAX_ACTIVE_RUNS: "2",
        HARNESS_MAX_ACTIVE_RUNS_PER_TENANT: "1",
    });
}

test("Stage 1/2：新 Run 贯穿控制面对象并按 Tenant 编译不同 Pi 权限", async () => {
    const baseRuntime = new FakeAgentRuntime();
    const registry = new PolicyRegistry();
    registry.setTenantPolicy("tenant-a", "tenant-a-readonly", policy(["read"], {
        allowNetwork: false,
        allowProcess: false,
    }));
    registry.setTenantPolicy("tenant-b", "tenant-b-editor", policy([
        "read",
        "write",
    ], {
        allowNetwork: false,
        allowProcess: false,
    }));
    const composition = await createHarnessApplication(config(), {
        runtime: baseRuntime,
        policyRegistry: registry,
        resourceObserver: new FakeResourceObserver({
            ok: true,
            snapshot: normalSnapshot,
        }),
        onPumpError() {},
    });

    try {
        await composition.application.start();
        const runA = composition.application.submitRun({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "只读检查",
            workspacePath: "/tmp/tenant-a-workspace",
        });
        const runB = composition.application.submitRun({
            tenantId: "tenant-b",
            harnessSessionId: "session-b",
            userInput: "编辑文件",
            workspacePath: "/tmp/tenant-b-workspace",
        });
        await composition.queuePump.tick();

        for (const run of [runA, runB]) {
            const persisted = composition.runStore.get(run.id);
            expect(persisted?.status).toBe("COMPLETED");
            expect(persisted?.templateVersionId).toBeDefined();
            expect(persisted?.harnessInstanceId).toBeDefined();
            expect(composition.sessionStore.get(run.harnessSessionId)?.runtimeSessionRef)
                .toBe(`fake-session-${run.id}`);

            const attempts = composition.attemptStore.listForRun(run.id);
            expect(attempts).toHaveLength(1);
            expect(attempts[0]?.status).toBe("SUCCEEDED");
            expect(attempts[0]?.policySnapshotId).toBeDefined();
            expect(attempts[0]?.sandboxId).toBeDefined();
            expect(composition.sandboxStore.get(attempts[0]!.sandboxId!)?.status)
                .toBe("TERMINATED");
        }

        const requestA = baseRuntime.startRequests.find(
            (request) => request.run.runId === runA.id,
        );
        const requestB = baseRuntime.startRequests.find(
            (request) => request.run.runId === runB.id,
        );
        expect(requestA?.execution?.runtimeConfig.tools).toEqual(["read"]);
        expect(requestA?.execution?.sandboxEnforcement).toMatchObject({
            toolExecutionBoundary: "HOST",
            filesystemIsolation: false,
            processIsolation: false,
            networkPolicyEnforced: false,
        });
        expect(requestB?.execution?.runtimeConfig.tools).toEqual([
            "read",
            "write",
        ]);

        const snapshotA = composition.effectivePolicyStore
            .listSnapshotsForRun(runA.id)[0]!;
        expect(snapshotA.layers.map((layer) => layer.kind)).toEqual([
            "PLATFORM",
            "TENANT",
            "TEMPLATE",
            "WORKSPACE",
            "RUN",
        ]);
        expect(composition.effectivePolicyStore
            .listCompilations(snapshotA.id)[0]?.status).toBe("APPLIED");

        let sideEffectCount = 0;
        const allowedResult = await composition.toolGateway.execute({
            runId: runA.id,
            toolCallId: "allowed-read",
            toolName: "read",
            arguments: { path: "README.md" },
            effect: "READ_ONLY",
            runtimeSessionRef: `fake-session-${runA.id}`,
            lastEventSequence: composition.runStore.getLastEventSequence(runA.id),
            policySnapshotId: snapshotA.id,
            workspacePath: "/tmp/tenant-a-workspace",
        }, async () => "safe-read-result");
        expect(allowedResult).toBe("safe-read-result");

        await expect(composition.toolGateway.execute({
            runId: runA.id,
            toolCallId: "denied-write",
            toolName: "write",
            arguments: { path: "README.md", content: "unsafe" },
            effect: "UNKNOWN_EFFECT",
            runtimeSessionRef: `fake-session-${runA.id}`,
            lastEventSequence: composition.runStore.getLastEventSequence(runA.id),
            policySnapshotId: snapshotA.id,
            workspacePath: "/tmp/tenant-a-workspace",
        }, async () => {
            sideEffectCount += 1;
            return "should-not-run";
        })).rejects.toThrow("策略不允许工具：write");
        expect(sideEffectCount).toBe(0);
        expect(composition.toolExecutionStore.getByToolCall(
            runA.id,
            "denied-write",
        )).toBeNull();
        expect(composition.effectivePolicyStore.listToolDecisions(runA.id).at(-1))
            .toMatchObject({ action: "DENY", toolName: "write" });
        expect(composition.effectivePolicyStore.listToolDecisions(runA.id)[0])
            .toMatchObject({ action: "ALLOW", toolName: "read" });
    } finally {
        await composition.close();
    }
});

test("Stage 1：排队后发布新模板版本不会改变 Run 已固定的版本证据", async () => {
    const baseRuntime = new FakeAgentRuntime();
    const observer = new FakeResourceObserver({
        ok: true,
        snapshot: criticalSnapshot,
    });
    const composition = await createHarnessApplication(config(), {
        runtime: baseRuntime,
        resourceObserver: observer,
    });

    try {
        await composition.application.start();
        const run = composition.application.submitRun({
            tenantId: "tenant-version-pin",
            harnessSessionId: "session-version-pin",
            userInput: "固定模板版本",
            workspacePath: "/tmp/version-pin-workspace",
        });
        await composition.queuePump.tick();
        expect(composition.runStore.get(run.id)?.status).toBe("QUEUED");

        const pinned = composition.templateStore.getVersion(run.templateVersionId!)!;
        composition.templateStore.publishVersion(pinned.templateId, {
            ...pinned,
            id: "new-template-version",
            version: 2,
            spec: {
                ...pinned.spec,
                modelId: "future-model",
            },
            createdAt: "2026-08-10T11:00:00.000Z",
        });

        observer.setObservation({ ok: true, snapshot: normalSnapshot });
        await composition.queuePump.tick();

        expect(composition.runStore.get(run.id)?.status).toBe("COMPLETED");
        expect(baseRuntime.startRequests[0]?.run.templateVersionId)
            .toBe(pinned.id);
        expect(baseRuntime.startRequests[0]?.execution?.runtimeConfig.modelId)
            .toBe("fake-model");
    } finally {
        await composition.close();
    }
});

test("Stage 1：缺少强制能力时在调用 Runtime 和创建 Sandbox 前拒绝", async () => {
    const baseRuntime = new FakeAgentRuntime();
    const composition = await createHarnessApplication(config(), {
        runtime: baseRuntime,
        onPumpError() {},
        capabilityProfile: createRuntimeCapabilityProfile({
            id: "limited-pi",
            runtimeKind: "PI",
            deploymentKey: "fake-provider/fake-model",
            supported: ["SESSION_CREATE"],
            auditCompleteness: "PARTIAL",
            reportedAt: "2026-08-10T10:00:00.000Z",
        }),
        resourceObserver: new FakeResourceObserver({
            ok: true,
            snapshot: normalSnapshot,
        }),
    });

    try {
        await composition.application.start();
        const run = composition.application.submitRun({
            tenantId: "tenant-limited",
            harnessSessionId: "session-limited",
            userInput: "不能绕过能力门",
            workspacePath: "/tmp/limited-workspace",
        });
        await composition.queuePump.tick();

        expect(baseRuntime.startRequests).toHaveLength(0);
        expect(composition.runStore.get(run.id)?.status).toBe("INTERRUPTED");
        const attempt = composition.attemptStore.listForRun(run.id)[0]!;
        expect(attempt.status).toBe("REJECTED");
        expect(attempt.failureReason).toContain("Runtime 缺少强制能力");
        expect(attempt.sandboxId).toBeNull();
        const snapshot = composition.effectivePolicyStore
            .listSnapshotsForRun(run.id)[0]!;
        expect(attempt.policySnapshotId).toBe(snapshot.id);
        expect(composition.effectivePolicyStore
            .listCompilations(snapshot.id)[0]?.status).toBe("REJECTED");
    } finally {
        await composition.close();
    }
});

test("Stage 2：Sandbox 失联会中断 Run、Attempt 并把 Instance 标记为 FAILED", async () => {
    const composition = await createHarnessApplication(config(), {
        runtime: new BlockingRuntime(),
        resourceObserver: new FakeResourceObserver({
            ok: true,
            snapshot: normalSnapshot,
        }),
    });

    try {
        await composition.application.start();
        const run = composition.application.submitRun({
            tenantId: "tenant-sandbox-loss",
            harnessSessionId: "session-sandbox-loss",
            userInput: "等待 Sandbox 故障",
            workspacePath: "/tmp/sandbox-loss-workspace",
        });
        const tick = composition.queuePump.tick();

        let attempt = composition.attemptStore.listForRun(run.id)[0];
        for (let index = 0; attempt?.status !== "RUNNING" && index < 100; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            attempt = composition.attemptStore.listForRun(run.id)[0];
        }
        expect(attempt?.status).toBe("RUNNING");

        const provider = composition.sandboxProvider as ManagedLocalSandboxProvider;
        provider.lose(attempt!.sandboxId!, "FAULT_INJECTION");
        await tick;

        expect(composition.runStore.get(run.id)?.status).toBe("INTERRUPTED");
        expect(composition.attemptStore.get(attempt!.id)?.status).toBe("INTERRUPTED");
        expect(composition.instanceStore.get(run.harnessInstanceId!)?.actualState)
            .toBe("FAILED");
        expect(composition.sandboxStore.get(attempt!.sandboxId!)?.status)
            .toBe("LOST");
    } finally {
        await composition.close();
    }
});

test("连续对话：后续 Run 将已持久化的 Runtime Session 注入 Adapter", async () => {
    const baseRuntime = new FakeAgentRuntime();
    const composition = await createHarnessApplication(config(), {
        runtime: baseRuntime,
        resourceObserver: new FakeResourceObserver({
            ok: true,
            snapshot: normalSnapshot,
        }),
    });

    try {
        await composition.application.start();
        const first = composition.application.submitRun({
            tenantId: "tenant-conversation",
            harnessSessionId: "conversation-1",
            userInput: "先分析项目",
            workspacePath: "/tmp/conversation-workspace",
        });
        await composition.queuePump.tick();

        const second = composition.application.submitRun({
            tenantId: "tenant-conversation",
            harnessSessionId: "conversation-1",
            userInput: "继续修复刚才的问题",
            workspacePath: "/tmp/conversation-workspace",
        });
        await composition.queuePump.tick();

        const firstRequest = baseRuntime.startRequests.find(
            (request) => request.run.runId === first.id,
        );
        const secondRequest = baseRuntime.startRequests.find(
            (request) => request.run.runId === second.id,
        );
        expect(firstRequest?.run.runtimeSessionRef).toBeNull();
        expect(secondRequest?.run.runtimeSessionRef)
            .toBe(`fake-session-${first.id}`);
    } finally {
        await composition.close();
    }
});
