/**
 * 协调 AgentRun 持久化和 AgentRuntime 执行。
 */

import {
    RuntimeEventBridge,
} from "../events/runtime-event-bridge.ts";
import type {AgentRuntime} from "../runtime/agent-runtime.ts"
import type { Checkpoint } from "../checkpoints/checkpoint.ts";
import type {
    AgentRun,
    RunEvent,
} from "./agent-run.ts"
import type { RunStore } from "./runstore.ts"
import type { PolicyConstraints } from "../policies/effective-policy.ts";
import type { RunOutputStore } from "./run-output-store.ts";
import type { RunWorkspaceResultCoordinator } from "../workspaces/run-workspace-result.ts";


export interface StartRunInput {
    tenantId : string;
    harnessSessionId : string;
    userInput : string;
    workspacePath : string;
    runPolicy?: PolicyConstraints;
}

export interface RunControlBinding {
    readonly templateVersionId: string;
    readonly harnessInstanceId: string;
}

export interface RunControlBindingResolver {
    resolve(input: StartRunInput): RunControlBinding;
}

export interface ResumeRunInput {
    runId: string;
    checkpoint: Checkpoint;
    continuationInput: string;
}

export class RunService{
    constructor(
        private readonly store : RunStore,
        private readonly runtime : AgentRuntime,
        private readonly controlBindingResolver?: RunControlBindingResolver,
        private readonly eventBridge = new RuntimeEventBridge(),
        private readonly outputStore?: RunOutputStore,
        private readonly workspaceResults?: RunWorkspaceResultCoordinator,
    ) {}

    // 创建并持久化Queued Run
    createQueuedRun(input : StartRunInput) : AgentRun {
        const runId = crypto.randomUUID(); 
        const timestamp = new Date().toISOString();
        const controlBinding = this.controlBindingResolver?.resolve(input);

        // 创建真实的 AgentRun
        const run : AgentRun = {
            id:runId,
            tenantId:input.tenantId,
            harnessSessionId:input.harnessSessionId,
            status : "QUEUED",
            userInput:input.userInput,
            workspacePath:input.workspacePath,
            createdAt:timestamp,
            updatedAt:timestamp,
            startedAt:null,
            finishedAt:null,
            checkpointId:null,
            failureReason:null,
            ...(input.runPolicy === undefined
                ? {}
                : { runPolicy: input.runPolicy }),
            ...(controlBinding ?? {}),
        };

        // 创建 run 以后要创建对应的 event
        const createdEvent : RunEvent = {
            eventId:crypto.randomUUID(),
            runId,
            sequence:1,
            type:"RUN_CREATED",
            timestamp,
            payloadVersion:1,
            payload:{},
        };

        // 将 run 与 event 对应的存储起来
        this.store.create(run,createdEvent);

        return run;
    }

    async executeQueuedRun(runId:string) : Promise<AgentRun> {
        // 主要任务是：检验队列情况，判断是否具备执行情况
        const run = this.getRequiredRun(runId);

        if (run.status !== "QUEUED") {
            throw new Error(
                `只有 QUEUED Run 可以开始执行:${runId}`,
            );
        }

        const startedAt = new Date().toISOString();
        await this.workspaceResults?.captureBefore(runId, run.workspacePath);

        const runningRun: AgentRun = {
            ...run, // 复制原先的 run 的所有字段，然后覆盖发生变化的字段
            status : "RUNNING",
            updatedAt:startedAt,
            startedAt,
        }

        const startedEvent : RunEvent = {
            eventId : crypto.randomUUID(),
            runId,
            sequence : this.store.getLastEventSequence(runId) + 1,
            type:"RUN_STARTED",
            timestamp:startedAt,
            payloadVersion:1,
            payload:{},
        };

        this.store.update(runningRun,startedEvent);

        const unsubscribe = this.subscribeToRuntime(runId);

        try {
            await this.runtime.start({
                run: {
                    runId:run.id,
                    tenantId: run.tenantId,
                    harnessSessionId: run.harnessSessionId,
                    workspacePath: run.workspacePath,
                    ...(run.templateVersionId === undefined
                        ? {}
                        : { templateVersionId: run.templateVersionId }),
                    ...(run.harnessInstanceId === undefined
                        ? {}
                        : { harnessInstanceId: run.harnessInstanceId }),
                },
                input: run.userInput,
            });
        } catch (error) {
            this.markRuntimeInvocationFailureInterrupted(
                runId,
                error,
                "START_FAILED",
            );
            throw error;
        } 
        finally {
            unsubscribe();
            // Even an interrupted/failed attempt can leave user files behind; preserve that evidence.
            await this.workspaceResults?.captureAfter(runId, run.workspacePath);
            const current = this.store.get(runId);
            if (current?.status === "COMPLETED" || current?.status === "FAILED") {
                await this.workspaceResults?.captureArtifacts(runId, run.workspacePath);
            }
        }

        const finalRun = this.store.get(runId);

        if (finalRun === null) {
            throw new Error(`Runtime 执行后找不到 AgentRun: ${runId}`);
        }
        return finalRun;
    }

    async start (input:StartRunInput) : Promise<AgentRun> {
        const run = this.createQueuedRun(input);

        return this.executeQueuedRun(run.id);

    }

    queueResume(input:ResumeRunInput) : AgentRun {
        const interruptedRun = this.getRequiredRun(input.runId);

        if (interruptedRun.status !== "INTERRUPTED") {
            throw new Error(
                `只有 INTERRUPTED Run 可以恢复：${input.runId}`,
            );
        }

        if (
            input.checkpoint.runId !== input.runId
            || interruptedRun.checkpointId !== input.checkpoint.id
        ) {
            throw new Error(
                `Checkpoint ${input.checkpoint.id} 不属于当前 Run`,
            );
        }

        const queuedAt = new Date().toISOString();
        const queuedRun: AgentRun = {
            ...interruptedRun,
            status: "QUEUED",
            updatedAt: queuedAt,
        };

        this.store.update(queuedRun, {
            eventId: crypto.randomUUID(),
            runId: input.runId,
            sequence: this.store.getLastEventSequence(input.runId) + 1,
            type: "RUN_QUEUED",
            timestamp: queuedAt,
            payloadVersion: 1,
            payload: {
                checkpointId: input.checkpoint.id,
                reason: "AUTO_RECOVERY",
            },
        });

        return queuedRun;
    }

    async executeQueuedResume(
        input : ResumeRunInput,
    ):Promise<AgentRun> { 
        const queuedRun = this.getRequiredRun(input.runId);
        if (queuedRun.status !== "QUEUED") {
            throw new Error(
                `只有QUEUED RUN可以执行恢复:${input.runId}`
            );
        }

        if (input.checkpoint.runId !== input.runId 
            || queuedRun.checkpointId !== input.checkpoint.id
        )   {
            throw new Error (
                `Checkpoint ${input.checkpoint.id} 不属于当前Run`
            )
        }
        

        const resumedAt = new Date().toISOString();
        const runningRun: AgentRun = {
            ...queuedRun,
            status: "RUNNING",
            updatedAt: resumedAt,
        };

        this.store.update(runningRun, {
            eventId: crypto.randomUUID(),
            runId: input.runId,
            sequence: this.store.getLastEventSequence(input.runId) + 1,
            type: "RUN_RESUMED",
            timestamp: resumedAt,
            payloadVersion: 1,
            payload: {
                checkpointId: input.checkpoint.id,
            },
        });

        // 必须先订阅再调用 resume，否则同步发出的首批 RuntimeEvent 会丢失。
        const unsubscribe = this.subscribeToRuntime(input.runId);

        try {
            await this.runtime.resume({
                run: {
                    runId: runningRun.id,
                    tenantId: runningRun.tenantId,
                    harnessSessionId: runningRun.harnessSessionId,
                    workspacePath: runningRun.workspacePath,
                    ...(runningRun.templateVersionId === undefined
                        ? {}
                        : { templateVersionId: runningRun.templateVersionId }),
                    ...(runningRun.harnessInstanceId === undefined
                        ? {}
                        : { harnessInstanceId: runningRun.harnessInstanceId }),
                },
                checkpoint: {
                    checkpointId: input.checkpoint.id,
                    runtimeSessionRef:
                        input.checkpoint.runtimeSessionRef,
                    lastEventSequence:
                        input.checkpoint.lastEventSequence,
                },
                continuationInput: input.continuationInput,
            });
        } catch (error) {
            this.markRuntimeInvocationFailureInterrupted(input.runId, error,"RESUME_FAILED");
            throw error;
        } finally {
            unsubscribe();
            // The original BEFORE snapshot remains durable, so resumed work updates one whole-Run diff.
            await this.workspaceResults?.captureAfter(input.runId, runningRun.workspacePath);
            const current = this.store.get(input.runId);
            if (current?.status === "COMPLETED" || current?.status === "FAILED") {
                await this.workspaceResults?.captureArtifacts(input.runId, runningRun.workspacePath);
            }
        }
        return this.getRequiredRun(input.runId);
    }


    /**
     * 从已经确认安全的 Checkpoint 恢复一个 INTERRUPTED Run。
     *
     * RecoveryDecision 负责判断“能不能自动恢复”，这里负责真正编排：
     * INTERRUPTED -> QUEUED -> RUNNING -> 最终状态。
     */
    async resume(input: ResumeRunInput): Promise<AgentRun> {
        this.queueResume(input);
        return this.executeQueuedResume(input);
    }

    async interrupt (
        runId : string,
        reason = "USER_REQUEST",
    ) : Promise<AgentRun> {
        const run = this.getRequiredRun(runId);

        if (run.status === "INTERRUPTED") {
            return run;
        }

        if (run.status === "COMPLETED" || run.status === "FAILED") {
            throw new Error (`终态 Run 不能中断:${runId}`);
        }

        if (
            run.status === "RUNNING"
            || run.status === "WAITING_TOOL"
        ) {
            await this.runtime.interrupt(runId);
        }

        const currentRun = this.getRequiredRun(runId);

        if (currentRun.status === "INTERRUPTED") {
            return currentRun;
        }

        if (
            currentRun.status === "COMPLETED"
            || currentRun.status === "FAILED"
        ) {
            return currentRun;
        }

        const timestamp = new Date().toISOString();
        const interruptedRun : AgentRun = {
            ...currentRun,
            status : "INTERRUPTED",
            updatedAt:timestamp,
        }

        this.store.update(interruptedRun,{
            eventId:crypto.randomUUID(),
            runId,
            sequence:this.store.getLastEventSequence(runId) + 1,
            type : "RUN_INTERRUPTED",
            timestamp,
            payloadVersion:1,
            payload:{
                reason,
            }
        });

        return interruptedRun;
    }

    /**
     * start 和 resume 共用同一套 RuntimeEvent -> RunEvent 处理。
     * 每次订阅都从数据库最后一个 sequence 继续，恢复时不需要猜测序号。
     */
    private subscribeToRuntime(runId: string): () => void {
        let nextEventSequence =
            this.store.getLastEventSequence(runId) + 1;

        return this.runtime.subscribe(runId, (event) => {
            if (event.type === "text_delta") {
                this.outputStore?.append(runId, event.delta);
                return;
            }
            const draft = this.eventBridge.map(event);

            if (draft !== null) {
                const inserted = this.store.appendEventIfNew({
                    eventId: crypto.randomUUID(),
                    sequence: nextEventSequence,
                    ...draft,
                });

                if (inserted) {
                    nextEventSequence += 1;
                }

                return;
            }

            if (event.type === "agent_completed") {
                const currentRun = this.getRequiredRun(runId);

                if (
                    currentRun.status === "COMPLETED"
                    || currentRun.status === "FAILED"
                ) {
                    return;
                }

                this.store.update(
                    {
                        ...currentRun,
                        status: "COMPLETED",
                        updatedAt: event.timestamp,
                        finishedAt: event.timestamp,
                    },
                    {
                        eventId: crypto.randomUUID(),
                        runId,
                        sequence: nextEventSequence,
                        type: "RUN_COMPLETED",
                        timestamp: event.timestamp,
                        payloadVersion: 1,
                        payload: {},
                    },
                );
                nextEventSequence += 1;
                return;
            }

            if (event.type === "agent_failed") {
                const currentRun = this.getRequiredRun(runId);

                if (
                    currentRun.status === "COMPLETED"
                    || currentRun.status === "FAILED"
                ) {
                    return;
                }

                this.store.update(
                    {
                        ...currentRun,
                        status: "FAILED",
                        updatedAt: event.timestamp,
                        finishedAt: event.timestamp,
                        failureReason: event.message,
                    },
                    {
                        eventId: crypto.randomUUID(),
                        runId,
                        sequence: nextEventSequence,
                        type: "RUN_FAILED",
                        timestamp: event.timestamp,
                        payloadVersion: 1,
                        payload: {
                            message: event.message,
                        },
                    },
                );
                nextEventSequence += 1;
                return;
            }

            if (event.type === "agent_interrupted") {
                const currentRun = this.getRequiredRun(runId);

                if (currentRun.status === "INTERRUPTED") {
                    return;
                }

                this.store.update(
                    {
                        ...currentRun,
                        status: "INTERRUPTED",
                        updatedAt: event.timestamp,
                    },
                    {
                        eventId: crypto.randomUUID(),
                        runId,
                        sequence: nextEventSequence,
                        type: "RUN_INTERRUPTED",
                        timestamp: event.timestamp,
                        payloadVersion: 1,
                        payload: {
                            reason: "RUNTIME_INTERRUPTED",
                        },
                    },
                );
                nextEventSequence += 1;
            }
        });
    }

    /**
     * Runtime 可能在成功打开 Session 之前就抛错，此时不会产生
     * agent_failed/agent_interrupted 事件。Run 不能继续停留在 RUNNING，
     * 但 Checkpoint 仍然有效，所以退回 INTERRUPTED 等待再次恢复或人工检查。
     */
    private markRuntimeInvocationFailureInterrupted(
        runId: string,
        error: unknown,
        reason:"START_FAILED" | "RESUME_FAILED"
    ): void {
        const currentRun = this.getRequiredRun(runId);

        // Runtime 已经发出终态事件时，以已持久化的终态为准。
        if (
            currentRun.status !== "RUNNING"
            && currentRun.status !== "WAITING_TOOL"
        ) {
            return;
        }

        const timestamp = new Date().toISOString();
        const message =
            error instanceof Error
                ? error.message
                : String(error);

        this.store.update(
            {
                ...currentRun,
                status: "INTERRUPTED",
                updatedAt: timestamp,
            },
            {
                eventId: crypto.randomUUID(),
                runId,
                sequence:
                    this.store.getLastEventSequence(runId) + 1,
                type: "RUN_INTERRUPTED",
                timestamp,
                payloadVersion: 1,
                payload: {
                    reason: reason,
                    message,
                },
            },
        );
    }

    private getRequiredRun(runId: string): AgentRun {
        const run = this.store.get(runId);

        if (run === null) {
            throw new Error(`找不到 AgentRun:${runId}`);
        }

        return run;
    }


    
}
