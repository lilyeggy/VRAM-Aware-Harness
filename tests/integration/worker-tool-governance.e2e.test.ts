import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import type { ResourceSnapshot } from "../../src/resources/resource-observer.ts";
import { startHarnessProcess } from "../../src/main.ts";
import { FakeResourceObserver } from "../fakes/fake-resource-observer.ts";
import { canAutomaticallyReplay } from "../../src/tools/tool-execution.ts";

const normalSnapshot: ResourceSnapshot = {
    snapshotId: "governance-e2e-normal",
    observedAt: "2026-09-08T15:00:00.000Z",
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

async function waitForTerminalRun(
    baseUrl: string,
    headers: Record<string, string>,
    runId: string,
): Promise<{ status: string; failureReason?: string }> {
    for (let i = 0; i < 100; i++) {
        const response = await fetch(`${baseUrl}/runs/${runId}`, { headers });
        if (response.status === 200) {
            const json = (await response.json()) as { run: { status: string; failureReason?: string } };
            if (json.run.status !== "QUEUED" && json.run.status !== "RUNNING") {
                return json.run;
            }
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Run ${runId} 未在超时内到达终态`);
}

describe("Worker 模式工具治理端到端（真实子进程 + SQLite 账本）", () => {
    afterEach(() => {
        delete process.env.HARNESS_WORKER_SIMULATE;
    });

    test("受治工具调用落账本与 Checkpoint；PREPARED 与 COMPLETE 之间崩溃则保留 fail-closed 记账", async () => {
        const httpPort = await findAvailablePort();
        const apiKey = "test-tool-governance-key-12345";
        const tempDir = mkdtempSync(join(tmpdir(), "harness-governance-"));
        const dbPath = join(tempDir, "harness.db");

        const config = {
            ...loadHarnessConfig({
                VLLM_MODEL_ID: "fake-model",
                HARNESS_DATABASE_PATH: dbPath,
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
            // ---------- 阶段 1：受治工具调用完整走通（PREPARED → COMPLETE → Checkpoint）----------
            process.env.HARNESS_WORKER_SIMULATE = "tool_roundtrip";

            const workspaceResponse = await fetch(`${runningHarness.baseUrl}/workspaces`, {
                method: "POST",
                headers,
                body: JSON.stringify({ name: "workspace-governance" }),
            });
            expect(workspaceResponse.status).toBe(201);
            const { workspace } = (await workspaceResponse.json()) as { workspace: { id: string } };

            const submit1 = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    sessionId: "session-governed-ok",
                    userInput: "任务应携带受治理的工具调用并成功完成",
                    workspaceId: workspace.id,
                }),
            });
            expect(submit1.status).toBe(202);
            const { run: run1 } = (await submit1.json()) as { run: { id: string } };

            await runningHarness.composition.queuePump.tick();
            const run1State = await waitForTerminalRun(runningHarness.baseUrl, headers, run1.id);
            expect(run1State.status).toBe("COMPLETED");

            // agent_started/completed 是生命周期事件，由 RunService 负责状态写入，
            // 不落事件时间线（见 runtime-event-bridge）；治理证据以账本 + Checkpoint 断言为准。
            const events1 = await fetch(`${runningHarness.baseUrl}/runs/${run1.id}/events`, { headers });
            expect(events1.status).toBe(200);

            {
                // 与生产一致：strict 绑定（$runId ← { runId }），否则命名参数会静默失配。
                const db = new Database(dbPath, { strict: true });
                try {
                    const execution = db.query(
                        `SELECT status, result_json FROM tool_executions WHERE tool_call_id = 'simulate-governed-tool-call-1';`,
                    ).get() as { status: string; result_json: string | null } | null;
                    expect(execution).not.toBeNull();
                    expect(execution?.status).toBe("SUCCEEDED");
                    expect(execution?.result_json).toContain("governed tool result");

                    const checkpoint = db.query(
                        `SELECT cp.id FROM checkpoints cp WHERE cp.run_id = $runId;`,
                    ).get({ runId: run1.id }) as { id: string } | null;
                    expect(checkpoint).not.toBeNull();

                    const runRow = db.query(
                        `SELECT checkpoint_id FROM agent_runs WHERE id = $runId;`,
                    ).get({ runId: run1.id }) as { checkpoint_id: string | null } | null;
                    expect(runRow?.checkpoint_id).toBe(checkpoint?.id);

                    const preparedCount = db.query(
                        `SELECT COUNT(*) AS count FROM tool_executions WHERE run_id = $runId AND status = 'PREPARED';`,
                    ).get({ runId: run1.id }) as { count: number };
                    expect(preparedCount.count).toBe(0);
                } finally {
                    db.close();
                }
            }

            // ---------- 阶段 2：PREPARED 与 COMPLETE 之间 SIGKILL → fail-closed 记账保留 ----------
            process.env.HARNESS_WORKER_SIMULATE = "tool_after_prepare";

            const submit2 = await fetch(`${runningHarness.baseUrl}/runs`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    sessionId: "session-governed-crash",
                    userInput: "任务将在 PREPARED 与 COMPLETE 之间被强杀",
                    workspaceId: workspace.id,
                }),
            });
            expect(submit2.status).toBe(202);
            const { run: run2 } = (await submit2.json()) as { run: { id: string } };

            await runningHarness.composition.queuePump.tick();
            const run2State = await waitForTerminalRun(runningHarness.baseUrl, headers, run2.id);
            expect(["FAILED", "INTERRUPTED"]).toContain(run2State.status);
            if (run2State.failureReason) {
                expect(run2State.failureReason).toContain("WORKER_CRASHED");
            }

            {
                const db = new Database(dbPath, { strict: true });
                try {
                    // Worker 死在 PREPARED 与 COMPLETE 之间：记账保留，绝不静默消失。
                    const execution = db.query(
                        `SELECT status, effect FROM tool_executions WHERE run_id = $runId AND tool_call_id = 'simulate-governed-tool-call-1';`,
                    ).get({ runId: run2.id }) as { status: string; effect: string } | null;
                    expect(execution).not.toBeNull();
                    expect(execution?.status).toBe("PREPARED");
                    expect(execution?.effect).toBe("UNKNOWN_EFFECT");

                    // 无 Checkpoint 产生；恢复语义 fail-closed：不允许自动重放。
                    const checkpointCount = db.query(
                        `SELECT COUNT(*) AS count FROM checkpoints WHERE run_id = $runId;`,
                    ).get({ runId: run2.id }) as { count: number };
                    expect(checkpointCount.count).toBe(0);
                    expect(canAutomaticallyReplay("PREPARED", "UNKNOWN_EFFECT")).toBe(false);
                } finally {
                    db.close();
                }
            }
        } finally {
            await runningHarness.close();
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, 60_000);
});
