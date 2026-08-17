import type{AgentRun} from "../runs/agent-run.ts";
import type { RunQueueCoordinator } from "../scheduling/run-queue-coordinator.ts";
import type { RunRecoveryPlan } from "./recovery-service.ts";



export interface RecoveryExecutionResult {
    runId:string;
    status : "QUEUED" | "MANUAL_REVIEW" | "FAILED";
    run : AgentRun | null;
    errorMessage : string | null;
}

// 这个是执行恢复
export class RecoveryExecutor {
    constructor(
        private readonly coordinator:
            Pick<RunQueueCoordinator, "submitResume">,
    ) {}

    async execute(
        plans : readonly RunRecoveryPlan[],
    ):Promise<RecoveryExecutionResult []>{
        const results : RecoveryExecutionResult[] = [];


        // 现在发现这个逻辑，流程上基本都是这样：真正执行前先判断，然后再执行
        // 先检查checkpoint是否存在
        for (const plan of plans ){
            if (plan.decision.action === "MANUAL_REVIEW"){
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
                    continuationInput : "请从恢复点继续完成任务"
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


}

