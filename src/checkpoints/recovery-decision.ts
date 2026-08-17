// 它决定的是能不能恢复

import {
    canAutomaticallyReplay,
    type ToolExecution,
} from "../tools/tool-execution.ts";

export type RecoveryAction = 
    | "AUTO_RESUME"
    | "MANUAL_REVIEW";

export type RecoveryReason = 
    | "SAFE_CHECKPOINT"
    | "NO_CHECKPOINT"
    | "UNSAFE_TOOL_EFFECT";

export interface RecoveryDecision {
    action:RecoveryAction;
    reason:RecoveryReason;
    blockingToolExecutionId:string|null;
};

export function decideRecovery (
    checkpointId:string|null,
    preparedExecution:readonly ToolExecution[],
):RecoveryDecision{
    if (checkpointId === null){
        const action : RecoveryAction = "MANUAL_REVIEW";
        const recoveryReason : RecoveryReason= "NO_CHECKPOINT";
        const execution : RecoveryDecision = {
            action:action,
            reason:recoveryReason,
            blockingToolExecutionId:null,
        }
        return execution;
    };
    // 定义不能重放的工具为 unsafeExecution
    const unsafeExecution = preparedExecution.find(
        (execution) => !canAutomaticallyReplay(
            execution.status,
            execution.effect,
        )
    );

    // 如果存在不能replay的工具（也就是上面找到了）
    if (unsafeExecution !== undefined){
        return {
            action:"MANUAL_REVIEW",
            reason:"UNSAFE_TOOL_EFFECT",
            blockingToolExecutionId:unsafeExecution.id,
        }
    }

    // 当没有找到不呢replay的工具时
    // 如果所有工具都能安全replay
    // 可以恢复的工具：用AUTO_RESUME
    // 不可以恢复的工具：用MANUAL_REVIEW
    return {
        action:"AUTO_RESUME",
        reason:"SAFE_CHECKPOINT",
        blockingToolExecutionId:null,
    }


}
