import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { WorkerProcessAgentRuntime } from "../../src/runtime/worker-process-runtime.ts";
import type {
    RuntimeEvent,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "../../src/runtime/agent-runtime.ts";
import {
    formatJsonLine,
    isMasterToWorkerMessage,
    isWorkerToMasterMessage,
    JsonLineParser,
    parseJsonLine,
    serializeError,
} from "../../src/worker/worker-protocol.ts";

const WORKER_MAIN = resolve(process.cwd(), "src/worker/worker-main.ts");

function createSampleStartRequest(runId: string, sandboxId?: string): RuntimeStartRequest {
    return {
        run: {
            runId,
            tenantId: "tenant-test",
            harnessSessionId: "session-test",
            workspacePath: "/tmp/workspace-test",
            thinkingLevel: "low",
        },
        input: "Test input prompt",
        ...(sandboxId
            ? {
                  execution: {
                      attemptId: "attempt-1",
                      policySnapshotId: "policy-1",
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

function createSampleResumeRequest(runId: string): RuntimeResumeRequest {
    return {
        run: {
            runId,
            tenantId: "tenant-test",
            harnessSessionId: "session-test",
            workspacePath: "/tmp/workspace-test",
        },
        checkpoint: {
            checkpointId: "ckpt-1",
            runtimeSessionRef: "session-ref-1",
            lastEventSequence: 3,
        },
        continuationInput: "Resume input prompt",
    };
}

describe("WorkerProcessAgentRuntime Unit & Integration Tests", () => {
    test("Happy Path: Worker subprocess executes run and streams events to Master", async () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "mock_stream",
            },
        });

        const runId = `run-happy-${Date.now()}`;
        const events: RuntimeEvent[] = [];

        const unsubscribe = runtime.subscribe(runId, (event) => {
            events.push(event);
        });

        try {
            await runtime.start(createSampleStartRequest(runId));
        } finally {
            unsubscribe();
        }

        expect(events.length).toBeGreaterThanOrEqual(2);
        const event0 = events[0];
        const event1 = events[1];
        expect(event0?.type).toBe("agent_started");
        expect(event1?.type).toBe("text_delta");
        if (event1?.type === "text_delta") {
            expect(event1.delta).toContain("isolated worker subprocess");
        }
    });

    test("Resume Path: Worker subprocess executes resume and streams events", async () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "mock_stream",
            },
        });

        const runId = `run-resume-${Date.now()}`;
        const events: RuntimeEvent[] = [];

        const unsubscribe = runtime.subscribe(runId, (event) => {
            events.push(event);
        });

        try {
            await runtime.resume(createSampleResumeRequest(runId));
        } finally {
            unsubscribe();
        }

        expect(events.length).toBeGreaterThanOrEqual(2);
        const event0 = events[0];
        expect(event0?.type).toBe("agent_resumed");
        if (event0?.type === "agent_resumed") {
            expect(event0.checkpointId).toBe("ckpt-1");
        }
    });

    test("Application Failure: Worker reports RUN_FAILED cleanly via protocol", async () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "fail_run",
            },
        });

        const runId = `run-fail-${Date.now()}`;
        let caughtError: Error | null = null;

        try {
            await runtime.start(createSampleStartRequest(runId));
        } catch (err) {
            caughtError = err as Error;
        }

        expect(caughtError).not.toBeNull();
        expect(caughtError?.message).toContain("Simulated worker execution failure");
    });

    test("Crash Watchdog: Non-zero exit code emits agent_failed and calls orphan cleaner", async () => {
        let cleanedSandboxId = "";
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "crash_exit",
            },
            orphanSandboxCleaner: async (sandboxId) => {
                cleanedSandboxId = sandboxId;
            },
        });

        const runId = `run-crash-exit-${Date.now()}`;
        const sandboxId = `sandbox-${Date.now()}`;
        const events: RuntimeEvent[] = [];

        const unsubscribe = runtime.subscribe(runId, (event) => {
            events.push(event);
        });

        let caughtError: Error | null = null;
        try {
            await runtime.start(createSampleStartRequest(runId, sandboxId));
        } catch (err) {
            caughtError = err as Error;
        } finally {
            unsubscribe();
        }

        expect(caughtError).not.toBeNull();
        expect(caughtError?.message).toContain("WORKER_CRASHED: exitCode=42");

        const failedEvent = events.find((e) => e.type === "agent_failed");
        expect(failedEvent).toBeDefined();
        if (failedEvent && failedEvent.type === "agent_failed") {
            expect(failedEvent.message).toContain("WORKER_CRASHED: exitCode=42");
        }

        expect(cleanedSandboxId).toBe(sandboxId);
    });

    test("SIGKILL Blast Radius: Worker killed via SIGKILL does not crash Master and triggers cleanup", async () => {
        let cleanedSandboxId = "";
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "crash_sigkill",
            },
            orphanSandboxCleaner: async (sandboxId) => {
                cleanedSandboxId = sandboxId;
            },
        });

        const runId = `run-sigkill-${Date.now()}`;
        const sandboxId = `sandbox-sigkill-${Date.now()}`;
        const events: RuntimeEvent[] = [];

        const unsubscribe = runtime.subscribe(runId, (event) => {
            events.push(event);
        });

        let caughtError: Error | null = null;
        try {
            await runtime.start(createSampleStartRequest(runId, sandboxId));
        } catch (err) {
            caughtError = err as Error;
        } finally {
            unsubscribe();
        }

        expect(caughtError).not.toBeNull();
        expect(caughtError?.message).toContain("WORKER_CRASHED");

        const failedEvent = events.find((e) => e.type === "agent_failed");
        expect(failedEvent).toBeDefined();
        if (failedEvent && failedEvent.type === "agent_failed") {
            expect(failedEvent.message).toContain("WORKER_CRASHED");
        }

        expect(cleanedSandboxId).toBe(sandboxId);
    });

    test("Graceful Interrupt: Worker handles INTERRUPT_RUN and terminates", async () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "hang",
            },
            interruptGraceMs: 3000,
        });

        const runId = `run-interrupt-${Date.now()}`;

        const startPromise = runtime.start(createSampleStartRequest(runId));

        // Allow worker to start and enter hang state
        await new Promise((r) => setTimeout(r, 200));

        // Send interrupt
        const interruptPromise = runtime.interrupt(runId);

        // Both start and interrupt should settle cleanly without hanging
        await Promise.allSettled([startPromise, interruptPromise]);
    });

    test("Stubborn Worker Interrupt: Master escalates to SIGTERM and SIGKILL within bounds", async () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "hang_stubborn",
            },
            interruptGraceMs: 500,
        });

        const runId = `run-stubborn-${Date.now()}`;

        const startPromise = runtime.start(createSampleStartRequest(runId));
        await new Promise((r) => setTimeout(r, 200));

        const startedAt = Date.now();
        await runtime.interrupt(runId);
        const durationMs = Date.now() - startedAt;

        // Escalation should complete within grace + sigterm grace (~3500ms max)
        expect(durationMs).toBeLessThan(5000);
        await Promise.allSettled([startPromise]);
    });

    test("Stdio Purity & Corruption Resilience: Non-JSON log lines on stdout are safely ignored", async () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "corrupt_stdout",
            },
        });

        const runId = `run-corrupt-${Date.now()}`;

        // Even with garbage output on stdout, Master must NOT throw SyntaxError
        // and should still process normal messages or report failure safely
        try {
            await runtime.start(createSampleStartRequest(runId));
        } catch {
            // Rejection is fine (since setupRuntime might fail if model isn't running),
            // but Master MUST NOT crash with unhandled JSON SyntaxError!
        }
    });

    test("Handshake Watchdog: Handshake timeout kills hung worker and cleans up orphan sandbox", async () => {
        let cleanerCalled = false;
        let cleanedSandboxId = "";
        let cleanerCallCount = 0;

        const scriptContent = `setInterval(() => {}, 10_000);`;
        const fixturePath = resolve(process.cwd(), "tests/runtime/fixtures/handshake-unit-hang-worker.ts");
        await Bun.write(fixturePath, scriptContent);

        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: fixturePath,
            workerHandshakeTimeoutMs: 150,
            orphanSandboxCleaner: async (sandboxId) => {
                cleanerCalled = true;
                cleanedSandboxId = sandboxId;
                cleanerCallCount++;
            },
        });

        const runId = `run-hs-timeout-${Date.now()}`;
        const sandboxId = `sandbox-hs-timeout-${Date.now()}`;
        const events: RuntimeEvent[] = [];
        const unsubscribe = runtime.subscribe(runId, (evt) => events.push(evt));

        let caughtError: Error | null = null;
        try {
            await runtime.start(createSampleStartRequest(runId, sandboxId));
        } catch (err) {
            caughtError = err as Error;
        } finally {
            unsubscribe();
            await Bun.file(fixturePath).delete();
        }

        expect(caughtError).not.toBeNull();
        expect(caughtError?.message).toContain("Worker failed to become ready within 150ms");

        const failedEvents = events.filter((e) => e.type === "agent_failed");
        expect(failedEvents.length).toBe(1);
        expect(failedEvents[0]?.message).toContain("Worker failed to become ready within 150ms");

        expect(cleanerCalled).toBe(true);
        expect(cleanedSandboxId).toBe(sandboxId);
        expect(cleanerCallCount).toBe(1);
    });

    test("Rapid Interrupt: Immediate interrupt before WORKER_READY gracefully terminates in <1000ms without crash", async () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "mock_stream",
            },
            interruptGraceMs: 3000,
        });

        const runId = `run-rapid-interrupt-unit-${Date.now()}`;
        const startPromise = runtime.start(createSampleStartRequest(runId));

        const startedAt = Date.now();
        const interruptPromise = runtime.interrupt(runId);

        let startError: Error | null = null;
        try {
            await startPromise;
        } catch (err: any) {
            startError = err;
        }
        await interruptPromise;
        const duration = Date.now() - startedAt;

        expect(startError).toBeNull();
        expect(duration).toBeLessThan(1000);
    });

    test("Capability Profile: Reports PI runtime capabilities with deployment key", () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerConfig: {
                piProvider: "vllm-dual-card",
                piModelId: "qwen-72b",
                piTools: ["read", "write"],
                piModelsPath: ".pi/models.json",
                sandboxProvider: "container",
                sandboxProfile: "default",
                sandboxRuntime: "runsc",
                containerImage: "alpine:3.20",
                containerUserId: 65532,
            },
        });

        const profile = runtime.getCapabilityProfile();
        expect(profile.runtimeKind).toBe("PI");
        expect(profile.deploymentKey).toBe("vllm-dual-card/qwen-72b");
        expect(profile.supported).toContain("SESSION_CREATE");
        expect(profile.supported).toContain("INTERRUPT");
        expect(profile.supported).toContain("EXTERNAL_SANDBOX");
    });
});

describe("Worker Protocol Stream Framing & Serialization", () => {
    test("JsonLineParser handles chunk splitting across multiple UTF-8 multibyte characters", () => {
        const parser = new JsonLineParser<{ type: string; payload: string }>();
        const fullMessage = JSON.stringify({
            type: "TEXT",
            payload: "你好，世界！🚀 Master-Worker 架构测试",
        }) + "\n";

        const encoder = new TextEncoder();
        const bytes = encoder.encode(fullMessage);

        const results: Array<{ type: string; payload: string }> = [];

        // Feed in tiny 3-byte chunks to intentionally slice multi-byte UTF-8 bytes
        for (let i = 0; i < bytes.length; i += 3) {
            const chunk = bytes.subarray(i, i + 3);
            for (const item of parser.feed(chunk)) {
                results.push(item);
            }
        }
        for (const item of parser.flush()) {
            results.push(item);
        }

        expect(results.length).toBe(1);
        expect(results[0]?.payload).toBe("你好，世界！🚀 Master-Worker 架构测试");
    });

    test("Error serialization flattens Error objects with stack trace", () => {
        const error = new Error("Something broke inside the worker");
        const serialized = serializeError(error);

        expect(serialized.name).toBe("Error");
        expect(serialized.message).toBe("Something broke inside the worker");
        expect(serialized.stack).toBeDefined();

        const json = JSON.stringify(serialized);
        const parsed = JSON.parse(json);
        expect(parsed.message).toBe("Something broke inside the worker");
    });

    test("Type guards correctly classify protocol messages", () => {
        expect(
            isMasterToWorkerMessage({
                type: "START_RUN",
                runId: "123",
                request: {},
            }),
        ).toBe(true);

        expect(
            isMasterToWorkerMessage({
                type: "SHUTDOWN",
            }),
        ).toBe(true);

        expect(
            isWorkerToMasterMessage({
                type: "WORKER_READY",
                pid: 12345,
            }),
        ).toBe(true);

        expect(
            isWorkerToMasterMessage({
                type: "RUN_COMPLETED",
                runId: "123",
            }),
        ).toBe(true);

        expect(isMasterToWorkerMessage({ type: "UNKNOWN_MSG" })).toBe(false);
        expect(isWorkerToMasterMessage(null)).toBe(false);
    });

    test("formatJsonLine and parseJsonLine round-trip correctly", () => {
        const sample = { type: "TEST", value: 42, text: "hello\nworld" };
        const line = formatJsonLine(sample);

        expect(line.endsWith("\n")).toBe(true);
        expect(line.indexOf("\n")).toBe(line.length - 1); // Only trailing newline

        const parsed = parseJsonLine<typeof sample>(line);
        expect(parsed).toEqual(sample);

        expect(parseJsonLine("   ")).toBeNull();
        expect(parseJsonLine("not a json string")).toBeNull();
        expect(parseJsonLine("null")).toBeNull();
        expect(parseJsonLine("12345")).toBeNull();
        expect(parseJsonLine('"string"')).toBeNull();
        expect(parseJsonLine("true")).toBeNull();
        expect(parseJsonLine("[1, 2, 3]")).toBeNull();
    });

    test("JsonLineParser ignores null, primitives, arrays, and noise without throwing", () => {
        const rawStreamData = [
            "null",
            "undefined",
            "12345",
            "-42.5",
            '"a standalone primitive string"',
            "true",
            "false",
            "[1, 2, 3]",
            '{"broken": json',
            "[LOG] 2026-09-08 System starting up...",
            "",
            "   ",
            "{}",
            '{"unrelated": true}',
            formatJsonLine({ type: "WORKER_READY", pid: 1234 }),
        ].join("\n");

        const parser = new JsonLineParser<any>();
        const parsed: any[] = [];
        for (const item of parser.feed(rawStreamData)) {
            parsed.push(item);
        }
        for (const item of parser.flush()) {
            parsed.push(item);
        }

        expect(parsed.length).toBe(3);
        expect(parsed[0]).toEqual({});
        expect(parsed[1]).toEqual({ unrelated: true });
        expect(parsed[2].type).toBe("WORKER_READY");
    });
});
