import type {
    AgentRuntime,
    RuntimeEvent,
    RuntimeEventHandler,
    RuntimeStartRequest,
    RuntimeResumeRequest,
} from "../../src/runtime/agent-runtime.ts"


export class FakeAgentRuntime implements AgentRuntime{
    constructor(
        private readonly outcome : "completed" | "failed" = "completed",
        // 大于 1 时模拟 at-least-once 下的重复工具事件投递。
        private readonly toolEventDeliveries = 0,
        // 大于 1 时模拟重复的模型边界事件。
        private readonly modelEventDeliveries = 0,
    ){};

    // 不同 sessionId 的 runtimehandler
    private readonly handlersByRunId = 
        new Map<string,Set<RuntimeEventHandler>>();

    readonly startRequests: RuntimeStartRequest[] = [];

    readonly resumeRequests: RuntimeResumeRequest[] = [];

    readonly interruptedRunIds: string[] = [];

    subscribe(runId: string, handler: RuntimeEventHandler): () => void {
        // 查找当前 run 的订阅者
        let handlers = this.handlersByRunId.get(runId);

        // 如果不存在
        if (!handlers){
            handlers = new Set<RuntimeEventHandler>();
            this.handlersByRunId.set(runId,handlers);
        }

        handlers.add(handler);

        return () => {
            handlers.delete(handler);
            if (handlers.size === 0){
                this.handlersByRunId.delete(runId);
            }
        }

    }
    private emit(event:RuntimeEvent): void {
        // 事件来的时候，读取对应的 runId（event.runId），然后找到对应的订阅
        const handlers = this.handlersByRunId.get(event.runId);

        if (!handlers){
            return;
        }
        // 逐个执行处理事件的函数
        for (const handler of handlers){
            handler(event);
        }
    }

    async start(request:RuntimeStartRequest):Promise<void> {
        this.startRequests.push(request);

        const runId = request.run.runId;

        this.emit({
            type:"agent_started",
            runId,
            timestamp:new Date().toISOString(),
            runtimeSessionRef:`fake-session-${runId}`
        });

        this.emit({
            type:"text_delta",
            runId,
            timestamp:new Date().toISOString(),
            delta:"Fake Agent的模拟输出",
        });

        for (
            let delivery = 0;
            delivery < this.modelEventDeliveries;
            delivery += 1
        ) {
            this.emit({
                type: "model_started",
                runId,
                timestamp: new Date().toISOString(),
                modelCallId: "fake-model-call-1",
                provider: "fake-provider",
                model: "fake-model",
            });

            this.emit({
                type: "model_completed",
                runId,
                timestamp: new Date().toISOString(),
                modelCallId: "fake-model-call-1",
                provider: "fake-provider",
                model: "fake-model",
                durationMs: 25,
                stopReason: "stop",
                usage: {
                    inputTokens: 100,
                    outputTokens: 20,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    reasoningTokens: null,
                    totalTokens: 120,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
            });
        }

        for (
            let delivery = 0;
            delivery < this.toolEventDeliveries;
            delivery += 1
        ) {
            this.emit({
                type: "tool_started",
                runId,
                timestamp: new Date().toISOString(),
                toolCallId: "fake-tool-call-1",
                toolName: "read",
                arguments: {
                    path: "src/index.ts",
                },
            });

            this.emit({
                type: "tool_completed",
                runId,
                timestamp: new Date().toISOString(),
                toolCallId: "fake-tool-call-1",
                toolName: "read",
                result: "Fake 工具结果",
                isError: false,
            });
        }

        if (this.outcome === "failed"){
            this.emit({
                type:"agent_failed",
                runId,
                timestamp:new Date().toISOString(),
                message:"Fake Agent执行失败"
            });
            return;
        }

        this.emit({
            type:"agent_completed",
            runId,
            timestamp:new Date().toISOString(),
        });
    }

    async resume(request:RuntimeResumeRequest):Promise<void>{
        this.resumeRequests.push(request);

        const runId = request.run.runId;

        this.emit({
            type:"agent_resumed",
            runId,
            timestamp:new Date().toISOString(),
            checkpointId:request.checkpoint.checkpointId,
            runtimeSessionRef:request.checkpoint.runtimeSessionRef
            
        });

        this.emit({
            type:"text_delta",
            runId,
            timestamp:new Date().toISOString(),
            delta:"Fake Agent恢复后的模拟输出",
        });

        this.emit({
            type:"agent_completed",
            runId,
            timestamp:new Date().toISOString(),
        });

    };

    async interrupt(runId: string): Promise<void> {
        this.interruptedRunIds.push(runId);
    }
}
