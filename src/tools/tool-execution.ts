/**
 * day3 做的是事件记录，记录的是我们的工具事件、我们的工具发生了什么
 *  day4 做的是在我们的工具执行前的介入
 * 但是也分：tool-gateway和tool-execution-store
 * 可以类比我们的runservice 和 runstore
 * runservice 是决定哪些事件我们值得存储给 harness
 * runstore 是如何存储
 * tool-gateway是决定哪些工具调用情况值得我们记录
 *  tool-execution-store 是我们如何记录
 */

export type ToolEffect = 
    | "READ_ONLY"
    | "IDEMPOTENT_WRITE"
    | "UNKNOWN_EFFECT";

export type ToolExecutionStatus = 
    | "PREPARED"
    | "SUCCEEDED"
    | "FAILED";

export interface ToolExecution  {
    id : string,
    runId:string,
    toolCallId:string,
    toolName : string,
    arguments:unknown,
    effect:ToolEffect,
    status:ToolExecutionStatus,
    result:unknown | null,
    errorMessage:string | null,
    createdAt:string,
    finishedAt:string | null,
};

export function canAutomaticallyReplay(
    status:ToolExecutionStatus,
    effect:ToolEffect,
):boolean{
    if (status !== "PREPARED"){
        return false;
    }

    switch(effect){
        case "READ_ONLY":
            return true;
        case "IDEMPOTENT_WRITE":
            // “写入被声明为幂等”本身不足以证明外部系统会使用稳定幂等键。
            // 在 ToolExecution 持久化并校验真实幂等证据前保持 fail closed。
            return false;
        case "UNKNOWN_EFFECT":
            return false;
    }
}


