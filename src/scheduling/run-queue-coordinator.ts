/**
 * 协调 scheduler,runService和resourceAdmissionServer
 * 1. scheduler 层面：什么时候选择
 * 2. runService 层面：选择以后让谁去执行
 */


import type {
    PolicyDecision,
} from "../resources/execution-policy.ts";
import type {
    ResourceAdmissionEvaluator,
} from "../resources/resource-admission-service.ts";
import type {
    AgentRun
}   from "../runs/agent-run.ts";

import type {
    RunService,
    StartRunInput,
    ResumeRunInput,
}   from "../runs/run-service.ts";

import type {
    QueueReasonCode,
    TenantRunScheduler,
}   from "./tenant-run-scheduler.ts";



export type CoordinatorResult =
    | {
        kind: "EMPTY";
    }
    | {
        kind: "DEFERRED";
        runId: string;
        decision: PolicyDecision;
    }
    | {
        kind: "EXECUTED";
        run: AgentRun;
        decision: PolicyDecision;
    };

export function toQueueReasonCode(
    decision: PolicyDecision,
): QueueReasonCode {
    if (decision.action !== "QUEUE") {
        throw new Error(
            `START 决策不能转换成排队原因：${decision.reasonCode}`,
        );
    }

    switch (decision.reasonCode) {
        case "GLOBAL_CONCURRENCY_LIMIT":
            return "GLOBAL_CONCURRENCY_LIMIT";
        case "RESOURCE_BUSY_TENANT_LIMIT":
            return "RESOURCE_BUSY";
        case "RESOURCE_CRITICAL":
            return "RESOURCE_CRITICAL";
        case "RESOURCE_UNKNOWN":
            return "RESOURCE_UNKNOWN";
        case "RESOURCE_OBSERVATION_FAILED":
            return "RESOURCE_OBSERVATION_FAILED";
        case "TENANT_BUDGET_EXCEEDED":
            return "TENANT_BUDGET_EXCEEDED";
        case "RESOURCE_NORMAL":
        case "RESOURCE_BUSY_TENANT_AVAILABLE":
            throw new Error(
                `START reason 不能作为排队原因：${decision.reasonCode}`,
            );
    }
}

export class RunQueueCoordinator  {
    constructor(
        private readonly runService:RunService,
        private readonly scheduler:TenantRunScheduler,
        private readonly admission: ResourceAdmissionEvaluator,
        private readonly pendingResumeByRunId = new Map<string,ResumeRunInput>(),
        private drainPromise: Promise<CoordinatorResult[]> | null = null, // 当前是否有drain正在运行
        private drainRequested = false, // 正在运行期间，是否又收到了新的推进请求
        
    ) {}
    // submit只负责把用户任务变成 run 队列
    submit(input:StartRunInput) : AgentRun {
        // 接收到用户任务输入后，创建对应持久化的Queued Run
        const run = this.runService.createQueuedRun(input);

        // 把对应的 run 入队
        this.scheduler.enqueue({
            runId:run.id,
            tenantId:run.tenantId,
            sessionId:run.harnessSessionId,
        })

        // 返回 Queued Run
        return run;
    }

    restoreQueuedRun(run:AgentRun):AgentRun {
        if (run.status !== "QUEUED") {
            throw new Error(`只能恢复 QUEUED Run 到调度队列：${run.id}`);
        }

        this.scheduler.enqueue({
            runId:run.id,
            tenantId:run.tenantId,
            sessionId:run.harnessSessionId,
        });

        return run;
    }

    async attemptNext() : Promise<CoordinatorResult> {
        // 它做的是把一个等待中的 run 从队列里推进到运行状态，但是不管如何选
        // 如何选这个 run，是scheduler做的事
        // 最终控制流
        /**
         * 1. 没有 Run：Empty
         * 2. 资源拒绝：release -> 重新入队->deferred
         * 3. 资源允许: executeQueuedRun -> finally release -> executed
         */
        // scheduler选择一个 run出来
        const queuedRun = this.scheduler.claimNext();

        if (queuedRun === null) {
            return {
                kind : "EMPTY",
            };
        }

        // 选出 run 的时候，run 已经离开队列并占用了 slot，所以需要更新资源情况
        const capacity = this.scheduler.getCapacity(queuedRun.tenantId);

        const admissionRequest = {
            runId : queuedRun.runId,
            tenantId : queuedRun.tenantId,
            activeRunCount : capacity.activeRunCount - 1,
            activeTenantRunCount : capacity.activeTenantRunCount - 1,
        }

        // 执行资源准入
        let admissionResult;

        
        try {
            // 进行资源情况评估
            admissionResult = await this.admission.evaluate(
                admissionRequest,
            );
        } catch (error) {
            this.scheduler.release(queuedRun.runId);

            // 重新入队，防止 admission 自身异常导致Run从内存队列中丢失
            this.scheduler.enqueue({
                runId : queuedRun.runId,
                tenantId : queuedRun.tenantId,
                ...(queuedRun.sessionId === undefined ? {} : { sessionId: queuedRun.sessionId }),
                reasonCode : "RESOURCE_OBSERVATION_FAILED",
                enqueuedAt : queuedRun.enqueuedAt,
            });
            throw error;
        }

        // 获得资源评估结果
        const decision = admissionResult.decision;

        // 资源评估结果是仍然排队，也就是不执行，那么就release然后重新入队,deferred
        if (decision.action === "QUEUE") {
            const reasonCode = toQueueReasonCode(decision);

            this.scheduler.release(queuedRun.runId);
            // 顺序一定要是先release再 run，否则enqueue会认为 run 仍在执行并拒绝入队
            this.scheduler.enqueue({
                runId:queuedRun.runId,
                tenantId:queuedRun.tenantId,
                ...(queuedRun.sessionId === undefined ? {} : { sessionId: queuedRun.sessionId }),
                reasonCode,
                enqueuedAt:queuedRun.enqueuedAt,
            });

            return {
                kind:"DEFERRED",
                runId:queuedRun.runId,
                decision,
            }
        }

        // 资源评估结果是执行 Run，那么就不排队了

        // 处理start决策
        const resumeInput = this.pendingResumeByRunId.get(queuedRun.runId);
        try {
            const run = 
            resumeInput === undefined
            ? await this.runService.executeQueuedRun(
                queuedRun.runId,
            )
            : await this.runService.executeQueuedResume(
                resumeInput,
            );

            return {
                kind:"EXECUTED",
                run,
                decision,
            };
        } finally {
            if (resumeInput !== undefined){
                this.pendingResumeByRunId.delete(queuedRun.runId);
            }
            // 什么情况下释放 slot？run 完成、失败、runtime 启动抛错、event处理抛错
            this.scheduler.release(queuedRun.runId);
        }
    }
    
    private async drainOnce():Promise<CoordinatorResult[]> {
        const errors:unknown[] = [];
        // 看看当前有多少要处理的请求
        let remainingAttempts = this.scheduler.listQueue().length;

        const results : CoordinatorResult[] = [];

        // 只要还有请求，那么就交给attemptNext去执行
        while(remainingAttempts > 0) {
            const roundPromises = Array.from(
                { length : remainingAttempts },
                () => this.attemptNext(),
            );

            const settledResults = await Promise.allSettled(roundPromises);

            let inspectedCount = 0;

            for (const settledResult of settledResults) {
                if (settledResult.status === "rejected"){
                    errors.push(settledResult.reason);
                    inspectedCount += 1;
                    continue;
                }

                if (settledResult.value.kind !== "EMPTY"){
                    results.push(settledResult.value);
                    inspectedCount += 1;
                }
            }

            if (inspectedCount === 0){
                break;
            }
            remainingAttempts -= inspectedCount;
        }
        if (errors.length === 1){
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(
                errors,
                "多个队列调度尝试执行失败",
            )
        }
        return results;
    }

    private async runDrainLoop():Promise<CoordinatorResult[]> {
        const results: CoordinatorResult[] = [];
        try {
            while(this.drainRequested) {
                // 消费掉当前的请求
                this.drainRequested = false;
                const passResults = await this.drainOnce();
                results.push(...passResults);

                // 如果 drainonce 执行期间又有人调用drain(),
                // drainRequested会重新变成 true，继续下一轮
            }

            return results;
        } finally{
            this.drainPromise = null;
        }
    }



    // attemptNext是单次调用，它只处理一个 run，它的核心思路是选择一个 run，检查资源，然后判断能否执行
    // drain 是会反复调用attemptNext的，它会推进当前队列

    // drain 的主要职责是：1. 遍历当前队列并尽可能启动 Run； 2. 处理多个地方同时发起的 drain 请求
    // drain 是负责“当前有空位，看看哪些 run 可以启动的”
    // attemptNext就是调度一个 run
    drain() : Promise<CoordinatorResult[]> {
        // 每次调用都代表系统状态可能发生了变化
        // 因此至少请求进行一轮队列检查
        this.drainRequested = true;

        // 已经有drain在执行，重复用同一个Promise
        if (this.drainPromise !== null){
            return this.drainPromise;
        }

        // 没有 drain 执行，就启动新的推进循环
        this.drainPromise = this.runDrainLoop();
        return this.drainPromise;
    }

    // drain是这样的：
    // 第一次 drain：创建drainPromise 
    // 开始 drainOnce()

    // 执行过程中第二次drain()
    // -> drainRequested = true
    // 不创建第二个循环
    // 返回现有drainPromise



    submitResume(input:ResumeRunInput) : AgentRun {
        const run = this.runService.queueResume(input);

        return this.restoreQueuedResume(run,input);
    }

    restoreQueuedResume(
        run:AgentRun,
        input:ResumeRunInput,
    ):AgentRun {
        if (run.status !== "QUEUED") {
            throw new Error(
                `只能恢复 QUEUED Run 的恢复调度：${run.id}`,
            );
        }

        if (
            input.runId !== run.id
            || input.checkpoint.runId !== run.id
            || run.checkpointId !== input.checkpoint.id
        ) {
            throw new Error(
                `恢复输入与 QUEUED Run 不匹配：${run.id}`,
            );
        }

        this.pendingResumeByRunId.set(run.id,input);

        try {
            this.scheduler.enqueue({
                runId:run.id,
                tenantId:run.tenantId,
                sessionId:run.harnessSessionId,
            });
        } catch (error) {
            this.pendingResumeByRunId.delete(run.id);
            throw error;
        }

        return run;
    }

    async interrupt(runId:string) : Promise<AgentRun> {
        this.scheduler.removeQueued(runId);
        this.pendingResumeByRunId.delete(runId);

        return this.runService.interrupt(runId);
    }
    
}
