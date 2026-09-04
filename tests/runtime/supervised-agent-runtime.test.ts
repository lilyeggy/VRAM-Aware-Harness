import { expect, test } from "bun:test";

import type { AgentRuntime, RuntimeStartRequest } from "../../src/runtime/agent-runtime.ts";
import { RuntimeExecutionTimeoutError, SupervisedAgentRuntime } from "../../src/runtime/supervised-agent-runtime.ts";
import type { SandboxProvider } from "../../src/sandbox/sandbox-provider.ts";

const request: RuntimeStartRequest = {
    run: { runId: "run-1", tenantId: "tenant-1", harnessSessionId: "session-1", workspacePath: "/tmp/workspace" },
    input: "work",
    execution: {
        attemptId: "attempt-1", policySnapshotId: "policy-1", sandboxId: "sandbox-1",
        sandboxEnforcement: {
            toolExecutionBoundary: "SANDBOX", filesystemIsolation: true,
            processIsolation: true, networkPolicyEnforced: true,
            cpuLimitEnforced: false, memoryLimitEnforced: false,
            diskLimitEnforced: false, pidLimitEnforced: true,
        },
        runtimeConfig: { runtimeKind: "PI", provider: "test", modelId: "model", tools: [], skills: [] },
    },
};

function runtime(start: () => Promise<void>, interrupt: () => Promise<void>): AgentRuntime {
    return { start, resume: async () => {}, interrupt, subscribe: () => () => {} };
}

test("Runtime 超时后先请求中断，再强制终止 Sandbox", async () => {
    const events: string[] = [];
    const supervised = new SupervisedAgentRuntime(
        runtime(() => new Promise(() => {}), async () => { events.push("interrupt"); }),
        { async terminate(id: string) { events.push(`terminate:${id}`); } } as unknown as SandboxProvider,
        { executionTimeoutMs: 5, interruptGraceMs: 5 },
    );
    await expect(supervised.start(request)).rejects.toBeInstanceOf(RuntimeExecutionTimeoutError);
    expect(events).toEqual(["interrupt", "terminate:sandbox-1"]);
});

test("显式中断未使 Runtime 在宽限期内退出时强制终止 Sandbox", async () => {
    const terminated: string[] = [];
    const supervised = new SupervisedAgentRuntime(
        runtime(() => new Promise(() => {}), async () => {}),
        { async terminate(id: string) { terminated.push(id); } } as unknown as SandboxProvider,
        { executionTimeoutMs: 1_000, interruptGraceMs: 5 },
    );
    const running = supervised.start(request).catch(() => undefined);
    await supervised.interrupt("run-1");
    expect(terminated).toEqual(["sandbox-1"]);
    void running;
});

test("正常完成不会中断或清理 Sandbox", async () => {
    let interrupts = 0;
    let terminations = 0;
    const supervised = new SupervisedAgentRuntime(
        runtime(async () => {}, async () => { interrupts += 1; }),
        { async terminate() { terminations += 1; } } as unknown as SandboxProvider,
        { executionTimeoutMs: 50, interruptGraceMs: 5 },
    );
    await supervised.start(request);
    expect({ interrupts, terminations }).toEqual({ interrupts: 0, terminations: 0 });
});
