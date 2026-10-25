import { expect, test } from "bun:test";
import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import { HarnessHttpApi } from "../../src/http/harness-http-api.ts";
import {
    acquireRunAttemptLease,
    createRunAttempt,
    startRunAttempt,
} from "../../src/runs/run-attempt.ts";
import type { RunEvent, RunEventType } from "../../src/runs/agent-run.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

/**
 * §9.9 v1.5 Phase 5 F7：故障态 Run 的跨用户隔离。
 *
 * Run 因租约过期进入 INTERRUPTED 后，其它用户对 run/events/output/artifacts/
 * interrupt 以及「在对方 workspace 提交」都必须 404。
 */

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

test("故障态 Run 对其它用户完全不可见（run/events/output/artifacts/interrupt/workspace 提交均 404）", async () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH: ":memory:",
        HARNESS_PUMP_INTERVAL_MS: "60000",
        HARNESS_SANDBOX_PROVIDER: "managed-local",
        HARNESS_WORKER_ISOLATION: "in-process",
    });
    const composition = await createHarnessApplication(config, {
        runtime: new FakeAgentRuntime(),
    });

    try {
        await composition.application.start();
        const workspace = composition.workspaceService.create("user-fault-owner", "fault");

        // 制造故障态：RUNNING Run + 过期租约，tick 后回收为 INTERRUPTED。
        const runId = `run-fault-${crypto.randomUUID()}`;
        const timestamp = new Date().toISOString();
        composition.runStore.create(
            {
                id: runId,
                userId: "user-fault-owner",
                harnessSessionId: `session-${runId}`,
                status: "RUNNING",
                userInput: "故障态隔离",
                workspacePath: workspace.rootPath,
                createdAt: timestamp,
                updatedAt: timestamp,
                startedAt: timestamp,
                finishedAt: null,
                checkpointId: null,
                failureReason: null,
            },
            createEvent(runId, 1, "RUN_STARTED", {}),
        );
        const attempt = createRunAttempt({
            id: `attempt-${runId}`,
            runId,
            attemptNumber: 1,
            kind: "START",
            policySnapshotId: null,
            sandboxId: null,
            createdAt: timestamp,
        });
        composition.attemptStore.create(attempt);
        const started = startRunAttempt(
            attempt,
            timestamp,
            "policy-fault",
            "sandbox-fault",
        );
        composition.attemptStore.update(started, "PENDING");
        const expiredAt = new Date(Date.now() - 120_000).toISOString();
        composition.attemptStore.update(
            acquireRunAttemptLease(started, "dead-worker", expiredAt, 60_000),
            "RUNNING",
        );
        await composition.queuePump.tick();
        expect(composition.runStore.get(runId)?.status).toBe("INTERRUPTED");

        const apiFor = (userId: string) => new HarnessHttpApi(
            composition.application,
            composition.checkpointStore,
            {
                authenticate: (key: string) => (key === `${userId}-key`
                    ? { userId, scopes: ["*"] }
                    : null),
                workspaceService: composition.workspaceService,
            },
        );
        const ownerApi = apiFor("user-fault-owner");
        const otherApi = apiFor("user-fault-other");
        const otherHeaders = {
            authorization: "Bearer user-fault-other-key",
            "content-type": "application/json",
        };
        const ownerHeaders = {
            authorization: "Bearer user-fault-owner-key",
            "content-type": "application/json",
        };

        expect((await ownerApi.fetch(new Request(
            `http://harness.local/runs/${runId}`,
            { headers: ownerHeaders },
        ))).status).toBe(200);

        for (const path of [
            `/runs/${runId}`,
            `/runs/${runId}/events`,
            `/runs/${runId}/output`,
            `/runs/${runId}/artifacts`,
        ]) {
            expect((await otherApi.fetch(new Request(
                `http://harness.local${path}`,
                { headers: otherHeaders },
            ))).status).toBe(404);
        }

        expect((await otherApi.fetch(new Request(
            `http://harness.local/runs/${runId}/interrupt`,
            { method: "POST", headers: otherHeaders, body: "{}" },
        ))).status).toBe(404);

        expect((await otherApi.fetch(new Request(
            "http://harness.local/runs",
            {
                method: "POST",
                headers: otherHeaders,
                body: JSON.stringify({
                    workspaceId: workspace.id,
                    userInput: "在对方 workspace 提交",
                }),
            },
        ))).status).toBe(404);
    } finally {
        await composition.close();
    }
});
