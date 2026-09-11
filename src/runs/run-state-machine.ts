/**
 * 定义状态机，规定状态的转移
 * 
 */

import type {AgentRunStatus} from "./agent-run.ts"

const allowedTransitions : Record<AgentRunStatus,readonly AgentRunStatus[]>={
    // 支柱 3：QUEUED -> FAILED 仅用于排队 TTL 熔断（QUEUE_TIMEOUT）——
    // 任务等待超门限仍未获得调度准入时，安全流转到终态，杜绝永久饥饿死等。
    QUEUED: ["RUNNING","INTERRUPTED","FAILED"],
    RUNNING : [
        "WAITING_TOOL",
        "INTERRUPTED",
        "FAILED",
        "COMPLETED",
    ],
    WAITING_TOOL:[
        "RUNNING",
        "INTERRUPTED",
        "FAILED",
    ],
    INTERRUPTED:[
        "QUEUED"
    ],
    COMPLETED:[],
    FAILED:[]
}

export function canTransition(
    from : AgentRunStatus,
    to : AgentRunStatus,
): boolean {
    return allowedTransitions[from].includes(to);
}

// 只允许规定的状态转换
export function assertValidTransition(
    from : AgentRunStatus,
    to : AgentRunStatus,
): void {
    if (!canTransition(from,to)){
        throw new Error(
            `非法的 AgentRun 状态转换：${from} -> ${to}`
        )
    }
}



