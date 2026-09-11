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
    AgentRunStatus,
    RunEvent,
    ThinkingLevel,
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
    thinkingLevel?: ThinkingLevel;
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

/**
 * B3：自动恢复的续跑输入必须携带用户原始任务语境。
 * 只写"请从恢复点继续完成任务"会让模型丢失目标，续跑变成无的放矢。
 */
export function buildRecoveryContinuationInput(
    userInput: string,
    checkpointId: string,
): string {
    return [
        `你此前在执行下面的任务时被中断，系统已从恢复点（Checkpoint ${checkpointId}）回滚。`,
        "请从中断处继续，完成整个任务；已确认成功的工具结果会被自动复用，不要重复执行已完成的副作用。",
        "原始任务：",
        userInput,
    ].join("\n");
}

/**
 * QUEUED Run 在调度启动前后被并发处置（用户中断 / 排队超时熔断）后的
 * 落点状态。启动方遇到这些状态时放弃启动并交还调度器释放 slot，
 * 而不是把已被接管的 Run 强行推进 RUNNING（真机 A6000 抓到的
 * INTERRUPTED -> RUNNING 非法转换毒丸，见 docs/known-issues A4）。
 */
function isTakenOverByConcurrentHandling(status: AgentRunStatus): boolean {
    return status === "INTERRUPTED" || status === "FAILED";
}

/**
 * N6：把上游（Pi/网关/模型后端）的原始错误归类成可诊断的失败原因。
 *
 * 真机实测暴露两个模糊消息，用户与运维都无从判断：
 * - "Stream ended without finish_reason"：网关请求超时（默认 60s 且当时不可
 *   配置）掐断流式响应；连续重试后以此信息告终，看不出是超时。
 * - "400 status code (no body)"：模型后端拒绝请求（常见于输入超过上下文
 *   上限），无 body 可读。
 * 这里保留原文并前置归类，便于用户自助与排障；不改判定与重试语义。
 */
export function classifyModelFailure(message: string): string {
    if (message.includes("Stream ended without finish_reason")) {
        return `模型流式响应中断（多为单次请求超时或上游断流，原文：${message}）`;
    }
    if (/^4\d\d status code \(no body\)/.test(message.trim())) {
        return `模型后端拒绝请求（HTTP ${message.trim().slice(0, 3)}，常见原因：输入超出模型上下文上限；原文：${message}）`;
    }
    return message;
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
            thinkingLevel: input.thinkingLevel ?? "off",
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

    /** Persist a queue blocker without changing the authoritative Run state. */
    recordQueueBlocked(
        runId: string,
        payload: Record<string, unknown>,
    ): void {
        const run = this.getRequiredRun(runId);

        if (run.status !== "QUEUED") {
            return;
        }

        this.store.appendEvent({
            eventId: crypto.randomUUID(),
            runId,
            sequence: this.store.getLastEventSequence(runId) + 1,
            type: "QUEUE_BLOCKED",
            timestamp: new Date().toISOString(),
            payloadVersion: 1,
            payload,
        });
    }

    /**
     * 支柱 3：把一个仍在排队的 Run 熔断到 FAILED 终态。
     *
     * 用于排队 TTL：任务等待超过 queueTtlMs 仍未获得调度准入时，
     * 与其永久饥饿死等占用队列与计数，不如安全流转到 FAILED 并记录
     * QUEUE_TIMEOUT 失败原因。只允许 QUEUED 状态流转；Run 已经离开
     * 队列（RUNNING/终态）时返回 null，不做任何修改。
     */
    failQueuedRun(
        runId: string,
        reason: string,
        message?: string,
        details?: Record<string, unknown>,
    ): AgentRun | null {
        const run = this.getRequiredRun(runId);

        if (run.status !== "QUEUED") {
            return null;
        }

        const finishedAt = new Date().toISOString();
        const failedMessage =
            message
            ?? `排队超时：Run 等待调度超过 ${reason} 门限仍未获得准入`;

        this.store.update(
            {
                ...run,
                status: "FAILED",
                updatedAt: finishedAt,
                finishedAt,
                failureReason: reason,
            },
            {
                eventId: crypto.randomUUID(),
                runId,
                sequence: this.store.getLastEventSequence(runId) + 1,
                type: "RUN_FAILED",
                timestamp: finishedAt,
                payloadVersion: 1,
                payload: {
                    reason,
                    message: failedMessage,
                    ...details,
                },
            },
        );

        return this.store.get(runId);
    }

    async executeQueuedRun(runId:string) : Promise<AgentRun> {
        // 主要任务是：检验队列情况，判断是否具备执行情况
        const run = this.getRequiredRun(runId);

        if (run.status !== "QUEUED") {
            // 队列启动与并发处置竞态：Run 在排队期间已被中断/熔断时，
            // 不再启动 Runtime，返回当前状态由调度器释放 slot。
            if (isTakenOverByConcurrentHandling(run.status)) {
                return run;
            }
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

        try {
            this.store.update(runningRun,startedEvent);
        } catch (error) {
            // QUEUED -> RUNNING 写入与并发中断竞争：状态机已拒绝本次启动。
            // 此时尚未订阅 Runtime、未调用 start，安全放弃启动并交还当前状态。
            const current = this.store.get(runId);
            if (
                current !== null
                && isTakenOverByConcurrentHandling(current.status)
            ) {
                return current;
            }
            throw error;
        }

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
                    ...(run.thinkingLevel === undefined ? {} : { thinkingLevel: run.thinkingLevel }),
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
            // 等待恢复执行期间被并发处置（用户中断 / 排队超时熔断）：
            // 不再启动 Runtime，返回当前状态由调度器释放 slot。
            if (isTakenOverByConcurrentHandling(queuedRun.status)) {
                return queuedRun;
            }
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

        try {
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
        } catch (error) {
            // QUEUED -> RUNNING 写入与并发中断竞争：状态机已拒绝本次恢复。
            // 此时尚未订阅 Runtime、未调用 resume，安全放弃并交还当前状态。
            const current = this.store.get(input.runId);
            if (
                current !== null
                && isTakenOverByConcurrentHandling(current.status)
            ) {
                return current;
            }
            throw error;
        }

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
                    ...(runningRun.thinkingLevel === undefined ? {} : { thinkingLevel: runningRun.thinkingLevel }),
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
        // 每次插入都从数据库取最新序号：markToolPhase 等带外写入也会推进
        // run_events，闭包内缓存计数器会与它们撞 (run_id, sequence) 唯一约束。
        const nextSequence = () => this.store.getLastEventSequence(runId) + 1;

        return this.runtime.subscribe(runId, (event) => {
            if (event.type === "text_delta") {
                this.outputStore?.append(runId, event.delta);
                return;
            }
            if (event.type === "thinking_delta") {
                this.outputStore?.append(runId, event.delta, "thinking");
                return;
            }
            const draft = this.eventBridge.map(event);

            if (draft !== null) {
                this.store.appendEventIfNew({
                    eventId: crypto.randomUUID(),
                    sequence: nextSequence(),
                    ...draft,
                });

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
                        sequence: nextSequence(),
                        type: "RUN_COMPLETED",
                        timestamp: event.timestamp,
                        payloadVersion: 1,
                        payload: {},
                    },
                );
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
                        failureReason: classifyModelFailure(event.message),
                    },
                    {
                        eventId: crypto.randomUUID(),
                        runId,
                        sequence: nextSequence(),
                        type: "RUN_FAILED",
                        timestamp: event.timestamp,
                        payloadVersion: 1,
                        payload: {
                            message: classifyModelFailure(event.message),
                        },
                    },
                );
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
                        sequence: nextSequence(),
                        type: "RUN_INTERRUPTED",
                        timestamp: event.timestamp,
                        payloadVersion: 1,
                        payload: {
                            reason: "RUNTIME_INTERRUPTED",
                        },
                    },
                );
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

    /**
     * 支柱 1 × 支柱 2：Worker 模式下工具真正执行期间，Run 处于 WAITING_TOOL。
     *
     * 由 WorkerProcessAgentRuntime 在治理桥裁决放行（STARTED）与 COMPLETE 落账
     * （ENDED）时驱动。Run 不在预期状态时静默忽略——Run 可能已被中断/终态化，
     * 此时工具阶段的迟回执不得覆盖终态事实。Worker 在工具执行中崩溃时收不到
     * ENDED，Run 停在 WAITING_TOOL，恢复扫描与 RUNNING 一样转 INTERRUPTED。
     */
    markToolPhase(
        runId: string,
        phase: "STARTED" | "ENDED",
        info: { toolName: string; toolCallId: string },
    ): void {
        const run = this.getRequiredRun(runId);
        const timestamp = new Date().toISOString();

        if (phase === "STARTED") {
            if (run.status !== "RUNNING") {
                return;
            }

            this.store.update(
                {
                    ...run,
                    status: "WAITING_TOOL",
                    updatedAt: timestamp,
                },
                {
                    eventId: crypto.randomUUID(),
                    runId,
                    sequence: this.store.getLastEventSequence(runId) + 1,
                    type: "TOOL_STARTED",
                    timestamp,
                    payloadVersion: 1,
                    payload: info,
                },
            );
            return;
        }

        if (run.status !== "WAITING_TOOL") {
            return;
        }

        this.store.update(
            {
                ...run,
                status: "RUNNING",
                updatedAt: timestamp,
            },
            {
                eventId: crypto.randomUUID(),
                runId,
                sequence: this.store.getLastEventSequence(runId) + 1,
                type: "TOOL_COMPLETED",
                timestamp,
                payloadVersion: 1,
                payload: info,
            },
        );
    }

    private getRequiredRun(runId: string): AgentRun {        const run = this.store.get(runId);

        if (run === null) {
            throw new Error(`找不到 AgentRun:${runId}`);
        }

        return run;
    }


    
}
