import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { WorkerProcessAgentRuntime } from "../../src/runtime/worker-process-runtime.ts";
import {
    isForceKillableRuntime,
    type AgentRuntime,
    type RuntimeStartRequest,
} from "../../src/runtime/agent-runtime.ts";
import {
    RuntimeExecutionTimeoutError,
    SupervisedAgentRuntime,
} from "../../src/runtime/supervised-agent-runtime.ts";
import type { SandboxProvider } from "../../src/sandbox/sandbox-provider.ts";

const WORKER_MAIN = resolve(process.cwd(), "src/worker/worker-main.ts");

function makeRequest(runId: string, sandboxId?: string): RuntimeStartRequest {
    return {
        run: {
            runId,
            tenantId: "tenant-pillar3",
            harnessSessionId: "session-pillar3",
            workspacePath: "/tmp/pillar3-workspace",
        },
        input: "never ending work",
        ...(sandboxId === undefined
            ? {}
            : {
                execution: {
                    attemptId: "attempt-1",
                    policySnapshotId: "policy-1",
                    sandboxId,
                    sandboxEnforcement: {
                        toolExecutionBoundary: "SANDBOX",
                        filesystemIsolation: true,
                        processIsolation: true,
                        networkPolicyEnforced: true,
                        cpuLimitEnforced: false,
                        memoryLimitEnforced: false,
                        diskLimitEnforced: false,
                        pidLimitEnforced: true,
                    },
                    runtimeConfig: {
                        runtimeKind: "PI" as const,
                        provider: "local-vllm",
                        modelId: "mock-model",
                        tools: ["bash"],
                        skills: [],
                    },
                },
            }),
    };
}

describe("支柱 3：执行超时 → 优雅中断 → 物理强杀", () => {
    function makeSupervisor(
        inner: AgentRuntime,
        terminateLog: string[],
    ): SupervisedAgentRuntime {
        return new SupervisedAgentRuntime(
            inner,
            {
                async terminate(id: string) {
                    terminateLog.push(id);
                },
            } as unknown as SandboxProvider,
            { executionTimeoutMs: 30, interruptGraceMs: 20 },
        );
    }

    test("超期不退出：先优雅中断，宽限期后 forceKill + 沙箱 terminate", async () => {
        const events: string[] = [];
        const inner: AgentRuntime & { forceKill(runId: string): Promise<void> } = {
            start: () => new Promise(() => {}),
            resume: async () => {},
            interrupt: async () => {
                events.push("interrupt");
            },
            subscribe: () => () => {},
            forceKill: async (runId: string) => {
                events.push(`forceKill:${runId}`);
            },
        };
        expect(isForceKillableRuntime(inner)).toBe(true);

        const terminateLog: string[] = [];
        const supervised = makeSupervisor(inner, terminateLog);

        await expect(
            supervised.start(makeRequest("run-timeout", "sandbox-1")),
        ).rejects.toBeInstanceOf(RuntimeExecutionTimeoutError);

        // 两级阶梯完整：优雅中断 → 物理强杀 → 容器强制清理。
        expect(events).toEqual(["interrupt", "forceKill:run-timeout"]);
        expect(terminateLog).toEqual(["sandbox-1"]);
    });

    test("宽限期内退出：不升级强杀，也不强制清理沙箱", async () => {
        const events: string[] = [];
        let forceKillCalls = 0;
        let settleRuntime!: () => void;
        const inner: AgentRuntime & { forceKill(runId: string): Promise<void> } = {
            start: () =>
                new Promise<void>((resolve) => {
                    settleRuntime = resolve;
                }),
            resume: async () => {},
            interrupt: async () => {
                events.push("interrupt");
                // 优雅中断立即生效：执行体随即结束。
                settleRuntime();
            },
            subscribe: () => () => {},
            forceKill: async () => {
                forceKillCalls += 1;
            },
        };

        const terminateLog: string[] = [];
        const supervised = makeSupervisor(inner, terminateLog);
        await expect(
            supervised.start(makeRequest("run-graceful")),
        ).rejects.toBeInstanceOf(RuntimeExecutionTimeoutError);
        expect(events).toEqual(["interrupt"]);
        expect(forceKillCalls).toBe(0);
        expect(terminateLog).toEqual([]);
    });

    test("显式中断宽限期未退出：forceKill + 强制清理 + forceStop", async () => {
        const events: string[] = [];
        const inner: AgentRuntime & { forceKill(runId: string): Promise<void> } = {
            start: () => new Promise(() => {}),
            resume: async () => {},
            interrupt: async () => {
                events.push("interrupt");
            },
            subscribe: () => () => {},
            forceKill: async () => {
                events.push("forceKill");
            },
        };
        const terminateLog: string[] = [];
        const supervised = makeSupervisor(inner, terminateLog);

        const running = supervised
            .start(makeRequest("run-stubborn", "sandbox-1"))
            .catch(() => undefined);
        await supervised.interrupt("run-stubborn");

        expect(events).toEqual(["interrupt", "forceKill"]);
        expect(terminateLog).toEqual(["sandbox-1"]);
        await running;
    });

    test("inner 不具备强杀能力时保持旧行为：仅优雅中断 + 沙箱清理", async () => {
        const events: string[] = [];
        const inner: AgentRuntime = {
            start: () => new Promise(() => {}),
            resume: async () => {},
            interrupt: async () => {
                events.push("interrupt");
            },
            subscribe: () => () => {},
        };
        expect(isForceKillableRuntime(inner)).toBe(false);

        const terminateLog: string[] = [];
        const supervised = makeSupervisor(inner, terminateLog);
        await expect(
            supervised.start(makeRequest("run-legacy", "sandbox-2")),
        ).rejects.toBeInstanceOf(RuntimeExecutionTimeoutError);
        expect(events).toEqual(["interrupt"]);
        expect(terminateLog).toEqual(["sandbox-2"]);
    });
});

describe("支柱 3：Worker 子进程物理强杀（SIGKILL + 孤儿容器清理）", () => {
    test("hang_stubborn Worker 被 forceKill 后进程死亡并触发沙箱强制清理", async () => {
        const cleanedSandboxIds: string[] = [];
        const runtime = new WorkerProcessAgentRuntime({
            workerScriptPath: WORKER_MAIN,
            interruptGraceMs: 200,
            extraEnv: { HARNESS_WORKER_SIMULATE: "hang_stubborn" },
            orphanSandboxCleaner: async (sandboxId: string) => {
                cleanedSandboxIds.push(sandboxId);
            },
        });

        const runId = `run-kill-${Date.now()}`;
        const startOutcome = runtime
            .start(makeRequest(runId, "sandbox-hardkill"))
            .then(
                () => "resolved-unexpectedly",
                (error: Error) => error.message,
            );

        // 等 Worker 完成握手并进入 hang_stubborn。
        await new Promise((resolve) => setTimeout(resolve, 400));

        await runtime.forceKill(runId);

        const outcome = await startOutcome;
        expect(outcome).toContain("WORKER_CRASHED");

        // SIGKILL 后子进程异常退出 → 孤儿沙箱强制清理被触发。
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(cleanedSandboxIds).toEqual(["sandbox-hardkill"]);
    });
});
