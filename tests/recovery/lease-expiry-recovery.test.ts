import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createHarnessApplication,
    type HarnessComposition,
} from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import {
    acquireRunAttemptLease,
    createRunAttempt,
    startRunAttempt,
} from "../../src/runs/run-attempt.ts";
import type {
    RunEvent,
    RunEventType,
} from "../../src/runs/agent-run.ts";
import type { ToolExecution } from "../../src/tools/tool-execution.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

/**
 * §9.9 v1.5 Phase 5 F1：Worker 崩溃（租约过期）后的恢复接线。
 *
 * 这里验证组合根 create-harness-application.ts 的真实接线：
 * RunScheduler.tick -> RunLeaseManager.reapExpired -> RunService.markLeaseExpired
 * -> RecoveryService.planForInterruptedRun -> RecoveryExecutor.execute。
 * 无 Checkpoint 落 MANUAL_REVIEW 审计；有安全 Checkpoint 走 AUTO_RESUME。
 */

function createConfig() {
    return loadHarnessConfig({
        VLLM_MODEL_ID: "fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH: ":memory:",
        HARNESS_PUMP_INTERVAL_MS: "60000",
        HARNESS_SANDBOX_PROVIDER: "managed-local",
        HARNESS_WORKER_ISOLATION: "in-process",
        HARNESS_RUN_LEASE_TTL_MS: "60000",
        HARNESS_RUN_LEASE_HEARTBEAT_MS: "10000",
    });
}

function createEvent(
    runId: string,
    sequence: number,
    type: RunEventType,
    payload: unknown,
): RunEvent {
    return {
        eventId: crypto.randomUUID(),
        runId,
        sequence,
        type,
        timestamp: new Date().toISOString(),
        payloadVersion: 1,
        payload,
    };
}

async function createComposition(): Promise<{
    composition: HarnessComposition;
    runtime: FakeAgentRuntime;
}> {
    const runtime = new FakeAgentRuntime();
    const composition = await createHarnessApplication(createConfig(), {
        runtime,
    });
    return { composition, runtime };
}

function insertRunningRun(
    composition: HarnessComposition,
    runId: string,
): void {
    const timestamp = new Date().toISOString();
    const workspacePath = mkdtempSync(join(tmpdir(), "harness-lease-ws-"));
    composition.runStore.create(
        {
            id: runId,
            tenantId: "tenant-lease",
            harnessSessionId: `session-${runId}`,
            status: "RUNNING",
            userInput: "验证租约过期恢复",
            workspacePath,
            createdAt: timestamp,
            updatedAt: timestamp,
            startedAt: timestamp,
            finishedAt: null,
            checkpointId: null,
            failureReason: null,
        },
        createEvent(runId, 1, "RUN_STARTED", {}),
    );
}

/** 插入一个租约已经过期 60 秒的 RUNNING Attempt（模拟 worker 被 kill）。 */
function insertExpiredAttempt(
    composition: HarnessComposition,
    runId: string,
): void {
    const attempt = createRunAttempt({
        id: `attempt-${runId}`,
        runId,
        attemptNumber: 1,
        kind: "START",
        policySnapshotId: null,
        sandboxId: null,
        createdAt: new Date().toISOString(),
    });
    composition.attemptStore.create(attempt);
    const started = startRunAttempt(
        attempt,
        new Date().toISOString(),
        "policy-lease",
        "sandbox-lease",
    );
    composition.attemptStore.update(started, "PENDING");
    const expiredAt = new Date(Date.now() - 120_000).toISOString();
    const leased = acquireRunAttemptLease(
        started,
        "dead-worker",
        expiredAt,
        60_000,
    );
    composition.attemptStore.update(leased, "RUNNING");
}

function insertSafeCheckpoint(
    composition: HarnessComposition,
    runId: string,
): void {
    const timestamp = new Date().toISOString();
    const execution: ToolExecution = {
        id: `exec-${runId}`,
        runId,
        toolCallId: "call-read-1",
        toolName: "read",
        arguments: { path: "README.md" },
        effect: "READ_ONLY",
        status: "PREPARED",
        result: null,
        errorMessage: null,
        createdAt: timestamp,
        finishedAt: null,
    };
    composition.toolExecutionStore.prepare(execution);
    composition.toolExecutionStore.completeWithCheckpoint(
        {
            ...execution,
            status: "SUCCEEDED",
            result: { content: "ok" },
            finishedAt: timestamp,
        },
        {
            id: `checkpoint-${runId}`,
            runId,
            toolExecutionId: execution.id,
            runtimeSessionRef: `/tmp/${runId}.jsonl`,
            lastEventSequence: 1,
            createdAt: timestamp,
        },
    );
}

test("租约过期且无 Checkpoint：Run 落 INTERRUPTED 并写 MANUAL_REVIEW 审计", async () => {
    const { composition } = await createComposition();
    try {
        const runId = `run-lease-manual-${crypto.randomUUID()}`;
        insertRunningRun(composition, runId);
        insertExpiredAttempt(composition, runId);

        await composition.queuePump.tick();

        expect(composition.runStore.get(runId)?.status).toBe("INTERRUPTED");
        expect(composition.attemptStore.get(`attempt-${runId}`)?.status)
            .toBe("INTERRUPTED");
        expect(composition.attemptStore.get(`attempt-${runId}`)?.leaseOwner)
            .toBe(null);
        expect(composition.scheduler.listQueue()).toEqual([]);

        const events = composition.runStore.listEvents(runId);
        const last = events.at(-1);
        expect(last?.type).toBe("RUN_INTERRUPTED");
        expect(last?.payload).toMatchObject({
            reason: "MANUAL_REVIEW_REQUIRED",
            recoveryAction: "MANUAL_REVIEW",
            recoveryReason: "NO_CHECKPOINT",
        });
    } finally {
        await composition.close();
    }
});

test("租约过期且有安全 Checkpoint：AUTO_RESUME 续跑至 COMPLETED", async () => {
    const { composition, runtime } = await createComposition();
    try {
        const runId = `run-lease-auto-${crypto.randomUUID()}`;
        insertRunningRun(composition, runId);
        insertSafeCheckpoint(composition, runId);
        expect(composition.runStore.get(runId)?.checkpointId)
            .toBe(`checkpoint-${runId}`);
        insertExpiredAttempt(composition, runId);

        for (let round = 0; round < 12; round += 1) {
            await composition.queuePump.tick();
            const status = composition.runStore.get(runId)?.status;
            if (status === "COMPLETED" || status === "FAILED") {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        expect(composition.runStore.get(runId)?.status).toBe("COMPLETED");
        expect(runtime.resumeRequests).toHaveLength(1);

        const events = composition.runStore.listEvents(runId);
        expect(events.some((event) => event.type === "RUN_QUEUED"
            && (event.payload as { reason?: string }).reason === "AUTO_RECOVERY"))
            .toBe(true);
        expect(events.some((event) => (event.payload as { reason?: string }).reason
            === "MANUAL_REVIEW_REQUIRED")).toBe(false);
    } finally {
        await composition.close();
    }
});
