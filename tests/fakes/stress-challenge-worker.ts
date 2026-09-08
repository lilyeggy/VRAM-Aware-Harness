/**
 * Dedicated Stress Testing Worker for Milestone 1 Blast Radius Isolation Challenges.
 *
 * Implements the standard worker IPC protocol while providing deterministic simulation
 * hooks for crash codes (1, 42, 137), abrupt SIGKILL, tenant-selective crashes,
 * and concurrent multi-tenant execution.
 */

import {
    createRunCompletedMessage,
    createRunFailedMessage,
    createRuntimeEventMessage,
    createWorkerReadyMessage,
    formatJsonLine,
    JsonLineParser,
    type MasterToWorkerMessage,
    type WorkerToMasterMessage,
} from "../../src/worker/worker-protocol.ts";

// Redirect console output to stderr to keep stdout strictly for JSON IPC
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

function sendToMaster(msg: WorkerToMasterMessage): Promise<void> {
    return new Promise<void>((resolve) => {
        const line = formatJsonLine(msg);
        if (!process.stdout.write(line)) {
            process.stdout.once("drain", resolve);
        } else {
            resolve();
        }
    });
}

const parser = new JsonLineParser<MasterToWorkerMessage>();

async function handleMessage(msg: MasterToWorkerMessage): Promise<void> {
    if (msg.type === "START_RUN") {
        const runId = msg.runId;
        const tenantId = msg.request.run.tenantId;
        const mode = process.env.HARNESS_WORKER_SIMULATE ?? msg.request.input;

        // 1. Crash with exit code 1
        if (mode === "crash_exit_1" || mode?.includes("SIMULATE_EXIT_1")) {
            console.error(`[StressWorker PID ${process.pid}] Simulating crash with exitCode=1 for run ${runId}`);
            process.exit(1);
        }

        // 2. Crash with exit code 137 (OOM)
        if (mode === "crash_exit_137" || mode?.includes("SIMULATE_EXIT_137")) {
            console.error(`[StressWorker PID ${process.pid}] Simulating OOM crash with exitCode=137 for run ${runId}`);
            process.exit(137);
        }

        // 3. Crash with exit code 42
        if (mode === "crash_exit_42" || mode?.includes("SIMULATE_EXIT_42")) {
            console.error(`[StressWorker PID ${process.pid}] Simulating crash with exitCode=42 for run ${runId}`);
            process.exit(42);
        }

        // 4. Abrupt self-SIGKILL
        if (mode === "crash_sigkill" || mode?.includes("SIMULATE_SIGKILL")) {
            console.error(`[StressWorker PID ${process.pid}] Simulating SIGKILL for run ${runId}`);
            process.kill(process.pid, "SIGKILL");
            return;
        }

        // 5. Tenant-selective crash (for multi-tenant concurrent blast radius testing)
        if (mode === "tenant_selective_crash") {
            if (tenantId === "tenant-victim" || runId.includes("victim")) {
                console.error(`[StressWorker PID ${process.pid}] Victim tenant ${tenantId} run ${runId} terminating via SIGKILL`);
                process.kill(process.pid, "SIGKILL");
                return;
            }
            // Survivor tenant continues to normal completion
        }

        // 6. External SIGKILL target: send started event and wait to be killed externally
        if (mode === "await_external_sigkill" || mode?.includes("SIMULATE_AWAIT_KILL")) {
            console.error(`[StressWorker PID ${process.pid}] Awaiting external kill for run ${runId}`);
            await sendToMaster(createRuntimeEventMessage(runId, {
                type: "agent_started",
                runId,
                timestamp: new Date().toISOString(),
                runtimeSessionRef: `session-${runId}`,
            }));
            // Keep event loop alive waiting for external signal
            setInterval(() => {}, 1000);
            return;
        }

        // 7. Normal execution path (mock streaming completion)
        await sendToMaster(createRuntimeEventMessage(runId, {
            type: "agent_started",
            runId,
            timestamp: new Date().toISOString(),
            runtimeSessionRef: `session-${runId}`,
        }));

        await sendToMaster(createRuntimeEventMessage(runId, {
            type: "text_delta",
            runId,
            timestamp: new Date().toISOString(),
            delta: `Execution result for run ${runId} under tenant ${tenantId}`,
        }));

        await sendToMaster(createRuntimeEventMessage(runId, {
            type: "agent_completed",
            runId,
            timestamp: new Date().toISOString(),
        }));

        await sendToMaster(createRunCompletedMessage(runId, "SUCCESS"));
        setTimeout(() => process.exit(0), 10);
    }
}

process.stdin.on("data", (chunk: Buffer | string) => {
    for (const msg of parser.feed(chunk)) {
        handleMessage(msg).catch((err) => {
            console.error(`[StressWorker PID ${process.pid}] Error:`, err);
        });
    }
});

process.stdin.on("end", () => {
    for (const msg of parser.flush()) {
        handleMessage(msg).catch((err) => {
            console.error(`[StressWorker PID ${process.pid}] Error on flush:`, err);
        });
    }
});

// Immediately announce readiness to Master
void sendToMaster(createWorkerReadyMessage(process.pid));
