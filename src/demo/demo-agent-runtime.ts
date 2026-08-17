import type {
    AgentRuntime,
    RuntimeEvent,
    RuntimeEventHandler,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "../runtime/agent-runtime.ts";

/** 只用于本地演示控制流，不发起任何模型或工具请求。 */
export class DemoAgentRuntime implements AgentRuntime {
    private readonly handlersByRunId =
        new Map<string,Set<RuntimeEventHandler>>();

    readonly startRequests:RuntimeStartRequest[] = [];
    readonly resumeRequests:RuntimeResumeRequest[] = [];
    readonly interruptRequests:string[] = [];

    subscribe(
        runId:string,
        handler:RuntimeEventHandler,
    ):() => void {
        let handlers = this.handlersByRunId.get(runId);

        if (handlers === undefined) {
            handlers = new Set();
            this.handlersByRunId.set(runId, handlers);
        }

        handlers.add(handler);

        return () => {
            handlers?.delete(handler);

            if (handlers?.size === 0) {
                this.handlersByRunId.delete(runId);
            }
        };
    }

    async start(request:RuntimeStartRequest):Promise<void> {
        this.startRequests.push(request);
        const timestamp = new Date().toISOString();

        this.emit({
            type:"agent_started",
            runId:request.run.runId,
            timestamp,
            runtimeSessionRef:`demo-session-${request.run.runId}`,
        });
        this.emit({
            type:"text_delta",
            runId:request.run.runId,
            timestamp:new Date().toISOString(),
            delta:"演示 Agent 已接收任务：控制面已完成准入、调度与执行状态收敛。",
        });
        this.emit({
            type:"agent_completed",
            runId:request.run.runId,
            timestamp:new Date().toISOString(),
        });
    }

    async resume(request:RuntimeResumeRequest):Promise<void> {
        this.resumeRequests.push(request);
        this.emit({
            type:"agent_resumed",
            runId:request.run.runId,
            timestamp:new Date().toISOString(),
            checkpointId:request.checkpoint.checkpointId,
            runtimeSessionRef:request.checkpoint.runtimeSessionRef,
        });
        this.emit({
            type:"text_delta",
            runId:request.run.runId,
            timestamp:new Date().toISOString(),
            delta:"演示 Agent 已从 Checkpoint 恢复并完成任务。",
        });
        this.emit({
            type:"agent_completed",
            runId:request.run.runId,
            timestamp:new Date().toISOString(),
        });
    }

    async interrupt(runId:string):Promise<void> {
        this.interruptRequests.push(runId);
        this.emit({
            type:"agent_interrupted",
            runId,
            timestamp:new Date().toISOString(),
        });
    }

    private emit(event:RuntimeEvent):void {
        for (const handler of this.handlersByRunId.get(event.runId) ?? []) {
            handler(event);
        }
    }
}
