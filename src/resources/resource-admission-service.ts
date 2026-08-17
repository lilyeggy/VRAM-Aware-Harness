/**
 * 我们前面已经写了
 * 1. 我们能够观测到的资源事实：ResourceSnapshot
 * 2. 我们如何获取单次的资源事实：ResourceObserver
 * 3. 我们根据当前事实判断，能否执行当前 Run：
 * 这部分分为：用于给当前资源情况分类的Resourceclassifier 和用于判断执行策略的ExecutionPolicy
 * 但是这些都是分散的模块，没有整合在一起，所以我们需要用一个service服务去把这些内容整合起来
 */

import type { ExecutionPolicy, PolicyDecision } from "./execution-policy.ts";
import type {
    PolicyDecisionRecorder,
} from "./policy-decision-store.ts";
import { classifyResource } from "./resource-classifier.ts";
import type { ResourceClassification, ResourceThresholds } from "./resource-classifier.ts";
import type { ResourceObservation,ResourceObserver } from "./resource-observer.ts";

// 这可以认为是输入
// 单纯的ResourceObserver 无法判断当前的 run 是哪个，当前的 tenant 是哪个
export interface ResourceAdmissionRequest {
    runId:string;
    tenantId:string;

    activeRunCount:number;
    activeTenantRunCount:number;
}

// 来了需求以后，我们要对根据当前需求和资源情况，输出一个判决结果
// 能够看到，其实就是三类，我们上面说的：
// 1. 当前观测结果
// 2. 对当前资源观测情况进行的分类结果
// 3. 对当前资源观测结果进行的行为判决
export interface ResourceAdmissionResult {
    observation : ResourceObservation;
    classification : ResourceClassification | null;
    decision:PolicyDecision;
}

export interface ResourceAdmissionEvaluator {
    evaluate(
        request: ResourceAdmissionRequest,
    ): Promise<ResourceAdmissionResult>;
}

export class ResourceAdmissionService
implements ResourceAdmissionEvaluator {
    constructor(
        private readonly observer : ResourceObserver,
        private readonly thresholds:ResourceThresholds,
        private readonly policy:ExecutionPolicy,
        private readonly decisionRecorder:PolicyDecisionRecorder,
    ) {}

    async evaluate(
        request:ResourceAdmissionRequest,
    ):Promise<ResourceAdmissionResult>{
        // 整个流程就是，我们首先观测，然后判断当前观测结果是成功还是失败
        // 接下来根据判断结果，产生分类结果
        const observation = await this.observer.observe();
        // 观测失败的情况下
        if (!observation.ok){
            const decision : PolicyDecision = {
                decisionId:crypto.randomUUID(),
                runId:request.runId,
                action:"QUEUE",
                reasonCode:"RESOURCE_OBSERVATION_FAILED",
                resourceSnapshotId:null,
                pressure:"UNKNOWN",
                observationFailureReason:observation.reason,
                decidedAt:new Date().toISOString(),
            };

            this.decisionRecorder.save(decision, null);

            return {
                observation,
                classification:null,
                decision,
            }
        }

        // 观测成功的情况
        const classification = classifyResource(
            observation.snapshot,
            this.thresholds,
        );

        // 观测成功的情况下，我们需要给策略提供上下文，让它决策
        const decision = this.policy.decide({
            runId:request.runId,
            tenantId:request.tenantId,
            classification,
            activeRunCount:request.activeRunCount,
            activeTenantRunCount:request.activeTenantRunCount,
        });

        this.decisionRecorder.save(
            decision,
            observation.snapshot,
        );

        return {
            observation,
            classification,
            decision,
        }
    }
}
