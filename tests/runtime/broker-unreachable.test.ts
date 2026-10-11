import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import type { ResourceSnapshot } from "../../src/resources/resource-observer.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import { FakeResourceObserver } from "../fakes/fake-resource-observer.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

/**
 * §9.9 v1.5 Phase 5 F2：Broker 不可达时 fail-closed。
 *
 * Master 走 BrokerSandboxProvider 创建 sandbox；Broker socket 缺失时
 * create 必须失败并让 Run 落 INTERRUPTED，且不能留下孤儿 sandbox 记录。
 */

const normalSnapshot: ResourceSnapshot = {
    snapshotId: "broker-down-snapshot",
    observedAt: "2026-10-11T10:00:00.000Z",
    sources: ["FAKE"],
    gpuTotalMemoryMiB: 100,
    gpuUsedMemoryMiB: 20,
    gpuFreeMemoryMiB: 80,
    gpuUtilizationPercent: 20,
    runningRequests: 0,
    waitingRequests: 0,
    kvCacheUsagePercent: 20,
    inputTokensPerSecond: 1000,
    outputTokensPerSecond: 100,
};

test("Broker 不可达时 Run fail-closed 为 INTERRUPTED，且不留下孤儿 sandbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-broker-down-"));
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH: ":memory:",
        HARNESS_PUMP_INTERVAL_MS: "60000",
        HARNESS_SANDBOX_PROVIDER: "microvm",
        HARNESS_WORKER_ISOLATION: "in-process",
        HARNESS_SANDBOX_BROKER_SOCKET: join(dir, "missing-broker.sock"),
        HARNESS_SANDBOX_BROKER_CONTROL_TOKEN: "fault-control-token",
        // 关闭自动重试，让首次失败直接进入终态，便于断言。
        HARNESS_RUN_MAX_ATTEMPTS: "1",
    });
    const composition = await createHarnessApplication(config, {
        runtime: new FakeAgentRuntime(),
        resourceObserver: new FakeResourceObserver({
            ok: true,
            snapshot: normalSnapshot,
        }),
    });

    try {
        await composition.application.start();
        const workspace = composition.workspaceService.create(
            "tenant-broker-down",
            "fault",
        );
        const run = composition.application.submitRun({
            tenantId: "tenant-broker-down",
            harnessSessionId: "session-broker-down",
            userInput: "验证 Broker 不可达",
            workspacePath: workspace.rootPath,
        });

        for (let i = 0; i < 200; i += 1) {
            const status = composition.runStore.get(run.id)?.status;
            if (status === "INTERRUPTED" || status === "FAILED" || status === "COMPLETED") {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        expect(composition.runStore.get(run.id)?.status).toBe("INTERRUPTED");
        expect(composition.sandboxStore.listUnsettled()).toEqual([]);
        expect(composition.scheduler.listQueue()).toEqual([]);

        const interrupted = composition.runStore
            .listEvents(run.id)
            .find((event) => event.type === "RUN_INTERRUPTED");
        expect(interrupted?.payload).toMatchObject({ reason: "START_FAILED" });
    } finally {
        await composition.close();
    }
});
