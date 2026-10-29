import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import type { SandboxProvider } from "../../src/sandbox/sandbox-provider.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

for (const input of ["chat", "tools"] as const) {
    test(`实际 Run 和 Worker IPC：${input} ${input === "chat" ? "不申请" : "仅申请一次"} Sandbox`, async () => {
        let creates = 0, closes = 0;
        const sandboxProvider: SandboxProvider = {
            async create(input) {
                creates++;
                return { id: input.id, workspacePath: input.workspacePath, secretNames: [], mountRoot: input.workspacePath,
                    containerWorkdir: input.workspacePath, withSecrets: (f) => f({}),
                    enforcement: { toolExecutionBoundary: "HOST", filesystemIsolation: false, processIsolation: false,
                        networkPolicyEnforced: false, cpuLimitEnforced: false, memoryLimitEnforced: false,
                        diskLimitEnforced: false, pidLimitEnforced: false, workspaceScope: "RUN" } };
            },
            async terminate() { closes++; }, subscribe() { return () => {}; },
        };
        const config = loadHarnessConfig({ VLLM_MODEL_ID: "fake-model", ...tempWorkspaceEnv(),
            HARNESS_DATABASE_PATH: ":memory:", HARNESS_PUMP_INTERVAL_MS: "60000", HARNESS_RUN_MAX_ATTEMPTS: "1",
            HARNESS_WORKER_ISOLATION: "process", HARNESS_WORKER_SCRIPT_PATH: resolve("tests/runtime/fixtures/lazy-sandbox-worker.ts") });
        const app = await createHarnessApplication(config, { sandboxProvider });
        try {
            await app.application.start();
            const workspace = app.workspaceService.create("lazy-user", "lazy");
            const run = app.application.submitRun({ userId: "lazy-user", harnessSessionId: `session-${input}`, userInput: input,
                workspacePath: workspace.rootPath, workspaceId: workspace.id });
            await app.queuePump.tick();
            expect(app.runStore.get(run.id)?.status).toBe("COMPLETED");
            expect(creates).toBe(input === "chat" ? 0 : 1);
            expect(closes).toBe(creates);
            expect(app.attemptStore.listForRun(run.id)[0]?.sandboxId === null).toBe(input === "chat");
            expect(app.runStore.listEvents(run.id).some(e => e.type === "WORKSPACE_COMMIT_STARTED")).toBe(input === "tools");
        } finally { await app.close(); }
    });
}
