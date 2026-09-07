/**
 * 把 runtime 事件转换为可以持久化的 harness 事件
 * 
 * 对于一个事件，我们需要判断它是否值得转化为持久化的事件
 * 1. runservice里面存储的是与 RUN 相关的事件->其实就是agent相关事件
 * 2. 这部分 bridge 需要存储的是除了与 RUN 相关的事件以外的事件 -> 比如工具事件和模型事件
 * 3. 还有一些不持久化的事件:text_delta，它用于展示，不需要持久化
 * 
 * payload 就是附加信息，比如工具相关的事件
 * 对于 "TOOL_STARTED" 事件，payload需要记载对应的工具以及参数
 * payload: {
        toolCallId: "call-123",
        toolName: "read",
        arguments: {
            path: "src/index.ts",
        },
    },
 * 
 */

import type { RuntimeEvent } from "../runtime/agent-runtime.ts";
import type { RunEventType } from "../runs/agent-run.ts";

export interface PersistableRunEventDraft {
    runId:string;
    type : RunEventType;
    timestamp : string;
    payloadVersion : number;
    payload : unknown;

    // 同一个 runtime 事实重复到达时，应该生成相同的 key
    dedupeKey : string;
}

export type RuntimeEventWarningHandler = (
    message: string,
    event: unknown,
) => void;

export class RuntimeEventBridge{
    constructor(
        private readonly warn: RuntimeEventWarningHandler = (
            message,
            event,
        ) => {
            console.warn(message, event);
        },
    ) {}

    // 判断是否值得持久化，如果不值得就返回null
    // 值得就返回 persistableRunEventDraft
    map(event:RuntimeEvent) : PersistableRunEventDraft | null{
        switch (event.type) {
            // 生命周期事件由 RunService 负责更新 Run 状态以及写入对应事件
            // bridge 不再保存，再保存会产生重复事件
            case "agent_started":
            case "agent_completed":
            case "agent_failed":
            case "agent_interrupted":
            case "agent_resumed":
                return null;

            case "sandbox_acquired":
                return {
                    runId: event.runId,
                    type: "SANDBOX_ACQUIRED",
                    timestamp: event.timestamp,
                    payloadVersion: 1,
                    dedupeKey: `sandbox:${event.sandboxId}:acquired`,
                    payload: {
                        durationMs: event.durationMs,
                        warmHit: event.warmHit,
                        profile: event.runtime,
                        sandboxId: event.sandboxId,
                        attemptId: event.attemptId,
                    },
                };

            case "control_prepared":
                return {
                    runId: event.runId,
                    type: "CONTROL_PREPARED",
                    timestamp: event.timestamp,
                    payloadVersion: 1,
                    dedupeKey: `control:${event.runId}:prepared`,
                    payload: { durationMs: event.durationMs },
                };

            case "session_initialized":
                return {
                    runId: event.runId,
                    type: "SESSION_INITIALIZED",
                    timestamp: event.timestamp,
                    payloadVersion: 1,
                    dedupeKey: `session:${event.runId}:initialized`,
                    payload: { durationMs: event.durationMs, mode: event.mode },
                };

            // text_delta 只用于实时展示，不存储
            case "text_delta":
            case "thinking_delta":
                return null;

            case "model_started":
                return {
                    runId: event.runId,
                    type: "MODEL_STARTED",
                    timestamp: event.timestamp,
                    payloadVersion: 1,
                    dedupeKey: `model:${event.modelCallId}:started`,
                    payload: {
                        modelCallId: event.modelCallId,
                        provider: event.provider,
                        model: event.model,
                    },
                };

            case "model_completed":
                return {
                    runId: event.runId,
                    type: "MODEL_COMPLETED",
                    timestamp: event.timestamp,
                    payloadVersion: 1,
                    dedupeKey: `model:${event.modelCallId}:finished`,
                    payload: {
                        modelCallId: event.modelCallId,
                        provider: event.provider,
                        model: event.model,
                        durationMs: event.durationMs,
                        stopReason: event.stopReason,
                        usage: event.usage,
                    },
                };

            case "model_first_token":
                return {
                    runId: event.runId,
                    type: "MODEL_FIRST_TOKEN",
                    timestamp: event.timestamp,
                    payloadVersion: 1,
                    dedupeKey: `model:${event.modelCallId}:first-token`,
                    payload: {
                        modelCallId: event.modelCallId,
                        provider: event.provider,
                        model: event.model,
                        channel: event.channel,
                    },
                };

            // 工具边界我们进行持久化
            case "tool_started":
                return {
                    runId:event.runId,
                    type:"TOOL_STARTED",
                    timestamp:event.timestamp,
                    payloadVersion:1,
                    payload : {
                        toolCallId:event.toolCallId,
                        toolName:event.toolName,
                        arguments:event.arguments,
                    },
                    dedupeKey: `tool:${event.toolCallId}:started`
                };

            case "tool_completed":
                return {
                    runId: event.runId,
                    type: event.isError
                        ? "TOOL_FAILED"
                        : "TOOL_COMPLETED",
                    timestamp: event.timestamp,
                    payloadVersion: 1,

                    // 一个工具调用只能拥有一个最终结果。
                    // 即使 Runtime 错误地先发成功、后发失败，也使用同一个去重键。
                    dedupeKey: `tool:${event.toolCallId}:finished`,
                    payload: {
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        result: event.result,
                        isError: event.isError,
                    },
                };
            // 对于未知事件，我们的处理：告警但是不崩溃
            default :
                return this.handleUnknownEvent(event);
        }
    }

    private handleUnknownEvent(event:never):null{
        const unknownEvent = event as {
            type ?: unknown;
        };
        this.warn(
            `收到未知 RuntimeEvent : ${String(unknownEvent.type)}`,
            event,
        );
        return null;
    }
}
