/**
 * Worker 侧工具治理网关。
 *
 * 实现 PiAdapter 需要的 ToolGatewayExecutor 合同，但不做本地裁决：
 * 每次工具调用都经 IPC 向 Master 请求 prepare 裁决（策略否决 + PREPARED 记账），
 * 拿到 ALLOWED 后才执行 invokeTool()，最后回报 complete 由 Master 落 Checkpoint。
 *
 * fail-closed：Master 无响应（超时/断连）一律拒绝执行真实工具；
 * Worker 在 PREPARED 与 COMPLETE 之间崩溃时，Master 留下的
 * PREPARED + UNKNOWN_EFFECT 记账正好落入既有恢复模型（不自动重放）。
 */

import type { ExecuteToolInput } from "../tools/tool-gateway.ts";
import type { ToolGatewayExecutor } from "../runtime/pi-tool-gateway.ts";
import {
    createToolCompleteRequestMessage,
    createToolPrepareRequestMessage,
    type ToolCompleteRequestMessage,
    type ToolPrepareDecisionPayload,
    type WorkerProtocolMessage,
    type WorkerToMasterMessage,
} from "./worker-protocol.ts";

export interface WorkerToolGatewayOptions {
    /** 等待 Master 裁决的超时；超时即拒绝执行（fail-closed）。 */
    readonly timeoutMs?: number;
}

interface PendingRequest {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

export class WorkerToolGateway implements ToolGatewayExecutor {
    private nextRequestId = 1;
    private readonly pending = new Map<number, PendingRequest>();
    private lastEventSequence = 0;

    constructor(
        private readonly send: (msg: WorkerToMasterMessage) => void,
        private readonly options: WorkerToolGatewayOptions = {},
    ) {}

    async execute(
        input: ExecuteToolInput,
        invokeTool: () => Promise<unknown>,
    ): Promise<unknown> {
        const decision = await this.requestPrepare(input);

        if (decision.kind === "REUSE") {
            return decision.result;
        }
        if (decision.kind === "DENIED") {
            throw new Error(decision.reason);
        }

        const { toolExecutionId } = decision;

        let result: unknown;
        try {
            result = await invokeTool();
        } catch (error) {
            await this.requestComplete(input.runId, toolExecutionId, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }

        await this.requestComplete(input.runId, toolExecutionId, {
            ok: true,
            result,
        });
        return result;
    }

    /** Master → Worker 的 RPC 响应路由。 */
    handleMasterMessage(msg: WorkerProtocolMessage): void {
        if (msg.type !== "TOOL_PREPARE_RESPONSE" && msg.type !== "TOOL_COMPLETE_RESPONSE") {
            return;
        }
        const pending = this.pending.get(msg.requestId);
        if (!pending) {
            return;
        }
        this.pending.delete(msg.requestId);
        clearTimeout(pending.timer);
        if (msg.type === "TOOL_PREPARE_RESPONSE") {
            const decision: ToolPrepareDecisionPayload = msg.decision;
            if (decision.kind === "ALLOWED") {
                this.lastEventSequence = Math.max(this.lastEventSequence, decision.lastEventSequence);
            }
            pending.resolve(decision);
        } else {
            pending.resolve(msg.ok);
        }
    }

    /**
     * Master 断连 / stdin 关闭时调用：fail-closed 拒绝所有在途工具调用。
     */
    failAllPending(reason: string): void {
        for (const [requestId, pending] of this.pending) {
            this.pending.delete(requestId);
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
    }

    /** Master 在 PREPARED 记账时回传的 Run 事件序号。 */
    getLastEventSequence(_runId: string): number {
        return this.lastEventSequence;
    }

    private requestPrepare(input: ExecuteToolInput): Promise<ToolPrepareDecisionPayload> {
        const requestId = this.nextRequestId++;
        return new Promise<ToolPrepareDecisionPayload>((resolve, reject) => {
            this.registerPending(
                requestId,
                (value) => resolve(value as ToolPrepareDecisionPayload),
                reject,
            );
            this.send(createToolPrepareRequestMessage(input.runId, requestId, input));
        });
    }

    private requestComplete(
        runId: string,
        toolExecutionId: string,
        outcome: ToolCompleteRequestMessage["outcome"],
    ): Promise<boolean> {
        const requestId = this.nextRequestId++;
        return new Promise<boolean>((resolve, reject) => {
            this.registerPending(
                requestId,
                (value) => resolve(Boolean(value)),
                reject,
            );
            this.send(createToolCompleteRequestMessage(runId, requestId, toolExecutionId, outcome));
        });
    }

    private registerPending(
        requestId: number,
        resolve: (value: unknown) => void,
        reject: (error: Error) => void,
    ): void {
        const timeoutMs = this.options.timeoutMs ?? 10_000;
        const timer = setTimeout(() => {
            if (this.pending.delete(requestId)) {
                reject(new Error("工具治理网关响应超时，fail-closed 拒绝执行"));
            }
        }, timeoutMs);
        this.pending.set(requestId, { resolve, reject, timer });
    }
}
