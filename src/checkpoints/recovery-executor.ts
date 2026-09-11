import type{AgentRun} from "../runs/agent-run.ts";
import { buildRecoveryContinuationInput } from "../runs/run-service.ts";
import type { RunQueueCoordinator } from "../scheduling/run-queue-coordinator.ts";
import {
    decideRecovery,
    type RecoveryDecision,
} from "./recovery-decision.ts";
import type { RunRecoveryPlan } from "./recovery-service.ts";



export interface RecoveryExecutionResult {
    runId:string;
    status : "QUEUED" | "MANUAL_REVIEW" | "FAILED";
    run : AgentRun | null;
    errorMessage : string | null;
}

/**
 * 支柱 3：人工转办审计回调。
 *
 * MANUAL_REVIEW 不是静默跳过：决策与阻断工具必须写进 Run 事件时间线，
 * 运维据此人工确认后才能继续推进（人工 resume 走既有 API 路径）。
 */
export type RecoveryManualReviewAuditor = (
    plan:RunRecoveryPlan,
    decision:RecoveryDecision,
) => void;

// 这个是执行恢复
export class RecoveryExecutor {
    constructor(
        private readonly coordinator:
            Pick<RunQueueCoordinator, "submitResume">,
        private readonly onManualReview?:RecoveryManualReviewAuditor,
    ) {}

    async execute(
        plans : readonly RunRecoveryPlan[],
    ):Promise<RecoveryExecutionResult []>{
        const results : RecoveryExecutionResult[] = [];


        // 现在发现这个逻辑，流程上基本都是这样：真正执行前先判断，然后再执行
        // 先检查checkpoint是否存在
        for (const plan of plans ){
            // 支柱 3：执行前重新校验恢复决策（fail closed）。
            // 计划可能来自旧的扫描快照或被上层错误改写：即便 plan 声称
            // AUTO_RESUME，只要按当前工具副作用历史重算出 MANUAL_REVIEW，
            // 就坚决拒绝自动重放——未证明幂等/未知副作用一律转人工。
            const effectiveDecision = plan.decision.action === "AUTO_RESUME"
                ? decideRecovery(
                    plan.checkpoint?.id ?? null,
                    plan.preparedExecutions,
                )
                : plan.decision;

            if (effectiveDecision.action === "MANUAL_REVIEW"){
                this.auditManualReview(plan, effectiveDecision);
                results.push({
                    runId:plan.run.id,
                    status : "MANUAL_REVIEW",
                    run : plan.run,
                    errorMessage : null,
                });
                continue;
            }

            if (plan.checkpoint === null){
                results.push({
                    runId:plan.run.id,
                    status : "FAILED",
                    run : null,
                    errorMessage : "AUTO_RESUME 恢复计划缺少 Checkpoint",
                });
                continue;
            }
            try{
                const queuedRun = this.coordinator.submitResume({
                    runId : plan.run.id,
                    checkpoint : plan.checkpoint,
                    continuationInput : buildRecoveryContinuationInput(
                        plan.run.userInput,
                        plan.checkpoint.id,
                    )
                });
                results.push({
                    runId:plan.run.id,
                    status:"QUEUED",
                    run:queuedRun,
                    errorMessage:null,
                });
            } catch(error) {
                results.push({
                    runId:plan.run.id,
                    status:"FAILED",
                    run:null,
                    errorMessage:
                        error instanceof Error
                            ? error.message
                            : String(error),
                });
            }
        }



        return results;
    }

    /**
     * MANUAL_REVIEW 落审计证据：Run 保持 INTERRUPTED（不自动推进），
     * 决策原因与阻断工具执行 id 写入事件时间线。
     */
    private auditManualReview(
        plan:RunRecoveryPlan,
        decision:RecoveryDecision,
    ):void {
        try {
            this.onManualReview?.(plan, decision);
        } catch (error) {
            console.error(
                `MANUAL_REVIEW 审计事件写入失败：${plan.run.id}`,
                error,
            );
        }
    }
}
