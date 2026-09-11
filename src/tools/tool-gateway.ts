/**
 * Tool Gateway 是决定是否执行工具的，
 * 它解决的是，如果底层 agent 要执行一个任务，那么我们是执行、复用还是阻止？
 *
 * 流水线在唯一的外部回调 invokeTool()（真实执行）处分为两个阶段：
 * - prepare：策略守卫 → 历史幂等判断 → PREPARED 记账（副作用发生之前）；
 * - complete：SUCCEEDED+Checkpoint 原子落库，或 FAILED。
 * 跨进程（Worker）模式下，Master 通过这两个阶段在 IPC 两侧执行治理，
 * Worker 只保留 invokeTool() 的真实沙箱执行。
 */

import type { Checkpoint } from "../checkpoints/checkpoint.ts";
import {
    canAutomaticallyReplay,
    type ToolEffect,
    type ToolExecution,
} from "./tool-execution.ts";
import { ToolExecutionStore } from "./tool-execution-store.ts";
import type { ToolPolicyGuard } from "../policies/tool-policy-guard.ts";
import type { SandboxEnforcementCapabilities } from "../sandbox/sandbox-provider.ts";

export interface ExecuteToolInput {
    runId:string;
    toolCallId:string;
    toolName:string;
    arguments:unknown;
    effect:ToolEffect;
    runtimeSessionRef:string;
    lastEventSequence:number;
    policySnapshotId?:string;
    workspacePath?:string;
    sandboxEnforcement?:SandboxEnforcementCapabilities;
}

/** 真实工具的一次执行结果（成功带结果，失败带错误）。 */
export type ToolGatewayOutcome =
    | { readonly ok: true; readonly result: unknown }
    | { readonly ok: false; readonly error: unknown };

/**
 * prepare 阶段的裁决。
 * REUSE：历史 SUCCEEDED，直接复用缓存结果，不再执行；
 * DENIED：不可自动重放等历史裁决原因（策略守卫错误仍直接抛出，保留原始错误）；
 * PREPARED：已记账，等待真实执行。
 */
export type ToolPrepareDecision =
    | { readonly kind: "REUSE"; readonly result: unknown }
    | { readonly kind: "DENIED"; readonly reason: string }
    | { readonly kind: "PREPARED"; readonly execution: ToolExecution };

export class ToolGateway{
    constructor(
        private readonly store:ToolExecutionStore,
        private readonly policyGuard?:ToolPolicyGuard,
    ){}

    /**
     * 执行前阶段：策略否决权 → 幂等历史判断 → PREPARED 记账。
     * 策略守卫抛出的错误原样向上传播（与 in-process 历史行为一致）。
     */
    prepare(input:ExecuteToolInput):ToolPrepareDecision{
        // 策略检查必须发生在 PREPARED 写入和真实副作用之前。
        this.policyGuard?.assertAllowed(input);

        // 当工具的输入到来时，首先看看有没有对应的工具的历史执行情况：
        // 没有则创建 PREPARED；有则按历史状态决定复用、重放或拒绝。
        const history = this.store.getByToolCall(input.runId,input.toolCallId);

        if (history === null){
            const preparedExecution : ToolExecution = {
                id : crypto.randomUUID(),
                runId:input.runId,
                toolCallId:input.toolCallId,
                toolName:input.toolName,
                arguments:input.arguments,
                effect:input.effect,
                status:"PREPARED",
                result:null,
                errorMessage:null,
                createdAt:new Date().toISOString(),
                finishedAt:null,
            };
            this.store.prepare(preparedExecution);
            return { kind:"PREPARED", execution:preparedExecution };
        }

        switch(history.status){
            case "SUCCEEDED":
                return { kind:"REUSE", result:history.result };
            case "FAILED":
                return {
                    kind:"DENIED",
                    reason:`工具执行失败:${history.errorMessage}`,
                };
            case "PREPARED":
                if (!canAutomaticallyReplay(history.status,history.effect)){
                    return {
                        kind:"DENIED",
                        reason:`不允许自动重放：${history.effect}`,
                    };
                }
                // 允许重放时复用原来的执行记录，
                // 不能再次调用 store.prepare()，否则会违反唯一约束。
                return { kind:"PREPARED", execution:history };
        }
    }

    /**
     * 执行后阶段：把真实执行结果落库。
     * 成功 → SUCCEEDED + Checkpoint 原子写入；失败 → FAILED。
     */
    complete(
        input:ExecuteToolInput,
        execution:ToolExecution,
        outcome:ToolGatewayOutcome,
    ):void{
        if (!outcome.ok){
            const failedExecution : ToolExecution = {
                ...execution,
                status:"FAILED",
                result:null,
                errorMessage:
                    outcome.error instanceof Error
                        ? outcome.error.message
                        : String(outcome.error),
                finishedAt:new Date().toISOString(),
            };
            this.store.fail(failedExecution);
            return;
        }

        const finishedAt = new Date().toISOString();

        const succeededExecution:ToolExecution = {
            ...execution,
            status : "SUCCEEDED",
            result: outcome.result,
            errorMessage:null,
            finishedAt,
        }

        const checkpoint:Checkpoint = {
            id:crypto.randomUUID(),
            runId:input.runId,
            toolExecutionId:execution.id,
            runtimeSessionRef:input.runtimeSessionRef,
            lastEventSequence:input.lastEventSequence,
            createdAt:finishedAt,
        }

        this.store.completeWithCheckpoint(succeededExecution,checkpoint);
    }

    async execute(
        input:ExecuteToolInput,
        invokeTool:() => Promise<unknown>,
    ) : Promise<unknown>{
        const decision = this.prepare(input);

        if (decision.kind === "REUSE"){
            return decision.result;
        }
        if (decision.kind === "DENIED"){
            throw new Error(decision.reason);
        }

        let result : unknown;
        try{
            // invokeTool就是启动工具
            result = await invokeTool();
        } catch(error){
            this.complete(input,decision.execution,{ ok:false, error });
            throw error;
        }

        this.complete(input,decision.execution,{ ok:true, result });
        return result;
    }

}
