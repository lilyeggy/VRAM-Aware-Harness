import { describe, expect, test } from "bun:test";

import {
    createHarnessApplication,
} from "../../src/app/create-harness-application.ts";
import {
    loadHarnessConfig,
} from "../../src/app/harness-config.ts";
import {
    RecoveryExecutor,
} from "../../src/checkpoints/recovery-executor.ts";
import type {
    RunRecoveryPlan,
} from "../../src/checkpoints/recovery-service.ts";
import type {
    AgentRun,
} from "../../src/runs/agent-run.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import {
    FakeAgentRuntime,
} from "../fakes/fake-agent-runtime.ts";
import {
    FakeResourceObserver,
} from "../fakes/fake-resource-observer.ts";
import type {
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";
import type {
    ToolExecution,
} from "../../src/tools/tool-execution.ts";

function createExecution(
    id: string,
    effect: ToolExecution["effect"],
    status: ToolExecution["status"] = "PREPARED",
): ToolExecution {
    return {
        id,
        runId: "run-1",
        toolCallId: `call-${id}`,
        toolName: effect === "READ_ONLY" ? "read" : "bash",
        arguments: { command: "rm -rf /tmp/important" },
        effect,
        status,
        result: null,
        errorMessage: null,
        createdAt: "2026-09-08T10:00:00.000Z",
        finishedAt: null,
    };
}

function createRun(runId: string, checkpointId: string | null): AgentRun {
    const timestamp = "2026-09-08T10:00:00.000Z";
    return {
        id: runId,
        tenantId: "tenant-pillar3",
        harnessSessionId: "session-pillar3",
        status: "INTERRUPTED",
        userInput: "测试恢复",
        workspacePath: "/tmp/pillar3-ws",
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        finishedAt: null,
        checkpointId,
        failureReason: null,
    };
}

describe("支柱 3：副作用感知恢复防线（fail closed）", () => {
    test("plan 声称 AUTO_RESUME 但存在 UNKNOWN_EFFECT：重校验拦截为 MANUAL_REVIEW", async () => {
        const submitResumeCalls: string[] = [];
        const audited: { runId: string; reason: string }[] = [];
        const executor = new RecoveryExecutor(
            {
                submitResume: (input) => {
                    submitResumeCalls.push(input.runId);
                    throw new Error("不应触发自动重放");
                },
            },
            (plan, decision) => {
                audited.push({
                    runId: plan.run.id,
                    reason: decision.reason,
                });
            },
        );

        const run = createRun("run-unknown-effect", "ckpt-1");
        const plan: RunRecoveryPlan = {
            run,
            checkpoint: {
                id: "ckpt-1",
                runId: run.id,
                toolExecutionId: "tool-ckpt-1",
                runtimeSessionRef: "session-ref",
                lastEventSequence: 3,
                createdAt: "2026-09-08T10:00:01.000Z",
            },
            // 攻击面：计划里的 decision 被错误标成 AUTO_RESUME。
            preparedExecutions: [
                createExecution("exec-read", "READ_ONLY"),
                createExecution("exec-bash", "UNKNOWN_EFFECT"),
            ],
            decision: {
                action: "AUTO_RESUME",
                reason: "SAFE_CHECKPOINT",
                blockingToolExecutionId: null,
            },
        };

        const results = await executor.execute([plan]);

        // 决不自动重放：未证明幂等/未知副作用坚决转人工。
        expect(results).toHaveLength(1);
        expect(results[0]!.status).toBe("MANUAL_REVIEW");
        expect(submitResumeCalls).toEqual([]);
        expect(audited).toEqual([
            { runId: "run-unknown-effect", reason: "UNSAFE_TOOL_EFFECT" },
        ]);
    });

    test("未证明幂等的写入（IDEMPOTENT_WRITE PREPARED）同样拦截", async () => {
        const executor = new RecoveryExecutor({
            submitResume: () => {
                throw new Error("不应触发自动重放");
            },
        });
        const plan: RunRecoveryPlan = {
            run: createRun("run-idempotent", "ckpt-1"),
            checkpoint: {
                id: "ckpt-1",
                runId: "run-idempotent",
                toolExecutionId: "tool-ckpt-1",
                runtimeSessionRef: "session-ref",
                lastEventSequence: 3,
                createdAt: "2026-09-08T10:00:01.000Z",
            },
            preparedExecutions: [
                createExecution("exec-write", "IDEMPOTENT_WRITE"),
            ],
            decision: {
                action: "AUTO_RESUME",
                reason: "SAFE_CHECKPOINT",
                blockingToolExecutionId: null,
            },
        };

        const results = await executor.execute([plan]);
        expect(results[0]!.status).toBe("MANUAL_REVIEW");
    });

    test("全部 READ_ONLY 且 checkpoint 有效：正常 AUTO_RESUME 入队", async () => {
        const submitResumeCalls: string[] = [];
        const executor = new RecoveryExecutor({
            submitResume: (input) => {
                submitResumeCalls.push(input.runId);
                return createRun(input.runId, input.checkpoint.id);
            },
        });
        const plan: RunRecoveryPlan = {
            run: createRun("run-safe", "ckpt-1"),
            checkpoint: {
                id: "ckpt-1",
                runId: "run-safe",
                toolExecutionId: "tool-ckpt-1",
                runtimeSessionRef: "session-ref",
                lastEventSequence: 3,
                createdAt: "2026-09-08T10:00:01.000Z",
            },
            preparedExecutions: [
                createExecution("exec-read-1", "READ_ONLY"),
                createExecution("exec-read-2", "READ_ONLY"),
            ],
            decision: {
                action: "AUTO_RESUME",
                reason: "SAFE_CHECKPOINT",
                blockingToolExecutionId: null,
            },
        };

        const results = await executor.execute([plan]);
        expect(results[0]!.status).toBe("QUEUED");
        expect(submitResumeCalls).toEqual(["run-safe"]);
    });
});

test("支柱 3 集成：组合根把 MANUAL_REVIEW 审计写进 Run 事件时间线", async () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "fake-model",
        HARNESS_DATABASE_PATH: ":memory:",
        HARNESS_PUMP_INTERVAL_MS: "60000",
    }, "/tmp/harness-project");

    const normalSnapshot: ResourceSnapshot = {
        snapshotId: "pillar3-snapshot",
        observedAt: "2026-09-08T10:00:00.000Z",
        sources: ["FAKE"],
        gpuTotalMemoryMiB: 100,
        gpuUsedMemoryMiB: 20,
        gpuFreeMemoryMiB: 80,
        gpuUtilizationPercent: 20,
        runningRequests: 0,
        waitingRequests: 0,
        kvCacheUsagePercent: 20,
        inputTokensPerSecond: 1_000,
        outputTokensPerSecond: 100,
    };

    const composition = await createHarnessApplication(config, {
        runtime: new FakeAgentRuntime(),
        resourceObserver: new FakeResourceObserver({
            ok: true,
            snapshot: normalSnapshot,
        }),
    });

    try {
        const runStore = composition.runStore;
        runStore.create(
            { ...createRun("run-audit", "ckpt-audit"), status: "INTERRUPTED" },
            {
                eventId: crypto.randomUUID(),
                runId: "run-audit",
                sequence: 1,
                type: "RUN_CREATED",
                timestamp: "2026-09-08T10:00:00.000Z",
                payloadVersion: 1,
                payload: {},
            },
        );

        // 与组合根相同的审计路径：MANUAL_REVIEW 决策落事件时间线。
        const plan: RunRecoveryPlan = {
            run: createRun("run-audit", "ckpt-audit"),
            checkpoint: null,
            preparedExecutions: [
                createExecution("exec-bash-audit", "UNKNOWN_EFFECT"),
            ],
            decision: {
                action: "MANUAL_REVIEW",
                reason: "UNSAFE_TOOL_EFFECT",
                blockingToolExecutionId: "exec-bash-audit",
            },
        };

        const results = await composition.recoveryExecutor.execute([plan]);
        expect(results[0]!.status).toBe("MANUAL_REVIEW");

        const auditEvent = runStore
            .listEvents("run-audit")
            .find((event) => {
                const payload = event.payload as { reason?: string };
                return payload?.reason === "MANUAL_REVIEW_REQUIRED";
            });
        expect(auditEvent).toBeDefined();
        expect(
            (auditEvent!.payload as {
                recoveryReason: string;
                blockingToolExecutionId: string | null;
            }).recoveryReason,
        ).toBe("UNSAFE_TOOL_EFFECT");
        expect(
            (auditEvent!.payload as { blockingToolExecutionId: string | null })
                .blockingToolExecutionId,
        ).toBe("exec-bash-audit");
    } finally {
        await composition.close();
    }
});
