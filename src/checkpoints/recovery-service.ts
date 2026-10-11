import type { Checkpoint } from "./checkpoint.ts";
import { CheckpointStore } from "./checkpoint-store.ts";
import {
    createSessionRefCheck,
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
        /**
         * N18：判定 Checkpoint 引用的运行时会话是否仍然可达。
         * 由装配处注入（生产 = 文件存在性校验）；不注入时保持原有行为。
         */
        private readonly isSessionRefReachable?:
            (runtimeSessionRef:string)=>boolean,
    ) {}

    scanInterruptedRuns(): RunRecoveryPlan[] {
        return this.runStore
            .listActiveRuns()
            .map((activeRun) => this.buildPlan(activeRun));
    }

    /**
     * §9.8 v1.4 Phase 3：为单个已 INTERRUPTED 的 Run 建立恢复计划。
     *
     * 用于 Worker 崩溃 / 租约过期后进程无需重启也能自动恢复：
     * RunService.markLeaseExpired 先把 Run 落成 INTERRUPTED，这里只读取
     * 既有 Checkpoint 与工具副作用证据，不重复写状态/事件。
     */
    planForInterruptedRun(runId: string): RunRecoveryPlan | null {
        const run = this.runStore.get(runId);
        if (run === null || run.status !== "INTERRUPTED") {
            return null;
        }
        const preparedExecutions =
            this.toolExecutionStore.listPreparedForRun(runId);
        const checkpoint = this.getValidCheckpoint(run);
        const decision = decideRecovery(
            checkpoint?.id ?? null,
            preparedExecutions,
            createSessionRefCheck(checkpoint, this.isSessionRefReachable),
        );
        if (decision.reason === "SESSION_REF_UNREACHABLE") {
            console.warn(
                `[recovery] N18 恢复点已损坏，拒绝自动恢复：`
                + `runId=${run.id} checkpointId=${checkpoint?.id}`
                + ` runtimeSessionRef=${String(checkpoint?.runtimeSessionRef)}`,
            );
        }
        return {
            run,
            checkpoint,
            preparedExecutions,
            decision,
        };
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
            createSessionRefCheck(checkpoint, this.isSessionRefReachable),
        );

        // N18：损坏的恢复点必须留下可诊断的痕迹，不能再静默降级。
        if (decision.reason === "SESSION_REF_UNREACHABLE") {
            console.warn(
                `[recovery] N18 恢复点已损坏，拒绝自动恢复：`
                + `runId=${activeRun.id} checkpointId=${checkpoint?.id}`
                + ` runtimeSessionRef=${String(checkpoint?.runtimeSessionRef)}`,
            );
        }

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
