export type RunAttemptKind = "START" | "RESUME";

export type RunAttemptStatus =
    | "PENDING"
    | "RUNNING"
    | "SUCCEEDED"
    | "FAILED"
    | "INTERRUPTED"
    | "REJECTED";

export interface RunAttempt {
    readonly id: string;
    readonly runId: string;
    readonly attemptNumber: number;
    readonly kind: RunAttemptKind;
    readonly instanceId: string;
    readonly templateVersionId: string;
    readonly capabilityProfileId: string;
    readonly policySnapshotId: string | null;
    readonly sandboxId: string | null;
    readonly status: RunAttemptStatus;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly failureReason: string | null;
}

export function createRunAttempt(
    input: Omit<
        RunAttempt,
        "status" | "startedAt" | "finishedAt" | "failureReason"
    >,
): RunAttempt {
    if (!Number.isInteger(input.attemptNumber) || input.attemptNumber <= 0) {
        throw new Error("attemptNumber 必须为正整数");
    }

    return Object.freeze({
        ...input,
        status: "PENDING" as const,
        startedAt: null,
        finishedAt: null,
        failureReason: null,
    });
}

export function startRunAttempt(
    attempt: RunAttempt,
    startedAt: string,
    policySnapshotId: string,
    sandboxId: string,
): RunAttempt {
    if (attempt.status !== "PENDING") {
        throw new Error(`只有 PENDING Attempt 可以启动：${attempt.id}`);
    }
    return Object.freeze({
        ...attempt,
        policySnapshotId,
        sandboxId,
        status: "RUNNING" as const,
        startedAt,
    });
}

export function finishRunAttempt(
    attempt: RunAttempt,
    status: Extract<RunAttemptStatus,
        "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "REJECTED">,
    finishedAt: string,
    failureReason: string | null = null,
): RunAttempt {
    if (attempt.status !== "PENDING" && attempt.status !== "RUNNING") {
        throw new Error(`Attempt 已经结束：${attempt.id}`);
    }
    if ((status === "FAILED" || status === "REJECTED") !== (failureReason !== null)) {
        throw new Error(`${status} Attempt 必须且只能携带 failureReason`);
    }
    return Object.freeze({
        ...attempt,
        status,
        finishedAt,
        failureReason,
    });
}
