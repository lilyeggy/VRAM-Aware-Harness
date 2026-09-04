/** 
 * Tool Gateway 是决定是否执行工具的，
 * 它解决的是，如果底层 agent 要执行一个任务，那么我们是执行、复用还是阻止？
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

export class ToolGateway{
    constructor(
        private readonly store:ToolExecutionStore,
        private readonly policyGuard?:ToolPolicyGuard,
    ){}

    async execute(
        input:ExecuteToolInput,
        invokeTool:() => Promise<unknown>,
    ) : Promise<unknown>{
        // 策略检查必须发生在 PREPARED 写入和真实副作用之前。
        this.policyGuard?.assertAllowed(input);

        const runId = input.runId;
        const toolCallId = input.toolCallId;

        // 整个流程就是，当工具的输入到来时，我们首先看看有没有对应的工具的历史执行情况
        // 
        // 如果没有对应的历史执行情况，我们先创建，说明是第一次调用，然后再进行下一步
        // 如果有对应的历史执行情况，那么我们就可以直接进行下一步
        // 下一步就是执行工具：invokeTtool()
        // 执行工具会有两种结果：1. 成功 2. 失败 
        
        // 获取工具调用的历史
        const history = this.store.getByToolCall(runId,toolCallId);
        let preparedExecution : ToolExecution;

        if (history === null){
            // 没有历史记录，说明是第一次调用，构建 PREPARED
            preparedExecution = {
                id : crypto.randomUUID(),
                runId,
                toolCallId,
                toolName:input.toolName,
                arguments:input.arguments,
                effect:input.effect,
                status:"PREPARED",
                result:null,
                errorMessage:null,
                createdAt:new Date().toISOString(),
                finishedAt:null,
            }
            this.store.prepare(preparedExecution);
        } else {
            switch(history.status){
                // 工具调用成功，返回结果
                case "SUCCEEDED":
                    return history.result;
                // 调用失败，报错
                case "FAILED":
                    throw new Error(`工具执行失败:${history.errorMessage}`);
                // 
                case "PREPARED":
                    if (
                        !canAutomaticallyReplay(
                            history.status,
                            history.effect,
                        ))
                        {
                            throw new Error(
                                `不允许自动重放：${history.effect}`,
                            );
                        }
                    // 允许重放时复用原来的执行记录，
                    // 不能再次调用 store.prepare()，否则会违反唯一约束。
                    preparedExecution = history;
                    break;
                    
            }
        }

        let result : unknown;

        try{
            // invokeTool就是启动工具
            result = await invokeTool();
        } catch(error){
            // 如果出现错误
            const failedExecution : ToolExecution = {
                ...preparedExecution,
                status:"FAILED",
                result:null,
                errorMessage:
                    error instanceof Error
                        ? error.message
                        : String(error),
                finishedAt:new Date().toISOString(),
            };

            // 保存确定失败的工具结果
            this.store.fail(failedExecution);
            throw error;
        }
        const finishedAt = new Date().toISOString();

        const succeededExecution:ToolExecution = {
            ...preparedExecution,
            status : "SUCCEEDED",
            result,
            errorMessage:null,
            finishedAt,
        }

        const checkpoint:Checkpoint = {
            id:crypto.randomUUID(),
            runId:input.runId,
            toolExecutionId:preparedExecution.id,
            runtimeSessionRef:input.runtimeSessionRef,
            lastEventSequence:input.lastEventSequence,
            createdAt:finishedAt,
        }

        this.store.completeWithCheckpoint(succeededExecution,checkpoint);

        return result;
    }

}
