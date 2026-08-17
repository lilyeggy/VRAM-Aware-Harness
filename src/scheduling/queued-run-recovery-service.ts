import type {
    CheckpointStore,
} from "../checkpoints/checkpoint-store.ts";
import type {
    RunEvent,
} from "../runs/agent-run.ts";
import type {
    RunStore,
} from "../runs/runstore.ts";
import type {
    RunQueueCoordinator,
} from "./run-queue-coordinator.ts";

/**
 * 在进程启动时，把 SQLite 中的 QUEUED Run 重建到内存 Scheduler。
 *
 * 恢复任务还需要重建 ResumeRunInput，否则会被错误地当成全新 Run 启动。
 * RUN_QUEUED 事件中的 checkpointId 是这项重建所需的持久化证据。
 */
export class QueuedRunRecoveryService {
    constructor(
        private readonly runStore:
            Pick<RunStore, "listQueuedRuns" | "listEvents">,
        private readonly checkpointStore:
            Pick<CheckpointStore, "get">,
        private readonly coordinator: Pick<
            RunQueueCoordinator,
            "restoreQueuedRun" | "restoreQueuedResume"
        >,
    ) {}

    restore(): void {
        for (const run of this.runStore.listQueuedRuns()) {
            const checkpointId = this.getRecoveryCheckpointId(
                this.runStore.listEvents(run.id),
            );

            if (checkpointId === null) {
                this.coordinator.restoreQueuedRun(run);
                continue;
            }

            const checkpoint = this.checkpointStore.get(checkpointId);

            if (
                checkpoint === null
                || checkpoint.runId !== run.id
            ) {
                throw new Error(
                    `QUEUED 恢复任务缺少有效 Checkpoint：${run.id}`,
                );
            }

            this.coordinator.restoreQueuedResume(run, {
                runId:run.id,
                checkpoint,
                continuationInput:"请从恢复点继续完成任务",
            });
        }
    }

    private getRecoveryCheckpointId(
        events:readonly RunEvent[],
    ):string | null {
        const queuedEvent = [...events]
            .reverse()
            .find((event) => event.type === "RUN_QUEUED");

        if (
            queuedEvent === undefined
            || typeof queuedEvent.payload !== "object"
            || queuedEvent.payload === null
        ) {
            return null;
        }

        const payload = queuedEvent.payload as Record<string,unknown>;

        return payload.reason === "AUTO_RECOVERY"
            && typeof payload.checkpointId === "string"
            ? payload.checkpointId
            : null;
    }
}
