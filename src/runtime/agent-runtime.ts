/**
 * 这是 Harness 对 Agent Runtime 的抽象
 * Agent Runtime 主要完成两件事： 
 * 1. 把harness命令翻译成为能够让 Agent SDK 调用的 
 * 2. 把具体 Agent SDK 事件翻译成 harness 自己的事件
 * 
 * 但是要说明，agent-runtime与pi adapter看起来作用是一致的：
 * 就是harness event 与 agent event 的相互转换
 * 但是 pi adapter 是专门转化为 pi agent 的 event 的
 * agent-runtime 是我们所有其他的 adapter 都要遵守的接口
 * 假如说是pi agent就用 pi adapter
 * claude agent 就用 claude adapter
 */

import type { SandboxEnforcementCapabilities } from "../sandbox/sandbox-provider.ts";

export interface RuntimeRunRef{
    /** Harness 未来生成的 AgentRun ID */
    runId:string;

    /** 公平调度和资源配额的主体 */
    tenantId:string;
    
    /** harnessSession Id,与 AgentSession 不一致 */
    harnessSessionId:string;

    /**
     * 上一次实际 Runtime 会话的持久化引用。首次消息为空；后续消息由
     * 控制面从 HarnessSession 注入，Adapter 据此继续同一段模型上下文。
     */
    runtimeSessionRef?:string | null;

    /** 本次 Run 的推理深度，必须随 Run 持久化以支持恢复。 */
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";

    /** 本次执行使用的 Workspace 工作目录；真正的 Tenant 隔离由上层负责校验 */
    workspacePath:string;

    /** Stage 1 控制面正式入口必须提供；旧的直接 Runtime 测试保持兼容。 */
    templateVersionId?:string;
    harnessInstanceId?:string;
}

export interface RuntimeCheckpointRef{
    /** harness持久化的 Id */
    checkpointId:string;

    /** pi session的引用 */
    runtimeSessionRef:string;

    /** checkpoint对应的最后一条harness 事件序号 */
    lastEventSequence:number;
}

export interface RuntimeStartRequest{
    run:RuntimeRunRef;
    input:string;
    execution?:RuntimeExecutionContext;
}

export interface RuntimeResumeRequest{
    run:RuntimeRunRef;
    checkpoint:RuntimeCheckpointRef;
    continuationInput:string;   // 告诉底层 agent 恢复后继续做什么
    execution?:RuntimeExecutionContext;
}

export interface RuntimeExecutionContext {
    readonly attemptId: string;
    readonly policySnapshotId: string;
    readonly sandboxId: string;
    readonly sandboxEnforcement: SandboxEnforcementCapabilities;
    readonly runtimeConfig: {
        readonly runtimeKind: "PI";
        readonly provider: string;
        readonly modelId: string;
        readonly tools: readonly string[];
        readonly skills: readonly string[];
        readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
    };
}

/**
 * Harness 使用的稳定模型 usage 结构。
 * 字段名不直接复用具体 Provider SDK，避免上游升级影响持久化 payload。
 */
export interface RuntimeModelUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number | null;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}

export type RuntimeEvent = 
    | {
        type:"agent_started";
        runId:string;
        timestamp:string;
        runtimeSessionRef:string;
    }
    | {
        type:"text_delta";
        runId:string,
        timestamp:string;
        delta:string;
    }
    | {
        type:"thinking_delta";
        runId:string,
        timestamp:string;
        delta:string;
    }
    | {
        type: "model_started";
        runId: string;
        timestamp: string;
        modelCallId: string;
        provider: string;
        model: string;
    }
    | {
        type: "model_first_token";
        runId: string;
        timestamp: string;
        modelCallId: string;
        provider: string;
        model: string;
        channel: "text" | "thinking";
    }
    | {
        type: "model_completed";
        runId: string;
        timestamp: string;
        modelCallId: string;
        provider: string;
        model: string;
        durationMs: number;
        stopReason: string;
        usage: RuntimeModelUsage;
    }
    | {
        type:"tool_started";
        runId:string;
        timestamp:string;
        toolCallId:string;
        toolName:string;
        arguments:unknown;
    }
    | {
        type:"tool_completed";
        runId:string;
        timestamp:string;
        toolCallId:string;
        toolName:string;
        result:unknown;
        isError:boolean;
    }
    | {
        type:"agent_completed";
        runId:string;
        timestamp:string;
    }
    | {
        type:"agent_failed";
        runId:string;
        timestamp:string;
        message:string;
    } 
    | {
        type:"agent_interrupted";
        runId:string;
        timestamp:string;
    }
    | {
        type:"agent_resumed";
        runId:string;
        timestamp:string;
        checkpointId:string;     // 从哪个checkpoint恢复
        runtimeSessionRef:string;   // 实际打开了哪个pi session
    }
    | {
        type: "sandbox_acquired";
        runId: string;
        timestamp: string;
        durationMs: number;
        warmHit: boolean;
        runtime: string;
    }

export type RuntimeEventHandler = (event:RuntimeEvent) => void;

export interface AgentRuntime {
    /** Adapter 可报告部署组合的细粒度真实能力。 */
    getCapabilityProfile?(): import("./runtime-capability.ts").RuntimeCapabilityProfile;

    start(request:RuntimeStartRequest):Promise<void>;

    resume(request:RuntimeResumeRequest):Promise<void>;

    interrupt(runId:string):Promise<void>;

    subscribe(runId:string,handler:RuntimeEventHandler):()=>void;
}
