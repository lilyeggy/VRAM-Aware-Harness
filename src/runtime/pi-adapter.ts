/**
 * PiAdapter 负责：
 * 1. 把 Harness 的 start/resume/interrupt 命令转换成 Pi SDK 调用；
 * 2. 把 Pi AgentSessionEvent 转换成 Harness RuntimeEvent。
 */


import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    type ModelRuntime,
    type AgentSession,
}from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";


import type {
    AgentRuntime,
    RuntimeEventHandler,
    RuntimeEvent,
    RuntimeStartRequest,
    RuntimeResumeRequest,
}   from "./agent-runtime.ts"
import {
    createGatewayPiTools,
    type ToolGatewayExecutor,
} from "./pi-tool-gateway.ts";
import { createPiCapabilityProfile } from "./runtime-capability.ts";
import type { SandboxCommandExecutor } from "../sandbox/sandbox-provider.ts";

export interface PiAdapterConfig{
    provider:string;
    modelId:string;
    tools:string[];
}

/**
 * PiAdapter 只通过回调获取 Harness 的事件位置，不直接依赖 RunStore/SQLite。
 * composition root 负责把真实 ToolGateway 和 RunStore 回调连接进来。
 */
export interface PiAdapterToolGatewayBinding {
    gateway: ToolGatewayExecutor;
    getLastEventSequence(runId: string): number;
    sandboxExecutor?: SandboxCommandExecutor;
}

export class PiAdapter implements AgentRuntime{
    // 保存的是 harness runId 到 pi agent Session 的映射
    private readonly sessionsByRunId = 
        new Map<string,AgentSession>();
    
    // 保存的是harness runId 到 harness订阅的 handler的映射
    private readonly handlersByRunId = 
        new Map<string,Set<RuntimeEventHandler>>();

    constructor(
        private readonly modelRuntime:ModelRuntime,
        private readonly config:PiAdapterConfig,
        private readonly toolGatewayBinding:
            PiAdapterToolGatewayBinding,
    ){

    }

    getCapabilityProfile() {
        return createPiCapabilityProfile(
            `pi-capability:${this.config.provider}/${this.config.modelId}`,
            `${this.config.provider}/${this.config.modelId}`,
        );
    }

    subscribe(runId: string, handler: RuntimeEventHandler): () => void {
        let handlers = this.handlersByRunId.get(runId);

        if (!handlers){
            handlers = new Set<RuntimeEventHandler>();
            this.handlersByRunId.set(runId,handlers);
        }

        handlers.add(handler);

        return () => {
            handlers.delete(handler);
            if(handlers.size === 0){
                this.handlersByRunId.delete(runId);
            }
        }
    }

    private emit(event:RuntimeEvent):void {
        const handlers = this.handlersByRunId.get(event.runId);

        if (!handlers){
            return;
        }

        for (const handler of handlers){
            handler(event);
        }
    }

    /**
     * 当前 SDK 类型中的已知但无业务意义事件会在 switch 中显式忽略。
     * 真正未知的运行时事件只告警，不让 Adapter 崩溃。
     *
     * 参数使用 never，因此 Pi SDK 扩展事件联合类型后，TypeScript 会要求
     * 我们先决定“映射、忽略还是告警”，避免静默遗漏。
     */
    private warnUnknownPiEvent(event: never): void {
        const unknownEvent = event as {
            type?: unknown;
        };

        console.warn(
            `收到未知 Pi AgentSessionEvent：${String(unknownEvent.type)}`,
            event,
        );
    }

    async start(request:RuntimeStartRequest):Promise<void>{
        if (this.sessionsByRunId.has(request.run.runId)){
            throw new Error("已经有当前runId");
        }

        const runId = request.run.runId;
        const config = request.execution?.runtimeConfig ?? this.config;
        const model = this.modelRuntime.getModel(
            config.provider,
            config.modelId,
        );
        
        if (!model){
            throw new Error(`未找到${config.provider}/${config.modelId}`)
        }

        const runtimeSessionRefHolder: {
            current: string | null;
        } = {
            current: null,
        };
        const customTools = this.createGatewayTools(
            runId,
            request.run.workspacePath,
            runtimeSessionRefHolder,
            config.tools,
            request.execution?.policySnapshotId,
            request.execution?.sandboxId,
        );
        const resourceLoader = request.execution === undefined
            ? undefined
            : this.createPolicyResourceLoader(
                request.run.workspacePath,
                request.execution.runtimeConfig.skills,
            );

        // 创建 pi agent session
        const {session} = await createAgentSession({
            cwd:request.run.workspacePath,
            modelRuntime:this.modelRuntime,
            model,
            tools:[...config.tools],
            customTools,
            sessionManager:SessionManager.create(request.run.workspacePath),
            ...(resourceLoader === undefined ? {} : { resourceLoader }),
            // 创建一个可以持久化 Pi 对话历史的 SessionManager。
        })

        // 先检查 session 是不是存在
        const runtimeSessionRef = session.sessionFile


        if (!runtimeSessionRef){
            session.dispose();
            throw new Error(`Pi Session 没有持久化引用：${runId}`);
        }
        runtimeSessionRefHolder.current = runtimeSessionRef;
        this.sessionsByRunId.set(request.run.runId,session);
        // 把 runId和 session 对应起来

        const modelStartedAtByCallId = new Map<string, number>();

        const unsubscribe = session.subscribe((piEvent) => {
            const timestamp = new Date().toISOString();

            switch (piEvent.type){
                case "agent_start":
                    this.emit({
                        type:"agent_started",
                        runId,
                        timestamp,
                        runtimeSessionRef,
                    })
                    break;

                case "message_start": {
                    if (piEvent.message.role !== "assistant") {
                        break;
                    }

                    const modelCallId =
                        `${runId}:model:${piEvent.message.timestamp}`;

                    modelStartedAtByCallId.set(
                        modelCallId,
                        Date.now(),
                    );

                    this.emit({
                        type: "model_started",
                        runId,
                        timestamp,
                        modelCallId,
                        provider: piEvent.message.provider,
                        model: piEvent.message.responseModel
                            ?? piEvent.message.model,
                    });
                    break;
                }

                case "message_update":
                    if (piEvent.assistantMessageEvent.type === "text_delta"){
                        this.emit({
                            type:"text_delta",
                            runId,
                            timestamp,
                            delta:piEvent.assistantMessageEvent.delta,
                        })
                    }
                    break;

                case "message_end": {
                    if (piEvent.message.role !== "assistant") {
                        break;
                    }

                    const modelCallId =
                        `${runId}:model:${piEvent.message.timestamp}`;
                    const startedAt =
                        modelStartedAtByCallId.get(modelCallId);

                    modelStartedAtByCallId.delete(modelCallId);

                    this.emit({
                        type: "model_completed",
                        runId,
                        timestamp,
                        modelCallId,
                        provider: piEvent.message.provider,
                        model: piEvent.message.responseModel
                            ?? piEvent.message.model,
                        durationMs: Math.max(
                            0,
                            Date.now() - (
                                startedAt
                                    ?? piEvent.message.timestamp
                            ),
                        ),
                        stopReason: piEvent.message.stopReason,
                        usage: {
                            inputTokens:
                                piEvent.message.usage.input,
                            outputTokens:
                                piEvent.message.usage.output,
                            cacheReadTokens:
                                piEvent.message.usage.cacheRead,
                            cacheWriteTokens:
                                piEvent.message.usage.cacheWrite,
                            reasoningTokens:
                                piEvent.message.usage.reasoning
                                    ?? null,
                            totalTokens:
                                piEvent.message.usage.totalTokens,
                            cost: {
                                input:
                                    piEvent.message.usage.cost.input,
                                output:
                                    piEvent.message.usage.cost.output,
                                cacheRead:
                                    piEvent.message.usage.cost.cacheRead,
                                cacheWrite:
                                    piEvent.message.usage.cost.cacheWrite,
                                total:
                                    piEvent.message.usage.cost.total,
                            },
                        },
                    });
                    break;
                }

                case "tool_execution_start":
                    this.emit({
                        type:"tool_started",
                        runId,
                        timestamp,
                        toolCallId:piEvent.toolCallId,
                        toolName:piEvent.toolName,
                        arguments:piEvent.args,
                    })
                    break;

                case "tool_execution_end":
                    this.emit({
                        type:"tool_completed",
                        runId,
                        timestamp,
                        toolCallId:piEvent.toolCallId,
                        toolName:piEvent.toolName,
                        result:piEvent.result,
                        isError:piEvent.isError,
                    })
                    break;
                
                
                case "agent_end":
                    // agent执行结束，也有可能是需要重试的情况
                    if (piEvent.willRetry){
                        break;
                    }
                    // 如果是不需要重试的情况，其实也有区分
                    const lastMessage = piEvent.messages.at(-1);
                    // 一种是 Agent 的执行被打断了
                    if (
                        lastMessage?.role === "assistant"
                            && lastMessage.stopReason === "aborted"
                    ){
                        this.emit({
                            type:"agent_interrupted",
                            runId,
                            timestamp,
                        });
                        break;
                    }
                    // 一种是 agent 执行失败了
                    if (
                        lastMessage?.role === "assistant"
                            && lastMessage.stopReason === "error"
                    ){
                        this.emit({
                            type:"agent_failed",
                            runId,
                            timestamp,
                            message:lastMessage.errorMessage ?? "Pi Agent执行失败"
                        });
                        break;
                    }
                    this.emit({
                        type:"agent_completed",
                        runId,
                        timestamp,
                    })
                    break;  

                // Pi 内部状态和增量工具输出当前不形成 Harness 业务事实。
                case "turn_start":
                case "turn_end":
                case "tool_execution_update":
                case "agent_settled":
                case "queue_update":
                case "compaction_start":
                case "compaction_end":
                case "entry_appended":
                case "session_info_changed":
                case "thinking_level_changed":
                case "auto_retry_start":
                case "auto_retry_end":
                    break;

                default:
                    this.warnUnknownPiEvent(piEvent);
            }
        })
        try{
            await session.prompt(
            request.input
            );
        } catch(error){
            // 通知订阅者，保存运行事实，发生错误
            this.emit({
                type:"agent_failed",
                runId,
                timestamp: new Date().toISOString(),
                message:error instanceof Error
                ? error.message
                : String(error),
            });
            // 通知start()的调用者
            throw error;
        }
        finally {
            unsubscribe();
            this.sessionsByRunId.delete(runId);
            session.dispose();
        }
        

    }

    async interrupt(runId: string): Promise<void> {
        const session = this.sessionsByRunId.get(runId);

        if (!session){
            throw new Error(`没有找到正在运行的Agent Session ${runId}`)
        }
        await session.abort();
    }

    async resume(request:RuntimeResumeRequest):Promise<void>{
        // 获取中断的session

        const runId = request.run.runId;
        const config = request.execution?.runtimeConfig ?? this.config;
        if (this.sessionsByRunId.has(runId)){
            throw new Error(`runId ${runId}已经在运行`)
        }

        const model = this.modelRuntime.getModel(config.provider,config.modelId)
        if (!model){
            throw new Error(
                `未找到 ${config.provider}/${config.modelId}`,
            );
        }

        const sessionManager = SessionManager.open(
            request.checkpoint.runtimeSessionRef,
            undefined,
            request.run.workspacePath
        )
        const runtimeSessionRefHolder = {
            current: request.checkpoint.runtimeSessionRef,
        };
        const customTools = this.createGatewayTools(
            runId,
            request.run.workspacePath,
            runtimeSessionRefHolder,
            config.tools,
            request.execution?.policySnapshotId,
            request.execution?.sandboxId,
        );
        const resourceLoader = request.execution === undefined
            ? undefined
            : this.createPolicyResourceLoader(
                request.run.workspacePath,
                request.execution.runtimeConfig.skills,
            );

        const {session} = await createAgentSession({
            cwd:request.run.workspacePath,
            modelRuntime:this.modelRuntime,
            model,
            tools:[...config.tools],
            customTools,
            sessionManager,
            ...(resourceLoader === undefined ? {} : { resourceLoader }),
        })

        const checkpointId = request.checkpoint.checkpointId
        const runtimeSessionRef = request.checkpoint.runtimeSessionRef
        // runtimeSessionRef就是 pi agent 的 session


        this.sessionsByRunId.set(request.run.runId,session)

        const modelStartedAtByCallId = new Map<string, number>();

        const unsubscribe = session.subscribe((piEvent) => {
            const timestamp = new Date().toISOString();

            switch(piEvent.type){
                case "agent_start":
                    this.emit({
                        type:"agent_resumed",
                        runId,
                        timestamp,
                        checkpointId,
                        runtimeSessionRef,
                    })
                    break;
                case "message_start": {
                    if (piEvent.message.role !== "assistant") {
                        break;
                    }

                    const modelCallId =
                        `${runId}:model:${piEvent.message.timestamp}`;

                    modelStartedAtByCallId.set(
                        modelCallId,
                        Date.now(),
                    );

                    this.emit({
                        type: "model_started",
                        runId,
                        timestamp,
                        modelCallId,
                        provider: piEvent.message.provider,
                        model: piEvent.message.responseModel
                            ?? piEvent.message.model,
                    });
                    break;
                }

                    case "message_update":
                    if (piEvent.assistantMessageEvent.type === "text_delta"){
                        this.emit({
                            type:"text_delta",
                            runId,
                            timestamp,
                            delta:piEvent.assistantMessageEvent.delta,
                        })
                    }
                    break;

                case "message_end": {
                    if (piEvent.message.role !== "assistant") {
                        break;
                    }

                    const modelCallId =
                        `${runId}:model:${piEvent.message.timestamp}`;
                    const startedAt =
                        modelStartedAtByCallId.get(modelCallId);

                    modelStartedAtByCallId.delete(modelCallId);

                    this.emit({
                        type: "model_completed",
                        runId,
                        timestamp,
                        modelCallId,
                        provider: piEvent.message.provider,
                        model: piEvent.message.responseModel
                            ?? piEvent.message.model,
                        durationMs: Math.max(
                            0,
                            Date.now() - (
                                startedAt
                                    ?? piEvent.message.timestamp
                            ),
                        ),
                        stopReason: piEvent.message.stopReason,
                        usage: {
                            inputTokens:
                                piEvent.message.usage.input,
                            outputTokens:
                                piEvent.message.usage.output,
                            cacheReadTokens:
                                piEvent.message.usage.cacheRead,
                            cacheWriteTokens:
                                piEvent.message.usage.cacheWrite,
                            reasoningTokens:
                                piEvent.message.usage.reasoning
                                    ?? null,
                            totalTokens:
                                piEvent.message.usage.totalTokens,
                            cost: {
                                input:
                                    piEvent.message.usage.cost.input,
                                output:
                                    piEvent.message.usage.cost.output,
                                cacheRead:
                                    piEvent.message.usage.cost.cacheRead,
                                cacheWrite:
                                    piEvent.message.usage.cost.cacheWrite,
                                total:
                                    piEvent.message.usage.cost.total,
                            },
                        },
                    });
                    break;
                }

                case "tool_execution_start":
                    this.emit({
                        type:"tool_started",
                        runId,
                        timestamp,
                        toolCallId:piEvent.toolCallId,
                        toolName:piEvent.toolName,
                        arguments:piEvent.args,
                    })
                    break;

                case "tool_execution_end":
                    this.emit({
                        type:"tool_completed",
                        runId,
                        timestamp,
                        toolCallId:piEvent.toolCallId,
                        toolName:piEvent.toolName,
                        result:piEvent.result,
                        isError:piEvent.isError,
                    })
                    break;
                
                
                case "agent_end":
                    // agent执行结束，也有可能是需要重试的情况
                    if (piEvent.willRetry){
                        break;
                    }
                    // 如果是不需要重试的情况，其实也有区分
                    const lastMessage = piEvent.messages.at(-1);
                    // 一种是 Agent 的执行被打断了
                    if (
                        lastMessage?.role === "assistant"
                            && lastMessage.stopReason === "aborted"
                    ){
                        this.emit({
                            type:"agent_interrupted",
                            runId,
                            timestamp,
                        });
                        break;
                    }
                    // 一种是 agent 执行失败了
                    if (
                        lastMessage?.role === "assistant"
                            && lastMessage.stopReason === "error"
                    ){
                        this.emit({
                            type:"agent_failed",
                            runId,
                            timestamp,
                            message:lastMessage.errorMessage ?? "Pi Agent执行失败"
                        });
                        break;
                    }
                    this.emit({
                        type:"agent_completed",
                        runId,
                        timestamp,
                    })
                    break;  

                // Pi 内部状态和增量工具输出当前不形成 Harness 业务事实。
                case "turn_start":
                case "turn_end":
                case "tool_execution_update":
                case "agent_settled":
                case "queue_update":
                case "compaction_start":
                case "compaction_end":
                case "entry_appended":
                case "session_info_changed":
                case "thinking_level_changed":
                case "auto_retry_start":
                case "auto_retry_end":
                    break;

                default:
                    this.warnUnknownPiEvent(piEvent);
            }
        })
        try {
            await session.prompt(
                request.continuationInput
            );
        }catch(error){
            this.emit({
                type:"agent_failed",
                runId,
                timestamp:new Date().toISOString(),
                message:error instanceof Error
                ? error.message
                : String(error),
            });
            throw error;
        } finally {
            unsubscribe();
            this.sessionsByRunId.delete(runId);
            session.dispose();
        }
    }

    /**
     * 为当前 Run 创建同名的 Gateway 包装工具。
     *
     * Pi SDK 会让 customTools 中的同名定义覆盖内置工具，因此模型仍调用
     * read/bash/edit/write，但实际 execute 已经被 ToolGateway 包围。
     */
    private createGatewayTools(
        runId: string,
        workspacePath: string,
        runtimeSessionRefHolder: {
            current: string | null;
        },
        toolNames: readonly string[],
        policySnapshotId?: string,
        sandboxId?: string,
    ) {
        return createGatewayPiTools(
            toolNames,
            workspacePath,
            this.toolGatewayBinding.gateway,
            {
                runId,
                workspacePath,
                getPolicySnapshotId: () => policySnapshotId,
                getSandboxId: () => sandboxId,
                getRuntimeSessionRef: () => {
                    const runtimeSessionRef =
                        runtimeSessionRefHolder.current;

                    if (runtimeSessionRef === null) {
                        throw new Error(
                            `Pi Session 尚未准备好：${runId}`,
                        );
                    }

                    return runtimeSessionRef;
                },
                getLastEventSequence: () =>
                    this.toolGatewayBinding
                        .getLastEventSequence(runId),
            },
            this.toolGatewayBinding.sandboxExecutor,
        );
    }

    private createPolicyResourceLoader(
        workspacePath: string,
        skillNames: readonly string[],
    ): DefaultResourceLoader {
        const allowed = new Set(skillNames);
        return new DefaultResourceLoader({
            cwd: workspacePath,
            agentDir: join(homedir(), ".pi", "agent"),
            noSkills: allowed.size === 0,
            skillsOverride: (base) => ({
                ...base,
                skills: base.skills.filter((skill) => allowed.has(skill.name)),
            }),
        });
    }
}
