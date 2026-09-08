import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { WorkerProcessAgentRuntime } from "../../src/runtime/worker-process-runtime.ts";
import type {
    RuntimeEvent,
    RuntimeStartRequest,
} from "../../src/runtime/agent-runtime.ts";
import {
    createJsonLineReader,
    formatJsonLine,
    isWorkerToMasterMessage,
    JsonLineParser,
    type WorkerToMasterMessage,
} from "../../src/worker/worker-protocol.ts";

const WORKER_MAIN = resolve(process.cwd(), "src/worker/worker-main.ts");

function createSampleStartRequest(runId: string, sandboxId?: string): RuntimeStartRequest {
    return {
        run: {
            runId,
            tenantId: "tenant-challenge",
            harnessSessionId: "session-challenge",
            workspacePath: "/tmp/workspace-challenge",
            thinkingLevel: "low",
        },
        input: "Empirical challenge prompt",
        ...(sandboxId
            ? {
                  execution: {
                      attemptId: "attempt-c1",
                      policySnapshotId: "policy-c1",
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

describe("Empirical Challenge Suite: IPC Stream Parser", () => {
    test("1. Multibyte Unicode Splits: single-byte streaming through complex surrogate & 4-byte UTF-8", () => {
        const parser = new JsonLineParser<{ type: string; payload: string }>();
        const sampleText = "Hello 世界 🚀 🧑‍💻 💥 🇨🇳 繁體中文 特수문자 \uD83D\uDE00";
        const message = { type: "UNICODE_TEST", payload: sampleText };
        const rawJson = formatJsonLine(message);
        const bytes = new TextEncoder().encode(rawJson);

        const results: Array<{ type: string; payload: string }> = [];
        // Feed byte-by-byte (1 byte at a time)
        for (let i = 0; i < bytes.length; i++) {
            for (const item of parser.feed(new Uint8Array([bytes[i]!]))) {
                results.push(item);
            }
        }
        for (const item of parser.flush()) {
            results.push(item);
        }

        expect(results.length).toBe(1);
        expect(results[0]?.payload).toBe(sampleText);
        expect(results[0]?.type).toBe("UNICODE_TEST");
    });

    test("2. Large Multiline Payload: 5MB message with nested escaped newlines and large code blocks", () => {
        const parser = new JsonLineParser<{ type: string; content: string }>();
        const largeString = "line 1: const x = 42;\nline 2: function foo() {\n  return 'bar';\n}\n".repeat(50_000);
        const message = { type: "LARGE_PAYLOAD", content: largeString };
        const rawJson = formatJsonLine(message);
        const bytes = new TextEncoder().encode(rawJson);

        const results: Array<{ type: string; content: string }> = [];
        // Feed in 16KB chunks
        const chunkSize = 16384;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            for (const item of parser.feed(chunk)) {
                results.push(item);
            }
        }
        for (const item of parser.flush()) {
            results.push(item);
        }

        expect(results.length).toBe(1);
        expect(results[0]?.content.length).toBe(largeString.length);
        expect(results[0]?.content).toBe(largeString);
    });

    test("3. Rapid Burst Framing: 1,000 messages packed in single chunk and split randomly", () => {
        const parser = new JsonLineParser<{ index: number; data: string }>();
        const count = 1000;
        let combined = "";
        for (let i = 0; i < count; i++) {
            combined += formatJsonLine({ index: i, data: `burst-${i}` });
        }
        const bytes = new TextEncoder().encode(combined);

        // Case A: Everything in a single burst
        const singleBurstResults: Array<{ index: number; data: string }> = [];
        for (const item of parser.feed(bytes)) {
            singleBurstResults.push(item);
        }
        expect(singleBurstResults.length).toBe(count);
        for (let i = 0; i < count; i++) {
            expect(singleBurstResults[i]?.index).toBe(i);
            expect(singleBurstResults[i]?.data).toBe(`burst-${i}`);
        }

        // Case B: Random chunk slices across messages
        const parserB = new JsonLineParser<{ index: number; data: string }>();
        const slicedResults: Array<{ index: number; data: string }> = [];
        let offset = 0;
        while (offset < bytes.length) {
            const step = Math.floor(Math.random() * 50) + 1;
            const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + step));
            offset += step;
            for (const item of parserB.feed(chunk)) {
                slicedResults.push(item);
            }
        }
        for (const item of parserB.flush()) {
            slicedResults.push(item);
        }

        expect(slicedResults.length).toBe(count);
        for (let i = 0; i < count; i++) {
            expect(slicedResults[i]?.index).toBe(i);
        }
    });

    test("4. Noise lines & non-object JSON: null, booleans, numbers, strings, malformed lines", async () => {
        const rawNoise = [
            "[LOG] system init",
            "",
            "   ",
            "true",
            "false",
            "12345",
            '"quoted string"',
            "[1, 2, 3]",
            '{"incomplete": "json',
            '{"valid": true}\n',
        ].join("\n");

        const parser = new JsonLineParser<any>();
        const parsedItems: any[] = [];
        for (const item of parser.feed(rawNoise)) {
            parsedItems.push(item);
        }
        for (const item of parser.flush()) {
            parsedItems.push(item);
        }

        expect(parsedItems.length).toBeGreaterThan(0);
    });

    test("4b. Resilience: null noise line on stdout does not crash message reader", async () => {
        const streamWithNull = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("null\n" + formatJsonLine({ type: "WORKER_READY", pid: 999 })));
                controller.close();
            },
        });

        let readerCrashError: Error | null = null;
        const received: WorkerToMasterMessage[] = [];
        try {
            for await (const rawMsg of createJsonLineReader<WorkerToMasterMessage>(streamWithNull)) {
                if (!isWorkerToMasterMessage(rawMsg)) {
                    continue;
                }
                received.push(rawMsg);
                switch (rawMsg.type) {
                    case "WORKER_READY":
                        break;
                }
            }
        } catch (err: any) {
            readerCrashError = err;
        }

        expect(readerCrashError).toBeNull();
        expect(received.length).toBe(1);
        expect(received[0]?.type).toBe("WORKER_READY");
        expect((received[0] as any)?.pid).toBe(999);
    });
});

describe("Empirical Challenge Suite: Worker Process Lifecycle", () => {
    test("5. Resilience: Immediate interrupt before WORKER_READY is gracefully handled by Worker", async () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "mock_stream",
            },
            interruptGraceMs: 3000,
        });

        const runId = `run-rapid-interrupt-${Date.now()}`;
        const startPromise = runtime.start(createSampleStartRequest(runId));

        // Call interrupt IMMEDIATELY before WORKER_READY arrives
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

        // Clean graceful interrupt: no crash, completes well within 1000ms
        expect(startError).toBeNull();
        expect(duration).toBeLessThan(1000);
    });

    test("6. Resilience: Handshake timeout kills child with SIGKILL and triggers orphanSandboxCleaner", async () => {
        const testScript = `
            // Hangs during bootstrap without sending WORKER_READY
            setInterval(() => {}, 10000);
        `;

        const scriptPath = resolve(process.cwd(), "tests/runtime/fixtures/handshake-hang-worker.ts");
        await Bun.write(scriptPath, testScript);

        let cleanerWasCalled = false;
        let cleanedSandboxId = "";

        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: scriptPath,
            workerHandshakeTimeoutMs: 300,
            orphanSandboxCleaner: async (sandboxId) => {
                cleanerWasCalled = true;
                cleanedSandboxId = sandboxId;
            },
        });

        const runId = `run-hs-leak-${Date.now()}`;
        const sandboxId = `sandbox-leak-${Date.now()}`;

        try {
            await runtime.start(createSampleStartRequest(runId, sandboxId));
        } catch {}

        await new Promise((r) => setTimeout(r, 150));
        await Bun.file(scriptPath).delete();

        // Verifies fix: cleanerWasCalled MUST be true and cleanedSandboxId matches
        expect(cleanerWasCalled).toBe(true);
        expect(cleanedSandboxId).toBe(sandboxId);
    });

    test("7. Unhandled Exception / Stderr Capture in Worker", async () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: {
                HARNESS_WORKER_SIMULATE: "crash_exit",
            },
        });

        const runId = `run-crash-${Date.now()}`;
        let caughtErr: Error | null = null;
        try {
            await runtime.start(createSampleStartRequest(runId));
        } catch (err: any) {
            caughtErr = err;
        }

        expect(caughtErr).not.toBeNull();
        expect(caughtErr?.message).toContain("WORKER_CRASHED");
        expect(caughtErr?.message).toContain("exitCode=42");
        expect(caughtErr?.message).toContain("Stderr:");
    });
});
