import { expect, test } from "bun:test";

import { RunService } from "../../src/runs/run-service.ts";
import { RunStore } from "../../src/runs/runstore.ts";
import type { RunWorkspaceResultCoordinator } from "../../src/workspaces/run-workspace-result.ts";
import { openHarnessDatabase } from "../../src/storage/database.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";

test("Phase 3：终态后写入 RUN_ARTIFACTS_READY 事件", async () => {
    const db = openHarnessDatabase(":memory:");
    try {
        const store = new RunStore(db);
        const workspaceResults = {
            captureBefore: async () => {},
            captureAfter: async () => null,
            captureArtifacts: async () => [],
        } as unknown as RunWorkspaceResultCoordinator;
        const service = new RunService(
            store,
            new FakeAgentRuntime(),
            undefined,
            undefined,
            workspaceResults,
        );
        const run = service.createQueuedRun({
            tenantId: "tenant-a",
            harnessSessionId: "session-a",
            userInput: "artifacts",
            workspacePath: "/tmp/a",
        });

        const result = await service.executeQueuedRun(run.id);

        expect(result.status).toBe("COMPLETED");
        expect(store.listEvents(run.id).map((event) => event.type)).toEqual([
            "RUN_CREATED",
            "RUN_STARTED",
            "RUN_COMPLETED",
            "RUN_ARTIFACTS_READY",
        ]);
    } finally {
        db.close();
    }
});
