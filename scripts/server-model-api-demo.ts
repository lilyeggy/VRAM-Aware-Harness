import type { ResourceObserver } from "../src/resources/resource-observer.ts";
import { startHarnessProcess } from "../src/main.ts";

/**
 * Server demo with a real OpenAI-compatible Model API, but without vLLM metrics.
 *
 * Most external OpenAI-compatible endpoints (e.g. opencode) do not expose a
 * vLLM /metrics feed. Harness' default VllmResourceObserver would therefore
 * always observe UNKNOWN and keep every run queued (fail-closed). This demo
 * injects a deterministic NORMAL observer so the true Pi -> model -> tool ->
 * runsc sandbox path can run end to end.
 *
 * This is an explicit, labeled demo: the injected observer is not a real GPU/
 * VRAM observation, so it must not be presented as VRAM-aware admission proof.
 */
class ServerDemoResourceObserver implements ResourceObserver {
    observeCallCount = 0;

    async observe() {
        this.observeCallCount += 1;
        return {
            ok: true as const,
            snapshot: {
                snapshotId: `server-demo-normal-${this.observeCallCount}`,
                observedAt: new Date().toISOString(),
                sources: ["FAKE"] as const,
                gpuTotalMemoryMiB: 100,
                gpuUsedMemoryMiB: 20,
                gpuFreeMemoryMiB: 80,
                gpuUtilizationPercent: 20,
                runningRequests: 0,
                waitingRequests: 0,
                kvCacheUsagePercent: 20,
                inputTokensPerSecond: 0,
                outputTokensPerSecond: 0,
            },
        };
    }
}

const running = await startHarnessProcess({
    compositionDependencies: {
        resourceObserver: new ServerDemoResourceObserver(),
    },
});

console.log("");
console.log(`真实 Pi + 外部模型 + runsc Sandbox 已启动: ${running.baseUrl}`);
console.log(`Bootstrap API Key: ${running.config.bootstrapApiKey}`);
console.log(`模型: ${running.config.piProvider}/${running.config.piModelId}`);
console.log("警告：资源观察器是 Fake NORMAL（外部模型 API 无 vLLM metrics）。");
console.log("这不是 VRAM 显存准入的真机证据；GPU/vLLM 准入仍需 A6000。");
console.log("按 Ctrl+C 停止。");

// Keep the server process alive; signal handlers in startHarnessProcess
// perform a safe shutdown.
await new Promise(() => undefined);
