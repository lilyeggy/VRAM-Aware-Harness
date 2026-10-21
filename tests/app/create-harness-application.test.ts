import { expect, test } from "bun:test";

import {
    createHarnessApplication,
} from "../../src/app/create-harness-application.ts";
import {
    loadHarnessConfig,
} from "../../src/app/harness-config.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import type { SandboxProvider } from "../../src/sandbox/sandbox-provider.ts";
import { unrestrictedPolicy } from "../../src/policies/effective-policy.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

test("createHarnessApplication 用 Fake 外部依赖组装完整真实应用链", async () => {
    const runtime = new FakeAgentRuntime();
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH:":memory:",
        HARNESS_PUMP_INTERVAL_MS:"60000",
    });
    const composition = await createHarnessApplication(config, {
        runtime,
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


test("HARNESS_SANDBOX_PROVIDER=microvm 未显式设置 driver 时必须 fail-closed", async () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH:":memory:",
        HARNESS_PUMP_INTERVAL_MS:"60000",
        HARNESS_SANDBOX_PROVIDER:"microvm",
    });
    await expect(createHarnessApplication(config)).rejects.toThrow(
        /HARNESS_MICROVM_DRIVER=firecracker/,
    );
});


test("B2：runPolicy.allowNetwork=true 在 strict 平台策略下 fail-closed，且不创建 sandbox", async () => {
    const runtime = new FakeAgentRuntime();
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH:":memory:",
        HARNESS_PUMP_INTERVAL_MS:"60000",
        HARNESS_SANDBOX_PROVIDER:"container",
        HARNESS_SANDBOX_PROFILE:"default",
        HARNESS_SANDBOX_RUNTIME:"runsc",
    });
    let createCalls = 0;
    const sandboxProvider: SandboxProvider = {
        async create() {
            createCalls += 1;
            throw new Error("联网请求不应创建 sandbox");
        },
        async terminate() {},
        subscribe() {
            return () => {};
        },
    };
    const composition = await createHarnessApplication(config, {
        runtime,
        sandboxProvider,
    });

    try {
        await composition.application.start();
        const run = composition.application.submitRun({
            tenantId:"tenant-network",
            harnessSessionId:"session-network",
            userInput:"联网任务",
            workspacePath:"/tmp/network-workspace",
            runPolicy:{ ...unrestrictedPolicy, allowNetwork:true },
        });

        await composition.queuePump.tick();

        expect(createCalls).toBe(0);
        expect(runtime.startRequests).toHaveLength(0);
        expect(composition.runStore.get(run.id)?.status).toBe("INTERRUPTED");
        const interrupted = composition.runStore.listEvents(run.id)
            .find((event) => event.type === "RUN_INTERRUPTED");
        expect(JSON.stringify(interrupted?.payload)).toContain(
            "allowNetwork=true 被平台策略拒绝",
        );
    } finally {
        await composition.close();
    }
});

test("in-process 路径启动 MCP server，并把工具暴露给 PiAdapter", async () => {
    const mcpFixturePath = new URL(
        "../mcp/fixtures/echo-mcp-server.ts",
        import.meta.url,
    ).pathname;
    const config = loadHarnessConfig({
        VLLM_MODEL_ID:"fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH:":memory:",
        HARNESS_PUMP_INTERVAL_MS:"60000",
        HARNESS_WORKER_ISOLATION:"in-process",
        HARNESS_MCP_SERVERS:JSON.stringify([
            {
                name:"echo",
                command:process.execPath,
                args:[mcpFixturePath],
                requestTimeoutMs:5_000,
            },
        ]),
    });
    const composition = await createHarnessApplication(config, {
        // PiAdapter 构造只保存 ModelRuntime 引用；本用例不启动 Run，无需真实模型，
        // 但 createPiRuntime 会校验 getModel 返回非 undefined。
        modelRuntime:{ getModel:() => ({}) } as never,
    });

    try {
        await composition.application.start();
        expect(composition.mcpRegistry?.configuredServerCount).toBe(1);
        expect(composition.mcpRegistry?.connectedServerCount).toBe(1);
        const names = composition.mcpRegistry?.listTools()
            .map((descriptor: { name: string }) => descriptor.name)
            .sort();
        expect(names).toEqual(["echo", "write_note"]);
    } finally {
        await composition.close();
    }
});
