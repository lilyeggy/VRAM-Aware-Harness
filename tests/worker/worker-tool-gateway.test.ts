import { describe, expect, test } from "bun:test";

import { WorkerToolGateway } from "../../src/worker/worker-tool-gateway.ts";
import {
    createToolCompleteResponseMessage,
    createToolPrepareResponseMessage,
    type ToolCompleteRequestMessage,
    type ToolPrepareRequestMessage,
    type WorkerToMasterMessage,
} from "../../src/worker/worker-protocol.ts";
import type { ExecuteToolInput } from "../../src/tools/tool-gateway.ts";

function createInput(overrides: Partial<ExecuteToolInput> = {}): ExecuteToolInput {
    return {
        runId: "run-gateway-1",
        toolCallId: "tool-call-1",
        toolName: "write",
        arguments: { path: "a.txt" },
        effect: "UNKNOWN_EFFECT",
        runtimeSessionRef: "session-ref-1",
        lastEventSequence: 0,
        ...overrides,
    };
}

class GatewayHarness {
    readonly sent: WorkerToMasterMessage[] = [];
    readonly gateway: WorkerToolGateway;

    constructor(timeoutMs = 500) {
        this.gateway = new WorkerToolGateway(
            (msg) => {
                this.sent.push(msg);
                // Master 假实现：COMPLETE 请求立即确认，模拟真实记账落库后的应答。
                if (msg.type === "TOOL_COMPLETE_REQUEST") {
                    this.gateway.handleMasterMessage(
                        createToolCompleteResponseMessage(msg.runId, msg.requestId, true),
                    );
                }
            },
            { timeoutMs },
        );
    }

    lastPrepareRequest(): ToolPrepareRequestMessage {
        const request = this.sent.find((msg) => msg.type === "TOOL_PREPARE_REQUEST");
        if (!request) throw new Error("没有发出 TOOL_PREPARE_REQUEST");
        return request as ToolPrepareRequestMessage;
    }

    completeRequests(): ToolCompleteRequestMessage[] {
        return this.sent.filter(
            (msg): msg is ToolCompleteRequestMessage => msg.type === "TOOL_COMPLETE_REQUEST",
        );
    }

    respondAllowed(requestId: number, toolExecutionId: string, lastEventSequence: number): void {
        this.gateway.handleMasterMessage(
            createToolPrepareResponseMessage("run-gateway-1", requestId, {
                kind: "ALLOWED",
                toolExecutionId,
                lastEventSequence,
            }),
        );
    }
}

describe("WorkerToolGateway（Worker 侧工具治理网关）", () => {
    test("ALLOWED：执行真实工具并回报 COMPLETE，返回结果并更新事件序号", async () => {
        const harness = new GatewayHarness();
        let invokeCount = 0;

        const executePromise = harness.gateway.execute(createInput(), async () => {
            invokeCount += 1;
            return { written: true };
        });

        const request = harness.lastPrepareRequest();
        expect(request.input.toolName).toBe("write");
        expect(request.input.effect).toBe("UNKNOWN_EFFECT");

        harness.respondAllowed(request.requestId, "exec-1", 12);

        const result = await executePromise;
        expect(result).toEqual({ written: true });
        expect(invokeCount).toBe(1);

        const completes = harness.completeRequests();
        expect(completes).toHaveLength(1);
        expect(completes[0]!.toolExecutionId).toBe("exec-1");
        expect(completes[0]!.outcome).toEqual({ ok: true, result: { written: true } });

        expect(harness.gateway.getLastEventSequence("run-gateway-1")).toBe(12);
    });

    test("REUSE：历史命中直接返回缓存结果，不执行也不回报 COMPLETE", async () => {
        const harness = new GatewayHarness();
        let invokeCount = 0;

        const executePromise = harness.gateway.execute(createInput(), async () => {
            invokeCount += 1;
            return "不应该被执行";
        });

        const request = harness.lastPrepareRequest();
        harness.gateway.handleMasterMessage(
            createToolPrepareResponseMessage("run-gateway-1", request.requestId, {
                kind: "REUSE",
                result: { cached: true },
            }),
        );

        const result = await executePromise;
        expect(result).toEqual({ cached: true });
        expect(invokeCount).toBe(0);
        expect(harness.completeRequests()).toHaveLength(0);
    });

    test("DENIED：抛出拒绝原因，不执行真实工具", async () => {
        const harness = new GatewayHarness();
        let invokeCount = 0;

        const executePromise = harness.gateway.execute(createInput(), async () => {
            invokeCount += 1;
            return "不应该被执行";
        });

        const request = harness.lastPrepareRequest();
        harness.gateway.handleMasterMessage(
            createToolPrepareResponseMessage("run-gateway-1", request.requestId, {
                kind: "DENIED",
                reason: "策略不允许工具：bash",
            }),
        );

        await expect(executePromise).rejects.toThrow("策略不允许工具：bash");
        expect(invokeCount).toBe(0);
        expect(harness.completeRequests()).toHaveLength(0);
    });

    test("真实工具抛错：回报 FAILED 结果并原样重新抛出", async () => {
        const harness = new GatewayHarness();

        const executePromise = harness.gateway.execute(createInput(), async () => {
            throw new Error("沙箱命令失败");
        });

        const request = harness.lastPrepareRequest();
        harness.respondAllowed(request.requestId, "exec-2", 3);

        await expect(executePromise).rejects.toThrow("沙箱命令失败");

        const completes = harness.completeRequests();
        expect(completes).toHaveLength(1);
        expect(completes[0]!.outcome).toEqual({ ok: false, error: "沙箱命令失败" });
    });

    test("Master 裁决超时：fail-closed 拒绝执行", async () => {
        const harness = new GatewayHarness(30);

        const executePromise = harness.gateway.execute(createInput(), async () => "不应该被执行");

        await expect(executePromise).rejects.toThrow("工具治理网关响应超时");
    });

    test("Master 断连：failAllPending 拒绝所有在途裁决", async () => {
        const harness = new GatewayHarness();

        const executePromise = harness.gateway.execute(createInput(), async () => "不应该被执行");
        harness.gateway.failAllPending("Master IPC 已关闭，工具治理裁决不可用");

        await expect(executePromise).rejects.toThrow("Master IPC 已关闭");
    });
});
