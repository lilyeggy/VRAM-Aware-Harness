/**
 * Agentrun 代表的是用户输入进来以后，我们需要做的
 * 就是相当于用户给定一个任务输入，我们怎么做这样
 * 用户给了一个任务，我们能否执行？：要通过 AgentRunStatus 判断
 * 我们通过 AgentRun来定义这次任务，一次任务与一次模型执行不一样，任务可以有多次模型执行
 * 
 * Runtime 和 Run的最大区别就是 Runtime 是即时的，而 Run 是持久的
 * 那么从这个角度看，RuntimeEvent和RunEvent也是同样的区别
 * RuntimeEvent是即时的，而 RunEvent 是harness 长期保存的
 * 
 * RuntimeEvent 存在于底层agent SDK 以及 Agent session 执行中
 * RunEvent 是存在与 harness 执行后长期保存的业务事实中
 */

import type { PolicyConstraints } from "../policies/effective-policy.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export type AgentRunStatus = 
    | "QUEUED"
    | "RUNNING"
    | "WAITING_TOOL"
    | "INTERRUPTED"
    | "COMPLETED"
    | "FAILED"
// 这个按照我理解，就是用户给一个任务以后，我们首先是给定这个任务一个状态

export interface AgentRun{
    id :string;
    tenantId : string;
    harnessSessionId : string;
    status : AgentRunStatus;
    userInput : string;
    workspacePath : string;

    createdAt:string;
    updatedAt:string;
    startedAt:string | null;
    finishedAt:string | null;

    checkpointId:string | null;
    failureReason:string | null;

    /** 用户选择的推理深度；缺省 off 兼容旧 Run。 */
    thinkingLevel?: ThinkingLevel;

    /** Stage 1 正式控制面入口为新 Run 固定的不可变执行证据。 */
    templateVersionId?:string;
    harnessInstanceId?:string;
    runPolicy?:PolicyConstraints;
}
// 这个就是对于一个任务，我们一定要区分这个任务的来源、这个任务属于的 session等等


// 这个是对于 harness 来说的 event
// 就是对于 harness 来说，底层发生了什么我们需要记录的事件
// 这个 event 的特点是，其实是记录了完整 run 的历程序列，比如：
// sequence 1 : RUN_CREATED
// sequence 2 : RUN_QUEUED等等
// 但是对于RuntimeEvent，没有这些记录，它是即时的一次的
export type RunEventType = 
    | "RUN_CREATED"
    | "RUN_QUEUED"
    | "RUN_STARTED"
    | "RUN_RESUMED"
    | "RUN_INTERRUPTED"
    | "RUN_COMPLETED"
    | "RUN_FAILED"
    | "MODEL_STARTED"
    | "MODEL_FIRST_TOKEN"
    | "MODEL_COMPLETED"
    | "SANDBOX_ACQUIRED"
    | "TOOL_REQUESTED"
    | "TOOL_STARTED"
    | "TOOL_COMPLETED"
    | "TOOL_FAILED"
    | "CHECKPOINT_SAVED";

export interface RunEvent{
    eventId:string;
    runId:string;
    sequence:number;    // 同一个 run 内的事件序号
    type:RunEventType;
    timestamp:string;
    payloadVersion:number;
    payload:unknown;

    // RuntimeEventBridge 产生的事件使用稳定 key 做 at-least-once 去重。
    // Day 2 的生命周期事件没有来源事件 key，因此该字段可选。
    dedupeKey?:string;
}
