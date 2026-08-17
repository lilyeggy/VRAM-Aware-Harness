/**
 * 这个文件定义资源准入策略
 * 大白话说：就是根据当前的资源情况，能不能执行任务？
 */

import type { ResourceClassification, ResourcePressure } from "./resource-classifier.ts";
import type { ResourceObservationFailureReason } from "./resource-observer.ts";

// 具体执行的动作以及原因
export type PolicyAction = 
    | "START"
    | "QUEUE";

export type PolicyReasonCode = 
    | "RESOURCE_NORMAL"
    | "GLOBAL_CONCURRENCY_LIMIT"
    | "RESOURCE_BUSY_TENANT_AVAILABLE"
    | "RESOURCE_BUSY_TENANT_LIMIT"
    | "RESOURCE_CRITICAL"
    | "RESOURCE_UNKNOWN"
    | "RESOURCE_OBSERVATION_FAILED";

// 策略需要的上下文
export interface ExecutionPolicyInput {
    runId:string;
    tenantId:string;

    classification : ResourceClassification,

    activeRunCount:number;
    activeTenantRunCount:number;
}

// 并发配置：最大存活 run 数量
export interface ExecutionPolicyConfig {
    maxActiveRuns:number;
}

// 决策结果
export interface PolicyDecision {
    decisionId:string;
    runId:string;

    action:PolicyAction;
    reasonCode:PolicyReasonCode;

    resourceSnapshotId:string | null;
    pressure:ResourcePressure;

    observationFailureReason:ResourceObservationFailureReason | null;

    decidedAt:string;
}

export interface ExecutionPolicy {
    decide(input:ExecutionPolicyInput) : PolicyDecision;
}

export class DeterministicExecutionPolicy implements ExecutionPolicy{
    constructor(
        private readonly config:ExecutionPolicyConfig,
    ) {
        if (
            !Number.isInteger(config.maxActiveRuns) || config.maxActiveRuns <= 0
        ){
            throw new Error(
                "maxActiveRuns必须为正整数"
            );
        }
    }

    decide(
        input:ExecutionPolicyInput,
    ):PolicyDecision{
        const pressure = input.classification.pressure;
        switch(pressure){
            case "CRITICAL":
                return this.createDecision(
                    input,
                    "QUEUE",
                    "RESOURCE_CRITICAL",
                );
            case "UNKNOWN":
                return this.createDecision(
                    input,
                    "QUEUE",
                    "RESOURCE_UNKNOWN",
                );
            case "BUSY":
                if (
                    input.activeRunCount >=
                    this.config.maxActiveRuns
                ) {
                    return this.createDecision(
                        input,
                        "QUEUE",
                        "GLOBAL_CONCURRENCY_LIMIT",
                    );
                }

                if (input.activeTenantRunCount > 0) {
                    return this.createDecision(
                        input,
                        "QUEUE",
                        "RESOURCE_BUSY_TENANT_LIMIT",
                    );
                }

                return this.createDecision(
                    input,
                    "START",
                    "RESOURCE_BUSY_TENANT_AVAILABLE",
                );

            case "NORMAL":
                if (
                    input.activeRunCount >=
                    this.config.maxActiveRuns
                ) {
                    return this.createDecision(
                        input,
                        "QUEUE",
                        "GLOBAL_CONCURRENCY_LIMIT",
                    );
                }

                return this.createDecision(
                    input,
                    "START",
                    "RESOURCE_NORMAL",
                );
        }
    }

    private createDecision(
        input:ExecutionPolicyInput,
        action:PolicyAction,
        reasonCode : PolicyReasonCode,
    ):PolicyDecision{
        return {
            decisionId:crypto.randomUUID(),
            runId:input.runId,
            action,
            reasonCode,
            resourceSnapshotId:input.classification.snapshotId,
            pressure:input.classification.pressure,
            decidedAt:new Date().toISOString(),
            observationFailureReason:null,
        };
    }
}
