import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

/**
 * §9.9 v1.5 Phase 5 F4：同 idempotencyKey 并发重放只创建一个 Run。
 *
 * 真机曾出现重复入队 500（RunScheduler.submit 在幂等命中后仍 enqueue），
 * 这里在组合根上固化回归。
 */

test("同 idempotencyKey 并发提交只创建一个 Run 且都返回同一 id", async () => {
    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "fake-model",
        ...tempWorkspaceEnv(),
        HARNESS_DATABASE_PATH: ":memory:",
        HARNESS_PUMP_INTERVAL_MS: "60000",
        HARNESS_SANDBOX_PROVIDER: "managed-local",
        HARNESS_WORKER_ISOLATION: "in-process",
    });
    const composition = await createHarnessApplication(config, {
        runtime: new FakeAgentRuntime(),
    });

    try {
        await composition.application.start();
        const workspacePath = mkdtempSync(join(tmpdir(), "harness-idem-ws-"));
        const submitted = await Promise.all(
            Array.from({ length: 8 }, () => Promise.resolve().then(() =>
                composition.application.submitRun({
                    tenantId: "tenant-idempotency",
                    harnessSessionId: "session-idempotency",
                    userInput: "并发幂等提交",
                    workspacePath,
                    idempotencyKey: "phase5-idempotency-key",
                }),
            )),
        );

        const uniqueRunIds = new Set(submitted.map((run) => run.id));
        expect(uniqueRunIds.size).toBe(1);
        expect(composition.runStore
            .listForTenant("tenant-idempotency", 50)).toHaveLength(1);
        expect(composition.runStore
            .findByTenantIdempotencyKey(
                "tenant-idempotency",
                "phase5-idempotency-key",
            )?.id).toBe(submitted[0]?.id);
    } finally {
        await composition.close();
    }
});
