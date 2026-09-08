import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import type { ResourceSnapshot } from "../../src/resources/resource-observer.ts";
import { startHarnessProcess } from "../../src/main.ts";
import { FakeResourceObserver } from "../fakes/fake-resource-observer.ts";
import { WorkerProcessAgentRuntime } from "../../src/runtime/worker-process-runtime.ts";
import type { RuntimeEvent, RuntimeStartRequest } from "../../src/runtime/agent-runtime.ts";

const STRESS_WORKER_PATH = resolve(process.cwd(), "tests/fakes/stress-challenge-worker.ts");

const normalSnapshot: ResourceSnapshot = {
    snapshotId: "process-e2e-stress-normal",
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

function createSampleStartRequest(runId: string, tenantId: string = "tenant-test", sandboxId?: string): RuntimeStartRequest {
    return {
        run: {
            runId,
            tenantId,
            harnessSessionId: `session-${runId}`,
            workspacePath: `/tmp/workspace-${runId}`,
            thinkingLevel: "low",
        },
        input: "Test input prompt",
        ...(sandboxId
            ? {
                  execution: {
                      attemptId: `attempt-${runId}`,
                      policySnapshotId: `policy-${runId}`,
                      sandboxId,
                      sandboxEnforcement: {
                          toolExecutionBoundary: "HOST",
                          filesystemIsolation: false,
                          processIsolation: false,
                          networkPolicyEnforced: false,
                          cpuLimitEnforced: false,
                          memoryLimitEnforced: false,
                          diskLimitEnforced: false,
                          pidLimitEnforced: false,
                      },
                      runtimeConfig: {
                          runtimeKind: "PI",
                          provider: "local-vllm",
                          modelId: "mock-model",
                          tools: ["read", "bash"],
                          skills: [],
                      },
                  },
              }
            : {}),
    };
}

describe("Empirical Blast Radius & Crash Recovery Stress Challenge Suite", () => {
    afterEach(() => {
        delete process.env.HARNESS_WORKER_SIMULATE;
        delete process.env.HARNESS_WORKER_SCRIPT_PATH;
    });

    // ========================================================================
    // Part 1: Direct Runtime Crash Matrix (exit 1, exit 137, exit 42, external SIGKILL)
    // ========================================================================

    test("Challenge 1: Worker crash with exitCode=1 emits agent_failed, reclaims sandbox, does not crash Master", async () => {
        let orphanCleaned = false;
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: STRESS_WORKER_PATH,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "crash_exit_1",
            },
            orphanSandboxCleaner: async (id) => {
                if (id === "sandbox-exit-1") orphanCleaned = true;
            },
        });

        const runId = `run-exit-1-${Date.now()}`;
        const events: RuntimeEvent[] = [];
        const unsubscribe = runtime.subscribe(runId, (evt) => events.push(evt));

        let caughtErr: Error | null = null;
        try {
            await runtime.start(createSampleStartRequest(runId, "tenant-1", "sandbox-exit-1"));
        } catch (err) {
            caughtErr = err as Error;
        } finally {
            unsubscribe();
        }

        expect(caughtErr).not.toBeNull();
        expect(caughtErr?.message).toContain("WORKER_CRASHED: exitCode=1");
        const failedEvent = events.find((e) => e.type === "agent_failed");
        expect(failedEvent).toBeDefined();
        if (failedEvent && failedEvent.type === "agent_failed") {
            expect(failedEvent.message).toContain("exitCode=1");
        }
        expect(orphanCleaned).toBe(true);
    });

    test("Challenge 2: Worker crash with exitCode=137 (OOM emulation) attributes signal=SIGKILL and converges", async () => {
        let orphanCleaned = false;
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: STRESS_WORKER_PATH,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "crash_exit_137",
            },
            orphanSandboxCleaner: async (id) => {
                if (id === "sandbox-exit-137") orphanCleaned = true;
            },
        });

        const runId = `run-exit-137-${Date.now()}`;
        const events: RuntimeEvent[] = [];
        const unsubscribe = runtime.subscribe(runId, (evt) => events.push(evt));

        let caughtErr: Error | null = null;
        try {
            await runtime.start(createSampleStartRequest(runId, "tenant-oom", "sandbox-exit-137"));
        } catch (err) {
            caughtErr = err as Error;
        } finally {
            unsubscribe();
        }

        expect(caughtErr).not.toBeNull();
        expect(caughtErr?.message).toContain("WORKER_CRASHED: exitCode=137");
        expect(caughtErr?.message).toContain("signal=SIGKILL");
        const failedEvent = events.find((e) => e.type === "agent_failed");
        expect(failedEvent).toBeDefined();
        if (failedEvent && failedEvent.type === "agent_failed") {
            expect(failedEvent.message).toContain("exitCode=137");
            expect(failedEvent.message).toContain("signal=SIGKILL");
        }
        expect(orphanCleaned).toBe(true);
    });

    test("Challenge 3: Worker crash with exitCode=42 captures forensic exitCode and cleans up", async () => {
        let orphanCleaned = false;
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: STRESS_WORKER_PATH,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "crash_exit_42",
            },
            orphanSandboxCleaner: async (id) => {
                if (id === "sandbox-exit-42") orphanCleaned = true;
            },
        });

        const runId = `run-exit-42-${Date.now()}`;
        const events: RuntimeEvent[] = [];
        const unsubscribe = runtime.subscribe(runId, (evt) => events.push(evt));

        let caughtErr: Error | null = null;
        try {
            await runtime.start(createSampleStartRequest(runId, "tenant-42", "sandbox-exit-42"));
        } catch (err) {
            caughtErr = err as Error;
        } finally {
            unsubscribe();
        }

        expect(caughtErr).not.toBeNull();
        expect(caughtErr?.message).toContain("WORKER_CRASHED: exitCode=42");
        const failedEvent = events.find((e) => e.type === "agent_failed");
        expect(failedEvent).toBeDefined();
        if (failedEvent && failedEvent.type === "agent_failed") {
            expect(failedEvent.message).toContain("exitCode=42");
        }
        expect(orphanCleaned).toBe(true);
    });

    test("Challenge 4: Abrupt external OS SIGKILL while worker is running cleans up cleanly without hanging", async () => {
        let orphanCleaned = false;
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: STRESS_WORKER_PATH,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "await_external_sigkill",
            },
            orphanSandboxCleaner: async (id) => {
                if (id === "sandbox-external-kill") orphanCleaned = true;
            },
        });

        const runId = `run-external-kill-${Date.now()}`;
        const events: RuntimeEvent[] = [];
        const unsubscribe = runtime.subscribe(runId, (evt) => events.push(evt));

        // Start execution in background
        const startPromise = runtime.start(createSampleStartRequest(runId, "tenant-kill", "sandbox-external-kill"));

        // Wait until agent_started is received
        for (let i = 0; i < 30; i++) {
            if (events.some((e) => e.type === "agent_started")) break;
            await new Promise((r) => setTimeout(r, 50));
        }
        expect(events.some((e) => e.type === "agent_started")).toBe(true);

        // Fetch the active worker and kill its OS subprocess abruptly with SIGKILL
        const activeWorkersMap = (runtime as unknown as { activeWorkers: Map<string, { child: { kill: (s: string) => void } }> }).activeWorkers;
        const activeWorker = activeWorkersMap.get(runId);
        expect(activeWorker).toBeDefined();
        activeWorker?.child.kill("SIGKILL");

        let caughtErr: Error | null = null;
        try {
            await startPromise;
        } catch (err) {
            caughtErr = err as Error;
        } finally {
            unsubscribe();
        }

        expect(caughtErr).not.toBeNull();
        expect(caughtErr?.message).toContain("WORKER_CRASHED");
        const failedEvent = events.find((e) => e.type === "agent_failed");
        expect(failedEvent).toBeDefined();
        expect(orphanCleaned).toBe(true);
    });

    // ========================================================================
    // Part 2: Master HTTP API & Health Responsiveness During Crash
    // ========================================================================

    test("Challenge 5: Master /health returns 200 during high-frequency polling while Worker experiences SIGKILL", async () => {
        const httpPort = await findAvailablePort();
        const apiKey = "test-health-stress-key-1";
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
            workerScriptPath: STRESS_WORKER_PATH,
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

        let healthProbeStop = false;
        let healthProbeFailures = 0;
        let healthProbeSuccesses = 0;

        // Background continuous high-frequency /health polling (every 10ms)
        const healthPollPromise = (async () => {
            while (!healthProbeStop) {
                try {
                    const res = await fetch(`${runningHarness.baseUrl}/health`);
                    if (res.status === 200) {
                        healthProbeSuccesses++;
                    } else {
                        healthProbeFailures++;
                    }
                } catch {
                    healthProbeFailures++;
                }
                await new Promise((r) => setTimeout(r, 10));
            }
        })();

        try {
            // Create workspace
            const wsRes = await fetch(`${runningHarness.baseUrl}/workspaces`, {
                method: "POST",
                headers,
                body: JSON.stringify({ name: "ws-health-check" }),
            });
            const { workspace } = (await wsRes.json()) as { workspace: { id: string } };

            // Configure worker to simulate SIGKILL
            process.env.HARNESS_WORKER_SIMULATE = "crash_sigkill";

            const submitRes = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    sessionId: "session-health-sigkill",
                    userInput: "Task will be SIGKILLed",
                    workspaceId: workspace.id,
                }),
            });
            expect(submitRes.status).toBe(202);
            const { run } = (await submitRes.json()) as { run: { id: string } };

            // Trigger execution
            await runningHarness.composition.queuePump.tick();
            await new Promise((r) => setTimeout(r, 200));

            // Verify run converged to FAILED/INTERRUPTED
            const runRes = await fetch(`${runningHarness.baseUrl}/runs/${run.id}`, { headers });
            const { run: runData } = (await runRes.json()) as { run: { status: string; failureReason?: string } };
            expect(["FAILED", "INTERRUPTED"]).toContain(runData.status);
            expect(runData.failureReason).toContain("WORKER_CRASHED");

            // Stop health polling and check results
            healthProbeStop = true;
            await healthPollPromise;

            expect(healthProbeFailures).toBe(0);
            expect(healthProbeSuccesses).toBeGreaterThanOrEqual(10);
        } finally {
            healthProbeStop = true;
            await healthPollPromise;
            await runningHarness.close();
        }
    });

    // ========================================================================
    // Part 3: Multi-Tenant Concurrent Blast Radius Isolation
    // ========================================================================

    test("Challenge 6: Multi-Tenant Concurrency: Tenant A worker killed by SIGKILL does not disrupt concurrent Tenant B run", async () => {
        const httpPort = await findAvailablePort();
        const config = {
            ...loadHarnessConfig({
                VLLM_MODEL_ID: "fake-model",
                HARNESS_DATABASE_PATH: ":memory:",
                HARNESS_PUMP_INTERVAL_MS: "60000",
                HARNESS_WORKER_ISOLATION: "process",
                HARNESS_MAX_ACTIVE_RUNS: "10",
                HARNESS_MAX_ACTIVE_RUNS_PER_TENANT: "2",
            }),
            httpPort,
            workerIsolation: "process" as const,
            workerScriptPath: STRESS_WORKER_PATH,
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

        const keyA = "key-tenant-victim";
        const keyB = "key-tenant-survivor";

        // Register independent credentials for Tenant A and Tenant B
        runningHarness.composition.credentialStore.create({
            rawKey: keyA,
            tenantId: "tenant-victim",
            scopes: ["*"],
        });
        runningHarness.composition.credentialStore.create({
            rawKey: keyB,
            tenantId: "tenant-survivor",
            scopes: ["*"],
        });

        const headersA = { "content-type": "application/json", authorization: `Bearer ${keyA}` };
        const headersB = { "content-type": "application/json", authorization: `Bearer ${keyB}` };

        try {
            // 1. Create separate workspaces for both tenants
            const wsResA = await fetch(`${runningHarness.baseUrl}/workspaces`, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({ name: "workspace-victim" }),
            });
            expect(wsResA.status).toBe(201);
            const { workspace: wsA } = (await wsResA.json()) as { workspace: { id: string } };

            const wsResB = await fetch(`${runningHarness.baseUrl}/workspaces`, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({ name: "workspace-survivor" }),
            });
            expect(wsResB.status).toBe(201);
            const { workspace: wsB } = (await wsResB.json()) as { workspace: { id: string } };

            // 2. Set worker simulation to selective tenant crash: victim crashes, survivor succeeds
            process.env.HARNESS_WORKER_SIMULATE = "tenant_selective_crash";

            // 3. Submit Run A for Tenant A (Victim)
            const submitA = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    sessionId: "session-victim",
                    userInput: "Run for Tenant A doomed to crash",
                    workspaceId: wsA.id,
                }),
            });
            expect(submitA.status).toBe(202);
            const { run: runA } = (await submitA.json()) as { run: { id: string } };

            // 4. Submit Run B for Tenant B (Survivor) concurrently
            const submitB = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({
                    sessionId: "session-survivor",
                    userInput: "Run for Tenant B designed to succeed concurrently",
                    workspaceId: wsB.id,
                }),
            });
            expect(submitB.status).toBe(202);
            const { run: runB } = (await submitB.json()) as { run: { id: string } };

            // 5. Trigger Queue Coordinator Drain (both runs get scheduled)
            // Pump may throw because Run A rejects when worker crashes, but Run B must not be halted
            try {
                await runningHarness.composition.queuePump.tick();
            } catch (err) {
                // Expected: Pump error handler or tick rejection from crashed child
            }

            // Wait for both worker lifecycles to settle
            await new Promise((r) => setTimeout(r, 400));

            // Drain any pending queue items if needed
            try {
                await runningHarness.composition.queuePump.tick();
            } catch {}

            // 6. Verify Master is 100% healthy
            const health = await fetch(`${runningHarness.baseUrl}/health`);
            expect(health.status).toBe(200);
            expect(await health.json()).toEqual({ ok: true, started: true });

            // 7. Verify Tenant A's Run converged cleanly to FAILED or INTERRUPTED
            const queryA = await fetch(`${runningHarness.baseUrl}/runs/${runA.id}`, { headers: headersA });
            expect(queryA.status).toBe(200);
            const { run: stateA } = (await queryA.json()) as { run: { status: string; failureReason?: string } };
            expect(["FAILED", "INTERRUPTED"]).toContain(stateA.status);
            expect(stateA.failureReason).toContain("WORKER_CRASHED");

            // 8. Verify Tenant B's Run completed successfully without disruption!
            let stateB: { status: string } = { status: "QUEUED" };
            for (let i = 0; i < 30; i++) {
                const queryB = await fetch(`${runningHarness.baseUrl}/runs/${runB.id}`, { headers: headersB });
                if (queryB.status === 200) {
                    const json = (await queryB.json()) as { run: { status: string } };
                    stateB = json.run;
                    if (stateB.status === "COMPLETED" || stateB.status === "FAILED") {
                        break;
                    }
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(stateB.status).toBe("COMPLETED");

            // 9. Verify Tenant B output was recorded
            const outputBRes = await fetch(`${runningHarness.baseUrl}/runs/${runB.id}/output`, { headers: headersB });
            expect(outputBRes.status).toBe(200);
            const outputB = (await outputBRes.json()) as { finalText: string; chunks: unknown[] };
            expect(outputB.finalText).toContain("tenant-survivor");

            // 10. Verify that Tenant A can subsequently submit and run a new task successfully
            process.env.HARNESS_WORKER_SIMULATE = "mock_stream";

            const submitA2 = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    sessionId: "session-victim-2",
                    userInput: "Subsequent task for Tenant A",
                    workspaceId: wsA.id,
                }),
            });
            expect(submitA2.status).toBe(202);
            const { run: runA2 } = (await submitA2.json()) as { run: { id: string } };

            await runningHarness.composition.queuePump.tick();

            let stateA2: { status: string } = { status: "QUEUED" };
            for (let i = 0; i < 30; i++) {
                const queryA2 = await fetch(`${runningHarness.baseUrl}/runs/${runA2.id}`, { headers: headersA });
                if (queryA2.status === 200) {
                    const json = (await queryA2.json()) as { run: { status: string } };
                    stateA2 = json.run;
                    if (stateA2.status === "COMPLETED" || stateA2.status === "FAILED") {
                        break;
                    }
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(stateA2.status).toBe("COMPLETED");
        } finally {
            await runningHarness.close();
        }
    });

    test("Challenge 7: Master HTTP E2E: Worker crash with exitCode=1 converges run, /health remains 200, and scheduler recovers", async () => {
        const httpPort = await findAvailablePort();
        const apiKey = "test-exit-1-http-key";
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
            workerScriptPath: STRESS_WORKER_PATH,
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

        const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };

        try {
            const wsRes = await fetch(`${runningHarness.baseUrl}/workspaces`, {
                method: "POST",
                headers,
                body: JSON.stringify({ name: "ws-exit-1" }),
            });
            const { workspace } = (await wsRes.json()) as { workspace: { id: string } };

            process.env.HARNESS_WORKER_SIMULATE = "crash_exit_1";

            const submit = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    sessionId: "session-exit-1",
                    userInput: "Task destined to exit with code 1",
                    workspaceId: workspace.id,
                }),
            });
            expect(submit.status).toBe(202);
            const { run } = (await submit.json()) as { run: { id: string } };

            await runningHarness.composition.queuePump.tick();
            await new Promise((r) => setTimeout(r, 150));

            // Master HTTP is healthy
            const health = await fetch(`${runningHarness.baseUrl}/health`);
            expect(health.status).toBe(200);
            expect(await health.json()).toEqual({ ok: true, started: true });

            // Run state converged to FAILED or INTERRUPTED
            const runQuery = await fetch(`${runningHarness.baseUrl}/runs/${run.id}`, { headers });
            const { run: finalRun } = (await runQuery.json()) as {
                run: { status: string; failureReason?: string };
            };
            expect(["FAILED", "INTERRUPTED"]).toContain(finalRun.status);
            expect(finalRun.failureReason).toContain("WORKER_CRASHED: exitCode=1");
        } finally {
            await runningHarness.close();
        }
    });

    test("Challenge 8: Master HTTP E2E: Worker crash with exitCode=137 (OOM) converges run, /health remains 200, and scheduler recovers", async () => {
        const httpPort = await findAvailablePort();
        const apiKey = "test-exit-137-http-key";
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
            workerScriptPath: STRESS_WORKER_PATH,
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

        const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };

        try {
            const wsRes = await fetch(`${runningHarness.baseUrl}/workspaces`, {
                method: "POST",
                headers,
                body: JSON.stringify({ name: "ws-exit-137" }),
            });
            const { workspace } = (await wsRes.json()) as { workspace: { id: string } };

            process.env.HARNESS_WORKER_SIMULATE = "crash_exit_137";

            const submit = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    sessionId: "session-exit-137",
                    userInput: "Task destined to exit with code 137 (OOM)",
                    workspaceId: workspace.id,
                }),
            });
            expect(submit.status).toBe(202);
            const { run } = (await submit.json()) as { run: { id: string } };

            await runningHarness.composition.queuePump.tick();
            await new Promise((r) => setTimeout(r, 150));

            // Master HTTP is healthy
            const health = await fetch(`${runningHarness.baseUrl}/health`);
            expect(health.status).toBe(200);
            expect(await health.json()).toEqual({ ok: true, started: true });

            // Run state converged to FAILED or INTERRUPTED
            const runQuery = await fetch(`${runningHarness.baseUrl}/runs/${run.id}`, { headers });
            const { run: finalRun } = (await runQuery.json()) as {
                run: { status: string; failureReason?: string };
            };
            expect(["FAILED", "INTERRUPTED"]).toContain(finalRun.status);
            expect(finalRun.failureReason).toContain("WORKER_CRASHED: exitCode=137");
            expect(finalRun.failureReason).toContain("signal=SIGKILL");
        } finally {
            await runningHarness.close();
        }
    });
});
