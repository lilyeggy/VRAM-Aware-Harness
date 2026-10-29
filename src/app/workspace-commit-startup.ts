import { finishRunAttempt } from "../runs/run-attempt.ts";
import type { RunAttemptStore } from "../runs/run-attempt-store.ts";
import type { RunStore } from "../runs/runstore.ts";

/** Reconcile before generic startup recovery can enqueue an interrupted Run. */
export async function reconcileWorkspaceCommits(
    runStore: RunStore,
    attemptStore: RunAttemptStore,
    query: (sandboxId: string) => Promise<{ status: "COMMITTED" | "CONFLICT" | "UNKNOWN" } | null>,
): Promise<void> {
    for (const run of runStore.listActiveRuns()) {
        const events = runStore.listEvents(run.id);
        const start = events.filter((event) => event.type === "RUN_STARTED" || event.type === "RUN_RESUMED").at(-1)?.sequence ?? 0;
        const finalizing = events.filter((event) => event.type === "WORKSPACE_COMMIT_STARTED" && event.sequence > start).at(-1);
        const payload = finalizing?.payload as { attemptId?: unknown; sandboxId?: unknown; terminal?: unknown } | undefined;
        if (payload?.terminal !== "SUCCEEDED" || typeof payload.attemptId !== "string" || typeof payload.sandboxId !== "string") continue;
        try {
            const receipt = await query(payload.sandboxId);
            if (receipt?.status !== "COMMITTED") continue;
            const attempt = attemptStore.get(payload.attemptId);
            if (!attempt || attempt.runId !== run.id || attempt.sandboxId !== payload.sandboxId
                || (attempt.status !== "RUNNING" && attempt.status !== "SUCCEEDED")) continue;
            const timestamp = new Date().toISOString();
            if (attempt.status === "RUNNING") attemptStore.update(finishRunAttempt(attempt, "SUCCEEDED", timestamp), "RUNNING");
            runStore.update({ ...run, status: "COMPLETED", updatedAt: timestamp, finishedAt: timestamp }, {
                eventId: crypto.randomUUID(), runId: run.id, sequence: runStore.getLastEventSequence(run.id) + 1,
                type: "RUN_COMPLETED", timestamp, payloadVersion: 1, payload: { recoveredFromCommitReceipt: true },
            });
        } catch (error) {
            // RecoveryService will require manual review rather than replay.
            console.warn(`[recovery] Workspace 提交回执暂不可确认: runId=${run.id}`, error);
        }
    }
}
