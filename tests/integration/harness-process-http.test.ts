import { expect, test } from "bun:test";
import { createServer } from "node:net";

import {
    loadHarnessConfig,
} from "../../src/app/harness-config.ts";
import type {
    ResourceSnapshot,
} from "../../src/resources/resource-observer.ts";
import { startHarnessProcess } from "../../src/main.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import {
    FakeResourceObserver,
} from "../fakes/fake-resource-observer.ts";

const normalSnapshot:ResourceSnapshot = {
    snapshotId:"process-http-normal",
    observedAt:"2026-08-05T15:00:00.000Z",
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

async function findAvailablePort():Promise<number> {
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
            if (error !== undefined) {
                reject(error);
                return;
            }

            resolve();
        });
    });

    return port;
}

test("完整进程入口启动真实 HTTP 监听并安全关闭", async () => {
    const runtime = new FakeAgentRuntime();
    const httpPort = await findAvailablePort();
    const config = {
        ...loadHarnessConfig({
            VLLM_MODEL_ID:"fake-model",
            HARNESS_DATABASE_PATH:":memory:",
            HARNESS_PUMP_INTERVAL_MS:"60000",
            HARNESS_BOOTSTRAP_API_KEY:"test-bootstrap-key-12345",
        }),
        httpPort,
    };
    const runningHarness = await startHarnessProcess({
        config,
        compositionDependencies:{
            runtime,
            resourceObserver:new FakeResourceObserver({
                ok:true,
                snapshot:normalSnapshot,
            }),
        },
        installSignalHandlers:false,
    });

    try {
        const healthResponse = await fetch(
            `${runningHarness.baseUrl}/health`,
        );
        expect(healthResponse.status).toBe(200);
        expect(await healthResponse.json()).toEqual({
            ok:true,
            started:true,
        });

        const headers = {
            "content-type":"application/json",
            authorization:"Bearer test-bootstrap-key-12345",
        };
        const workspaceResponse = await fetch(
            `${runningHarness.baseUrl}/workspaces`,
            {
                method:"POST",
                headers,
                body:JSON.stringify({ name:"process-test" }),
            },
        );
        expect(workspaceResponse.status).toBe(201);
        const workspaceBody = await workspaceResponse.json() as {
            workspace:{ id:string };
        };

        const submitResponse = await fetch(
            `${runningHarness.baseUrl}/runs`,
            {
                method:"POST",
                headers,
                body:JSON.stringify({
                    sessionId:"session-http-process",
                    userInput:"通过真实 HTTP Server 执行任务",
                    workspaceId:workspaceBody.workspace.id,
                }),
            },
        );
        expect(submitResponse.status).toBe(202);
        const submitBody = await submitResponse.json() as {
            run:{ id:string };
        };

        await runningHarness.composition.queuePump.tick();

        const runResponse = await fetch(
            `${runningHarness.baseUrl}/runs/${submitBody.run.id}`,
            { headers },
        );
        const runBody = await runResponse.json() as {
            run:{ status:string };
        };

        expect(runBody.run.status).toBe("COMPLETED");
        expect(runtime.startRequests).toHaveLength(1);
    } finally {
        await runningHarness.close();
        await runningHarness.close();
    }

    expect(runningHarness.composition.application.isStarted()).toBe(false);
});
