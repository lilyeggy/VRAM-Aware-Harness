/**
 * 启动一个带 Fake Runtime 的演示服务，供浏览器打开用户工作台 /app。
 * 预置一个演示账号：demo@team.local / demo-password-123
 *
 * 运行：bun run scripts/user-console-demo-server.ts
 * 停止：Ctrl+C
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarnessApplication } from "../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../src/app/harness-config.ts";
import { startHarnessHttpServer } from "../src/http/harness-http-server.ts";
import type { ResourceObservation, ResourceObserver } from "../src/resources/resource-observer.ts";
import { DemoAgentRuntime } from "../src/demo/demo-agent-runtime.ts";

class FakeResourceObserver implements ResourceObserver {
    async observe(): Promise<ResourceObservation> {
        return {
            ok: true,
            snapshot: {
                snapshotId: `fake-${Date.now()}`,
                observedAt: new Date().toISOString(),
                sources: ["FAKE"] as const,
                gpuTotalMemoryMiB: 48000,
                gpuUsedMemoryMiB: 8000,
                gpuFreeMemoryMiB: 40000,
                gpuUtilizationPercent: 10,
                runningRequests: 0,
                waitingRequests: 0,
                kvCacheUsagePercent: 10,
                inputTokensPerSecond: 0,
                outputTokensPerSecond: 0,
            },
        };
    }
}

const tempDirectory = mkdtempSync(join(tmpdir(), "vram-aware-harness-user-demo-"));
const config = loadHarnessConfig({
    VLLM_MODEL_ID: "demo-model",
    HARNESS_DATABASE_PATH: join(tempDirectory, "harness.sqlite"),
    HARNESS_PUMP_INTERVAL_MS: "300",
});
const composition = await createHarnessApplication(config, {
    runtime: new DemoAgentRuntime(),
    resourceObserver: new FakeResourceObserver(),
});
await composition.application.start();
const server = startHarnessHttpServer(composition.httpApi, { port: 3977 });

// 预置演示账号（邮箱即租户身份，注册后登录可用）。
composition.credentialStore.registerUser("demo@team.local", "demo-password-123");

console.log("");
console.log(`用户工作台演示服务已启动`);
console.log(`  用户页面  http://127.0.0.1:3977/app`);
console.log(`  运营控制台 http://127.0.0.1:3977/`);
console.log(`  演示账号  demo@team.local / demo-password-123`);
console.log(`  Runtime   DemoAgentRuntime（不发真实模型请求）`);
console.log("按 Ctrl+C 停止。");

await new Promise(() => undefined);
