/** Real Broker/Firecracker check driven by a deterministic local model endpoint. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarnessApplication } from "../src/app/create-harness-application.ts";
import { loadHarnessConfig } from "../src/app/harness-config.ts";
import { BrokerSandboxProvider } from "../src/sandbox/broker/broker-sandbox-provider.ts";

const root = process.env.LAZY_TEST_ROOT;
if (!root) throw new Error("LAZY_TEST_ROOT is required");
mkdirSync(root, { recursive: true });
let observedToolResponse = false;
let observedReadContent = false;
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { messages: Array<{ role?: string }> };
    const messages = body.messages;
    const serialized = JSON.stringify(messages);
    const toolCount = messages.filter(m => m.role === "tool").length;
    const toolMessage = toolCount > 0;
    if (toolMessage) observedToolResponse = true;
    if (toolMessage && JSON.stringify(messages.filter(m => m.role === "tool")).includes("firecracker-commit-proof")) observedReadContent = true;
    const isSequence = serialized.includes("WRITE_THEN_READ");
    const isWrite = (serialized.includes("WRITE_PROOF") || isSequence) && toolCount === 0;
    const isRead = (serialized.includes("READ_PROOF") && toolCount === 0) || (isSequence && toolCount === 1);
    console.log("MODEL_STEP", JSON.stringify({isSequence, toolCount, isWrite, isRead}));
    const delta = isWrite || isRead ? { role: "assistant", tool_calls: [{ index: 0, id: isRead ? "call_read_proof" : "call_write_proof", type: "function", function: {
        name: isWrite ? "write" : "read", arguments: JSON.stringify(isWrite ? { path: "lazy-proof.txt", content: "firecracker-commit-proof\n" } : { path: "lazy-proof.txt" }),
    } }] } : { role: "assistant", content: "done" };
    const chunk = (value: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "chatcmpl-lazy-live", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, isWrite || isRead ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });
const models = join(root, "models.json");
writeFileSync(models, JSON.stringify({ providers: { "local-vllm": { baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: "test", api: "openai-completions", models: [{ id: "mock-model" }] } } }), { mode: 0o644 });
const config = loadHarnessConfig({ ...process.env, LAZY_TEST_ROOT: root,
    HARNESS_DATABASE_PATH: join(root, "harness.sqlite"), HARNESS_WORKSPACE_ROOT: join(root, "workspaces"),
    HARNESS_PUMP_INTERVAL_MS: "60000", HARNESS_RUN_MAX_ATTEMPTS: "1", HARNESS_WORKER_ISOLATION: "systemd",
    PI_PROVIDER: "local-vllm", PI_MODEL_ID: "mock-model", VLLM_MODEL_ID: "mock-model",
    PI_MODELS_PATH: models, HARNESS_WORKER_PI_MODELS_PATH: models, PI_TOOLS: "read,write",
});
const app = await createHarnessApplication(config);
try {
    await app.application.start();
    const workspace = app.workspaceService.create("lazy-live-user", "lazy-live-workspace");
    console.log("WORKSPACE", workspace.id);
    for (const [index, prompt] of ["CHAT_ONLY", "WRITE_PROOF", "READ_PROOF", "WRITE_THEN_READ"].entries()) {
        observedToolResponse = false;
        observedReadContent = false;
        const run = app.application.submitRun({ userId: "lazy-live-user", harnessSessionId: `lazy-live-${index}`,
            userInput: prompt, workspacePath: workspace.rootPath, workspaceId: workspace.id });
        await app.queuePump.tick();
        const state = app.runStore.get(run.id);
        const attempt = app.attemptStore.listForRun(run.id)[0];
        const events = app.runStore.listEvents(run.id).map(e => e.type);
        const record = attempt?.sandboxId ? app.sandboxStore.get(attempt.sandboxId) : null;
        const receipt = attempt?.sandboxId && app.sandboxProvider instanceof BrokerSandboxProvider
            ? await app.sandboxProvider.getCommitReceipt(attempt.sandboxId) : null;
        console.log("RESULT", JSON.stringify({ prompt, runId: run.id, status: state?.status, attempt: attempt?.status,
            sandboxId: attempt?.sandboxId, sandboxStatus: record?.status, runtime: record?.runtime,
            toolResponse: observedToolResponse, events: events.filter(x => x.includes("TOOL") || x.includes("WORKSPACE_COMMIT")), receipt }));
        if (state?.status !== "COMPLETED" || attempt?.status !== "SUCCEEDED") throw new Error(`${prompt} run failed`);
        if ((index === 0) !== (attempt?.sandboxId === null)) throw new Error(`${prompt} unexpected sandbox allocation`);
        if (index && (!observedToolResponse || events.includes("TOOL_FAILED") || record?.status !== "TERMINATED" || receipt?.status !== "COMMITTED")) throw new Error(`${prompt} missing tool/termination/receipt`);
        if (index >= 2 && !observedReadContent) throw new Error(`${prompt} did not return expected content`);
        if (index === 3 && events.filter(e => e === "TOOL_COMPLETED").length !== 2) throw new Error("expected two successful tools in one Run");
        if (index && readFileSync(join(workspace.rootPath, "lazy-proof.txt"), "utf8") !== "firecracker-commit-proof\n") throw new Error("workspace result did not persist");
    }
    console.log("LAZY_LIVE_PASS");
} finally {
    await app.close();
    model.stop(true);
}
