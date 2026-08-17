import type { Checkpoint } from "./checkpoint.ts";
import { CheckpointStore } from "./checkpoint-store.ts";
import {
    decideRecovery,
    type RecoveryDecision,
} from "./recovery-decision.ts";
import type {
    AgentRun,
    RunEvent,
} from "../runs/agent-run.ts";
import { RunStore } from "../runs/runstore.ts";
import type { ToolExecution } from "../tools/tool-execution.ts";
import {
    ToolExecutionStore,
} from "../tools/tool-execution-store.ts";

export interface RunRecoveryPlan {
    run: AgentRun;
    checkpoint: Checkpoint | null;
    preparedExecutions: readonly ToolExecution[];
    decision: RecoveryDecision;
}

/**
 * 扫描旧进程留下的活跃 Run，并把数据库状态修正为 INTERRUPTED。
 *
 * 这一层只建立恢复计划，不直接调用 AgentRuntime：
 * - 扫描和状态修正是同步、确定性的数据库工作；
 * - Runtime resume 是可能失败的外部执行，应由下一层逐个消费计划。
 */
export class RecoveryService {
    constructor(
        private readonly runStore: RunStore,
        private readonly toolExecutionStore:
            ToolExecutionStore,
        private readonly checkpointStore: CheckpointStore,
    ) {}

    scanInterruptedRuns(): RunRecoveryPlan[] {
        return this.runStore
            .listActiveRuns()
            .map((activeRun) => this.buildPlan(activeRun));
    }

    private buildPlan(activeRun: AgentRun): RunRecoveryPlan {
        const preparedExecutions =
            this.toolExecutionStore.listPreparedForRun(
                activeRun.id,
            );
        const checkpoint = this.getValidCheckpoint(activeRun);
        const decision = decideRecovery(
            checkpoint?.id ?? null,
            preparedExecutions,
        );
        const timestamp = new Date().toISOString();

        const interruptedRun: AgentRun = {
            ...activeRun,
            status: "INTERRUPTED",
            updatedAt: timestamp,
        };
        const interruptedEvent: RunEvent = {
            eventId: crypto.randomUUID(),
            runId: activeRun.id,
            sequence:
                this.runStore.getLastEventSequence(
                    activeRun.id,
                ) + 1,
            type: "RUN_INTERRUPTED",
            timestamp,
            payloadVersion: 1,
            payload: {
                reason: "PROCESS_RESTART",
                recoveryAction: decision.action,
                recoveryReason: decision.reason,
                blockingToolExecutionId:
                    decision.blockingToolExecutionId,
            },
        };

        this.runStore.update(
            interruptedRun,
            interruptedEvent,
        );

        return {
            run: interruptedRun,
            checkpoint,
            preparedExecutions,
            decision,
        };
    }

    /**
     * agent_runs.checkpoint_id 目前没有 SQLite 外键，因此这里主动校验
     * Checkpoint 是否存在且确实属于当前 Run；不一致时按“无恢复点”处理。
     */
    private getValidCheckpoint(
        run: AgentRun,
    ): Checkpoint | null {
        if (run.checkpointId === null) {
            return null;
        }

        const checkpoint =
            this.checkpointStore.get(run.checkpointId);

        if (
            checkpoint === null
            || checkpoint.runId !== run.id
        ) {
            return null;
        }

        return checkpoint;
    }
}
