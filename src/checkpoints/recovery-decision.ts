// 它决定的是能不能恢复
//
// 支柱 3：副作用感知恢复（Side-Effect Aware Recovery）。
// 自动恢复安全防线 fail closed：
// - 只有「仍处 PREPARED 且 READ_ONLY」的工具允许自动重放 → AUTO_RESUME；
// - UNKNOWN_EFFECT（如任意 bash 脚本）或未证明幂等的写入
//   （IDEMPOTENT_WRITE 在幂等证据校验落地前同样不信任）→ 坚决禁止
//   自动重试/自动重放，确定性落为 MANUAL_REVIEW，任务保持 INTERRUPTED，
//   必须经人工确认后才能继续推进。

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
