import { startHarnessProcess } from "../src/main.ts";

const observer = {
    async observe() {
        return {
            ok: true as const,
            snapshot: {
                snapshotId: "live-" + Date.now(),
                observedAt: new Date().toISOString(),
                sources: ["FAKE" as const],
                gpuTotalMemoryMiB: 24576,
                gpuUsedMemoryMiB: 1024,
                gpuFreeMemoryMiB: 23552,
                gpuUtilizationPercent: 5,
                runningRequests: 0,
                waitingRequests: 0,
                kvCacheUsagePercent: 5,
                inputTokensPerSecond: null,
                outputTokensPerSecond: null,
            },
        };
    },
};

const running = await startHarnessProcess({
    compositionDependencies: { resourceObserver: observer },
});
console.log(JSON.stringify({
    event: "started",
    baseUrl: running.baseUrl,
    sandboxProvider: running.config.sandboxProvider,
    sandboxProfile: running.config.sandboxProfile,
    sandboxRuntime: running.config.sandboxRuntime,
    workerIsolation: running.config.workerIsolation,
    piProvider: running.config.piProvider,
    piModelId: running.config.piModelId,
    databasePath: running.config.databasePath,
}, null, 2));
