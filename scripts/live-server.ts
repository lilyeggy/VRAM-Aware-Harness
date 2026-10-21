import { startHarnessProcess } from "../src/main.ts";

const running = await startHarnessProcess();
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
