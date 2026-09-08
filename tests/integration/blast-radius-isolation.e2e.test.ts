import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";

import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import type { ResourceSnapshot } from "../../src/resources/resource-observer.ts";
import { startHarnessProcess } from "../../src/main.ts";
import { FakeResourceObserver } from "../fakes/fake-resource-observer.ts";

const normalSnapshot: ResourceSnapshot = {
    snapshotId: "process-e2e-normal",
    observedAt: "2026-08-05T15:00:00.000Z",
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

async function findAvailablePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", resolve);
    });

    const address = probe.address();
    if (address === null || typeof address === "string") {
        probe.close();
        throw new Error("无法获得测试端口");
    }

    const port = address.port;
    await new Promise<void>((resolve, reject) => {
        probe.close((error) => {
            if (error !== undefined) reject(error);
            else resolve();
        });
    });

    return port;
}

describe("Blast Radius Isolation & Subprocess Watchdog E2E Tests", () => {
    afterEach(() => {
        delete process.env.HARNESS_WORKER_SIMULATE;
    });

    test("Master survives Worker SIGKILL: health remains 200, Run converges to FAILED/INTERRUPTED, and subsequent runs succeed", async () => {
        const httpPort = await findAvailablePort();
        const apiKey = "test-blast-radius-key-12345";
        const config = {
            ...loadHarnessConfig({
                VLLM_MODEL_ID: "fake-model",
                HARNESS_DATABASE_PATH: ":memory:",
                HARNESS_PUMP_INTERVAL_MS: "60000",
                HARNESS_BOOTSTRAP_API_KEY: apiKey,
                HARNESS_WORKER_ISOLATION: "process",
            }),
            httpPort,
            workerIsolation: "process" as const,
        };

        // Note: runtime is NOT injected, so createHarnessApplication wires WorkerProcessAgentRuntime
        const runningHarness = await startHarnessProcess({
            config,
            compositionDependencies: {
                resourceObserver: new FakeResourceObserver({
                    ok: true,
                    snapshot: normalSnapshot,
                }),
            },
            installSignalHandlers: false,
        });

        const headers = {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
        };

        try {
            // 1. Verify Master is running and healthy
            const initialHealth = await fetch(`${runningHarness.baseUrl}/health`);
            expect(initialHealth.status).toBe(200);
            expect(await initialHealth.json()).toEqual({ ok: true, started: true });

            // 2. Create Workspace
            const workspaceResponse = await fetch(`${runningHarness.baseUrl}/workspaces`, {
                method: "POST",
                headers,
                body: JSON.stringify({ name: "workspace-blast-radius" }),
            });
            expect(workspaceResponse.status).toBe(201);
            const { workspace } = (await workspaceResponse.json()) as { workspace: { id: string } };

            // 3. Submit Run 1 with Worker configured to simulate SIGKILL
            process.env.HARNESS_WORKER_SIMULATE = "crash_sigkill";

            const submit1 = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    sessionId: "session-sigkill-test",
                    userInput: "Task destined to be killed by SIGKILL",
                    workspaceId: workspace.id,
                }),
            });
            expect(submit1.status).toBe(202);
            const { run: run1 } = (await submit1.json()) as { run: { id: string } };

            // 4. Pump queue to execute Run 1 (Worker starts and dies with SIGKILL)
            await runningHarness.composition.queuePump.tick();

            // Allow child exit event loop tick
            await new Promise((r) => setTimeout(r, 100));

            // 5. ASSERTION 1: Master HTTP API remains fully alive (200 OK)
            const postCrashHealth = await fetch(`${runningHarness.baseUrl}/health`);
            expect(postCrashHealth.status).toBe(200);
            expect(await postCrashHealth.json()).toEqual({ ok: true, started: true });

            // 6. ASSERTION 2: Run 1 transitioned cleanly to FAILED or INTERRUPTED
            const run1Query = await fetch(`${runningHarness.baseUrl}/runs/${run1.id}`, { headers });
            expect(run1Query.status).toBe(200);
            const { run: run1State } = (await run1Query.json()) as {
                run: { status: string; failureReason?: string };
            };

            expect(["FAILED", "INTERRUPTED"]).toContain(run1State.status);
            if (run1State.failureReason) {
                expect(run1State.failureReason).toContain("WORKER_CRASHED");
            }

            // 7. ASSERTION 3: Subsequent Run 2 on another session executes to completion without blocking
            process.env.HARNESS_WORKER_SIMULATE = "mock_stream";

            const submit2 = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    sessionId: "session-healthy-test",
                    userInput: "Task that should succeed normally",
                    workspaceId: workspace.id,
                }),
            });
            expect(submit2.status).toBe(202);
            const { run: run2 } = (await submit2.json()) as { run: { id: string } };

            await runningHarness.composition.queuePump.tick();

            let run2State: { status: string } = { status: "QUEUED" };
            for (let i = 0; i < 40; i++) {
                const run2Query = await fetch(`${runningHarness.baseUrl}/runs/${run2.id}`, { headers });
                if (run2Query.status === 200) {
                    const json = (await run2Query.json()) as { run: { status: string } };
                    run2State = json.run;
                    if (run2State.status !== "RUNNING" && run2State.status !== "QUEUED") {
                        break;
                    }
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(run2State.status).toBe("COMPLETED");
        } finally {
            await runningHarness.close();
        }
    });

    test("Master survives Worker abnormal exit (exit code 42): Run converges safely without hung scheduler", async () => {
        const httpPort = await findAvailablePort();
        const apiKey = "test-crash-exit-key-12345";
        const config = {
            ...loadHarnessConfig({
                VLLM_MODEL_ID: "fake-model",
                HARNESS_DATABASE_PATH: ":memory:",
                HARNESS_PUMP_INTERVAL_MS: "60000",
                HARNESS_BOOTSTRAP_API_KEY: apiKey,
                HARNESS_WORKER_ISOLATION: "process",
            }),
            httpPort,
            workerIsolation: "process" as const,
        };

        const runningHarness = await startHarnessProcess({
            config,
            compositionDependencies: {
                resourceObserver: new FakeResourceObserver({
                    ok: true,
                    snapshot: normalSnapshot,
                }),
            },
            installSignalHandlers: false,
        });

        const headers = {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
        };

        try {
            const workspaceResponse = await fetch(`${runningHarness.baseUrl}/workspaces`, {
                method: "POST",
                headers,
                body: JSON.stringify({ name: "workspace-crash-exit" }),
            });
            const { workspace } = (await workspaceResponse.json()) as { workspace: { id: string } };

            process.env.HARNESS_WORKER_SIMULATE = "crash_exit";

            const submit = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    sessionId: "session-crash-exit",
                    userInput: "Task destined to exit with code 42",
                    workspaceId: workspace.id,
                }),
            });
            const { run } = (await submit.json()) as { run: { id: string } };

            await runningHarness.composition.queuePump.tick();
            await new Promise((r) => setTimeout(r, 100));

            // Master HTTP is healthy
            const health = await fetch(`${runningHarness.baseUrl}/health`);
            expect(health.status).toBe(200);

            // Run state converged to FAILED or INTERRUPTED
            const runQuery = await fetch(`${runningHarness.baseUrl}/runs/${run.id}`, { headers });
            const { run: finalRun } = (await runQuery.json()) as {
                run: { status: string; failureReason?: string };
            };
            expect(["FAILED", "INTERRUPTED"]).toContain(finalRun.status);
            if (finalRun.failureReason) {
                expect(finalRun.failureReason).toContain("WORKER_CRASHED: exitCode=42");
            }
        } finally {
            await runningHarness.close();
        }
    });
});
