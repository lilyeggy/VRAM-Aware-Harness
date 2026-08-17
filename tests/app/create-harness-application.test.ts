import { expect, test } from "bun:test";

import {
    createHarnessApplication,
} from "../../src/app/create-harness-application.ts";
import {
    loadHarnessConfig,
} from "../../src/app/harness-config.ts";
import type {
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import {
    FakeResourceObserver,
} from "../fakes/fake-resource-observer.ts";

const normalSnapshot:ResourceSnapshot = {
    snapshotId:"composition-snapshot-normal",
    observedAt:"2026-08-05T14:00:00.000Z",
    sources:["FAKE"],
    gpuTotalMemoryMiB:100,
    gpuUsedMemoryMiB:20,
    gpuFreeMemoryMiB:80,
    gpuUtilizationPercent:20,
    runningRequests:0,
    waitingRequests:0,
    kvCacheUsagePercent:20,
    inputTokensPerSecond:1_000,
    outputTokensPerSecond:100,
};

test("createHarnessApplication 用 Fake 外部依赖组装完整真实应用链", async () => {
    const runtime = new FakeAgentRuntime();
    const resourceObserver = new FakeResourceObserver({
        ok:true,
        snapshot:normalSnapshot,
    });
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"fake-model",
        HARNESS_DATABASE_PATH:":memory:",
        HARNESS_PUMP_INTERVAL_MS:"60000",
    });
    const composition = await createHarnessApplication(config, {
        runtime,
        resourceObserver,
    });

    try {
        await composition.application.start();
        const run = composition.application.submitRun({
            tenantId:"tenant-composition",
            harnessSessionId:"session-composition",
            userInput:"验证完整应用组装",
            workspacePath:"/tmp/composition-workspace",
        });

        await composition.queuePump.tick();

        expect(composition.runStore.get(run.id)?.status).toBe("COMPLETED");
        expect(runtime.startRequests).toHaveLength(1);
        expect(composition.decisionStore.listForRun(run.id).map(
            (decision) => decision.action,
        )).toEqual(["START"]);
        expect(composition.scheduler.listQueue()).toEqual([]);

        const healthResponse = await composition.httpApi.fetch(
            new Request("http://harness.local/health"),
        );
        expect(healthResponse.status).toBe(200);
        expect(await healthResponse.json()).toEqual({
            ok:true,
            started:true,
        });
    } finally {
        await composition.close();
        await composition.close();
    }

    expect(composition.application.isStarted()).toBe(false);
});
