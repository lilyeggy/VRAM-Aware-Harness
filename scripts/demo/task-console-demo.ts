import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarnessProcess } from "../../src/main.ts";
import { loadHarnessConfig } from "../../src/app/harness-config.ts";
import { DemoAgentRuntime } from "./demo-agent-runtime.ts";

/**
 * Local interview/demo entrypoint. It intentionally replaces only the model
 * runtime; HTTP auth, workspaces, queueing, persistence and the same-origin
 * Task Console are the real application composition.
 */
const directory = mkdtempSync(join(tmpdir(), "vram-aware-task-console-"));
const apiKey = "demo-local-key-2026-not-for-production";
const config = loadHarnessConfig({
    VLLM_MODEL_ID: "demo-model",
    HARNESS_DATABASE_PATH: join(directory, "harness.sqlite"),
    HARNESS_WORKSPACE_ROOT: join(directory, "workspaces"),
    HARNESS_BOOTSTRAP_API_KEY: apiKey,
    HARNESS_PUMP_INTERVAL_MS: "60000",
    HARNESS_PORT: process.env.HARNESS_DEMO_PORT ?? "3000",
});
const running = await startHarnessProcess({
    config,
    compositionDependencies: {
        runtime: new DemoAgentRuntime(),
    },
    installSignalHandlers: false,
});

console.log([
    "VRAM-Aware Harness · local Task Console demo",
    `打开：${running.baseUrl}`,
    `API Key：${apiKey}`,
    "此入口仅演示真实 HTTP/认证/Workspace/调度/结果闭环；使用 Fake Runtime，不代表 Docker 或模型性能证据。",
    "按 Ctrl+C 停止并删除临时数据。",
].join("\n"));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        void (async () => {
            await running.close();
            rmSync(directory, { recursive: true, force: true });
        })();
    });
}

