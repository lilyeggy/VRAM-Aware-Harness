import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessApplication } from "../../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import type { SandboxProvider } from "../../src/sandbox/sandbox-provider.ts";
import { tempWorkspaceEnv } from "../support/temp-workspace-root.ts";

test("真实 Pi Worker：纯对话零 Sandbox，读取工作区时申请并回收", async () => {
    const server = Bun.serve({ port: 0, async fetch(req) {
        const body = await req.json() as any;
        const messages = body.messages as any[];
        const isTool = JSON.stringify(messages).includes("CALL_READ") && !messages.some(m => m.role === "tool");
        const id = "chatcmpl-test";
        const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        const content = isTool
            ? chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: '{"path":"hello.txt"}' } }] }) + chunk({}, "tool_calls")
            : chunk({ role: "assistant", content: "完成" }) + chunk({}, "stop");
        return new Response(content + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } });
    const dir = mkdtempSync(join(tmpdir(), "lazy-real-worker-"));
    const models = join(dir, "models.json");
    writeFileSync(models, JSON.stringify({ providers: { "local-vllm": { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test", api: "openai-completions", models: [{ id: "mock-model" }] } } }));
    let creates = 0, closes = 0;
    const sandboxProvider: SandboxProvider = { async create(input) { creates++; return {
        id: input.id, workspacePath: input.workspacePath, secretNames: [], mountRoot: input.workspacePath,
        containerWorkdir: input.workspacePath, withSecrets: f => f({}), enforcement: {
            toolExecutionBoundary: "HOST", filesystemIsolation: false, processIsolation: false, networkPolicyEnforced: false,
            cpuLimitEnforced: false, memoryLimitEnforced: false, diskLimitEnforced: false, pidLimitEnforced: false, workspaceScope: "RUN" } };
    }, async terminate() { closes++; }, subscribe() { return () => {}; } };
    const config = loadHarnessConfig({ VLLM_MODEL_ID: "mock-model", ...tempWorkspaceEnv(), HARNESS_DATABASE_PATH: ":memory:",
        HARNESS_PUMP_INTERVAL_MS: "60000", HARNESS_RUN_MAX_ATTEMPTS: "1", HARNESS_WORKER_ISOLATION: "process",
        PI_MODELS_PATH: models, HARNESS_WORKER_PI_MODELS_PATH: models, PI_TOOLS: "read" });
    const app = await createHarnessApplication(config, { sandboxProvider });
    try {
        await app.application.start();
        const workspace = app.workspaceService.create("real-worker", "test");
        writeFileSync(join(workspace.rootPath, "hello.txt"), "hello from workspace");
        for (const [index, input] of ["CHAT", "CALL_READ"].entries()) {
            const run = app.application.submitRun({ userId: "real-worker", harnessSessionId: `test-${index}`, userInput: input,
                workspaceId: workspace.id, workspacePath: workspace.rootPath });
            await app.queuePump.tick();
            expect(app.runStore.get(run.id)?.status).toBe("COMPLETED");
            expect(creates).toBe(index);
            expect(closes).toBe(index);
            if (index) expect(app.runStore.listEvents(run.id).some(e => e.type === "TOOL_COMPLETED")).toBe(true);
        }
    } finally { await app.close(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30000);
