import { expect, test } from "bun:test";
import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import type { SandboxProvider } from "../../src/sandbox/sandbox-provider.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

for (const failFinalization of [false, true]) {
    test(`Run 在沙箱交付${failFinalization ? "失败" : "成功"}后才结算`, async () => {
        let duringFinalization = "";
        let runId = "";
        let getStatus: () => string | undefined = () => undefined;
        const sandboxProvider: SandboxProvider = {
            async create(input) {
                runId = input.runId;
                return {
                    id: input.id, workspacePath: input.workspacePath, secretNames: [],
                    mountRoot: input.workspacePath, containerWorkdir: input.workspacePath,
                    enforcement: {
                        toolExecutionBoundary: "HOST", filesystemIsolation: false,
                        processIsolation: false, networkPolicyEnforced: true,
                        cpuLimitEnforced: false, memoryLimitEnforced: false,
                        diskLimitEnforced: false, pidLimitEnforced: false, workspaceScope: "RUN",
                    },
                    withSecrets: (callback) => callback({}),
                };
            },
            async terminate() {
                duringFinalization = getStatus() ?? "missing";
                if (failFinalization) throw new Error("workspace finalization failed");
            },
            subscribe() { return () => {}; },
        };
        const config = loadHarnessConfig({
            VLLM_MODEL_ID: "fake-model", ...tempWorkspaceEnv(),
            HARNESS_DATABASE_PATH: ":memory:", HARNESS_PUMP_INTERVAL_MS: "60000",
            HARNESS_RUN_MAX_ATTEMPTS: "1",
        });
        const composition = await createHarnessApplication(config, { runtime: new FakeAgentRuntime(), sandboxProvider });
        getStatus = () => composition.runStore.get(runId)?.status;
        try {
            await composition.application.start();
            const workspace = composition.workspaceService.create("finalization-user", "finalization");
            const run = composition.application.submitRun({
                userId: "finalization-user", harnessSessionId: "finalization-session", userInput: "test",
                workspacePath: workspace.rootPath, workspaceId: workspace.id,
            });
            await composition.queuePump.tick();
            expect(duringFinalization).toBe("RUNNING");
            expect(composition.runStore.get(run.id)?.status).toBe(failFinalization ? "INTERRUPTED" : "COMPLETED");
            expect(composition.attemptStore.listForRun(run.id)[0]?.status).toBe(failFinalization ? "FAILED" : "SUCCEEDED");
            expect(composition.runStore.listEvents(run.id).some((event) => event.type === "RUN_COMPLETED"))
                .toBe(!failFinalization);
        } finally { await composition.close(); }
    });
}
