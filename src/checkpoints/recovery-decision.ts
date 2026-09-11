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
    | "UNSAFE_TOOL_EFFECT"
    /**
     * N18：Checkpoint 归属没问题，但它引用的运行时会话已经打不开了。
     * 此时"恢复"只会静默变成"开一个没有历史的新会话"，用户以为续上了上下文
     * 其实没有 —— 因此拒绝自动恢复，确定性转人工。
     */
    | "SESSION_REF_UNREACHABLE";

export interface RecoveryDecision {
    action:RecoveryAction;
    reason:RecoveryReason;
    blockingToolExecutionId:string|null;
};

/**
 * N18：运行时会话引用的可达性校验。
 *
 * 为什么必须由调用方注入：只有运行时适配器知道这个引用指向什么载体
 * （Pi 的 `runtime_session_ref` 是会话 JSONL 文件路径；demo/测试运行时可能是
 * 合成字符串）。所以这里不做任何默认假设——未提供 `isReachable` 时保持原有
 * 行为，生产装配显式注入「文件是否存在」这一校验。
 */
export interface SessionRefCheck {
    /** Checkpoint 记录的运行时会话引用。 */
    runtimeSessionRef?:string|null;
    /** 返回 false 表示该引用不可达，恢复必须转人工。 */
    isReachable?:(runtimeSessionRef:string)=>boolean;
}

export function decideRecovery (
    checkpointId:string|null,
    preparedExecution:readonly ToolExecution[],
    sessionRef:SessionRefCheck = {},
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

    // N18：副作用安全之后，再校验"这次恢复是否真的能续接原会话"。
    //
    // 放在 unsafe 判定**之后**是有意的：未知副作用必须先被挡住，不能让一个
    // 打不开的会话引用盖过更强的安全信号。两者都落到 MANUAL_REVIEW，但理由
    // 不同，运维据此才能区分"要人工确认副作用"还是"恢复点已经损坏"。
    //
    // 不校验的后果（真机实证 R10）：Pi 的 `loadEntriesFromFile` 对不存在的
    // 文件返回空数组，`SessionManager.open` 因此得到一个空会话，Run 照常
    // COMPLETED、日志零告警 —— 用户以为续上了上下文，其实模型对之前做过什么
    // 一无所知。这与"不确定副作用不得自动重放"是同一条原则：宁可拒绝，不要
    // 假装成功。
    const sessionRefUnreachable = typeof sessionRef.runtimeSessionRef === "string"
        && sessionRef.runtimeSessionRef !== ""
        && sessionRef.isReachable !== undefined
        && !sessionRef.isReachable(sessionRef.runtimeSessionRef);

    if (sessionRefUnreachable){
        return {
            action:"MANUAL_REVIEW",
            reason:"SESSION_REF_UNREACHABLE",
            blockingToolExecutionId:null,
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
