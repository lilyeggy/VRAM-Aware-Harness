import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { WorkerProcessAgentRuntime } from "../../src/runtime/worker-process-runtime.ts";
import type { WorkerToolGatewayBridge } from "../../src/runtime/worker-process-runtime.ts";
import type {
    ExecuteToolInput,
} from "../../src/tools/tool-gateway.ts";
import type { ToolExecution } from "../../src/tools/tool-execution.ts";
import type {
    RuntimeEvent,
    RuntimeStartRequest,
} from "../../src/runtime/agent-runtime.ts";
import type { WorkerRuntimeConfig } from "../../src/worker/worker-protocol.ts";

const WORKER_MAIN = resolve(process.cwd(), "src/worker/worker-main.ts");

function createWorkerConfig(): WorkerRuntimeConfig {
    return {
        piProvider: "local-vllm",
        piModelId: "mock-model",
        piTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        piModelsPath: ".pi/spike/models.json",
        sandboxProvider: "managed-local",
        sandboxProfile: "development",
        sandboxRuntime: "runc",
        containerImage: "alpine:3.20",
        containerUserId: 65532,
    };
}

function createSampleStartRequest(runId: string): RuntimeStartRequest {
    return {
        run: {
            runId,
            tenantId: "tenant-governance",
            harnessSessionId: "session-governance",
            workspacePath: "/tmp/workspace-governance",
            thinkingLevel: "off",
        },
        input: "Test governed tool invocation",
        execution: {
            attemptId: "attempt-1",
            policySnapshotId: "policy-1",
            sandboxId: "sandbox-1",
            sandboxEnforcement: {
                toolExecutionBoundary: "HOST",
                filesystemIsolation: false,
                processIsolation: false,
                networkPolicyEnforced: false,
                cpuLimitEnforced: false,
                memoryLimitEnforced: false,
                diskLimitEnforced: false,
                pidLimitEnforced: false,
            },
            runtimeConfig: {
                runtimeKind: "PI",
                provider: "local-vllm",
                modelId: "mock-model",
                tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
                skills: [],
            },
        },
    };
}

interface RecordingBridge extends WorkerToolGatewayBridge {
    readonly prepareCalls: ExecuteToolInput[];
    readonly completeCalls: Array<{ executionId: string; ok: boolean }>;
}

function createRecordingBridge(decision: "PREPARED" | "REUSE"): RecordingBridge {
    const bridge: RecordingBridge = {
        prepareCalls: [],
        completeCalls: [],
        prepare(input: ExecuteToolInput) {
            bridge.prepareCalls.push(input);
            if (decision === "REUSE") {
                return { kind: "REUSE", result: { cached: true } };
            }
            const execution: ToolExecution = {
                id: `exec-${bridge.prepareCalls.length}`,
                runId: input.runId,
                toolCallId: input.toolCallId,
                toolName: input.toolName,
                arguments: input.arguments,
                effect: input.effect,
                status: "PREPARED",
                result: null,
                errorMessage: null,
                createdAt: new Date().toISOString(),
                finishedAt: null,
            };
            return { kind: "PREPARED", execution };
        },
        complete(_input: ExecuteToolInput, execution: ToolExecution, outcome) {
            bridge.completeCalls.push({ executionId: execution.id, ok: outcome.ok });
        },
    };
    return bridge;
}

describe("Worker 工具治理桥接（真实子进程）", () => {
    test("未装配治理桥时 fail-closed：工具调用被 Master 拒绝，Run 以失败收场", async () => {
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: { HARNESS_WORKER_SIMULATE: "tool_roundtrip" },
            workerConfig: createWorkerConfig(),
        });

        const runId = `run-governance-deny-${Date.now()}`;
        const events: RuntimeEvent[] = [];
        runtime.subscribe(runId, (event) => events.push(event));

        await expect(runtime.start(createSampleStartRequest(runId))).rejects.toThrow("工具治理桥");

        // Worker 已发出 agent_started（真实工具执行前），随后以失败终态收场——
        // 失败以 RUN_FAILED 终态形式返回，不存在绕过治理的执行。
        expect(events.some((event) => event.type === "agent_started")).toBe(true);
    });

    test("装配治理桥后：prepare 在 Master 侧记账，complete 收到成功结果", async () => {
        const bridge = createRecordingBridge("PREPARED");
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: { HARNESS_WORKER_SIMULATE: "tool_roundtrip" },
            workerConfig: createWorkerConfig(),
            toolGatewayBridge: bridge,
            getRunEventSequence: () => 7,
        });

        const runId = `run-governance-ok-${Date.now()}`;
        const events: RuntimeEvent[] = [];
        runtime.subscribe(runId, (event) => events.push(event));

        await runtime.start(createSampleStartRequest(runId));

        expect(events.some((event) => event.type === "agent_started")).toBe(true);
        expect(events.some((event) => event.type === "agent_completed")).toBe(true);

        expect(bridge.prepareCalls).toHaveLength(1);
        expect(bridge.prepareCalls[0]!.toolCallId).toBe("simulate-governed-tool-call-1");
        expect(bridge.prepareCalls[0]!.effect).toBe("UNKNOWN_EFFECT");
        // 事件序号由 Master 侧注入，覆盖 Worker 自报的 0。
        expect(bridge.prepareCalls[0]!.lastEventSequence).toBe(7);

        expect(bridge.completeCalls).toEqual([{ executionId: "exec-1", ok: true }]);
    });

    test("REUSE 裁决：Worker 直接复用缓存结果，不再回报 COMPLETE", async () => {
        const bridge = createRecordingBridge("REUSE");
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            extraEnv: { HARNESS_WORKER_SIMULATE: "tool_roundtrip" },
            workerConfig: createWorkerConfig(),
            toolGatewayBridge: bridge,
        });

        const runId = `run-governance-reuse-${Date.now()}`;
        runtime.subscribe(runId, () => undefined);

        await runtime.start(createSampleStartRequest(runId));

        expect(bridge.prepareCalls).toHaveLength(1);
        expect(bridge.completeCalls).toHaveLength(0);
    });
});
