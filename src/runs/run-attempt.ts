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
    readonly policySnapshotId: string | null;
    readonly sandboxId: string | null;
    readonly status: RunAttemptStatus;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly failureReason: string | null;
    /** §9.8 v1.4 Phase 2：租约持有者（实例 ID），null 表示无租约。 */
    readonly leaseOwner: string | null;
    /** 租约到期时刻（ISO），超过后其他实例可回收该 Attempt。 */
    readonly leaseExpiresAt: string | null;
    /** 最近一次心跳时刻（ISO）。 */
    readonly heartbeatAt: string | null;
}

export function createRunAttempt(
    input: Omit<
        RunAttempt,
        | "status"
        | "startedAt"
        | "finishedAt"
        | "failureReason"
        | "leaseOwner"
        | "leaseExpiresAt"
        | "heartbeatAt"
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
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
    });
}

export function startRunAttempt(
    attempt: RunAttempt,
    startedAt: string,
    policySnapshotId: string,
    sandboxId: string | null,
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

/**
 * §9.8 v1.4 Phase 2：为正在运行的 Attempt 获取租约。
 * 只有 PENDING/RUNNING 状态可以持有租约。
 */
export function acquireRunAttemptLease(
    attempt: RunAttempt,
    owner: string,
    now: string,
    ttlMs: number,
): RunAttempt {
    if (attempt.status !== "PENDING" && attempt.status !== "RUNNING") {
        throw new Error(`只有未结束的 Attempt 可以获取租约：${attempt.id}`);
    }
    if (owner.length === 0) {
        throw new Error("租约 owner 不能为空");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new Error("租约 ttlMs 必须为正数");
    }
    return Object.freeze({
        ...attempt,
        leaseOwner: owner,
        leaseExpiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
        heartbeatAt: now,
    });
}

/**
 * §9.8 v1.4 Phase 2：续租。只有当前 owner 可以续租，防止旧实例
 * 在租约被新实例接管后覆盖心跳。
 */
export function heartbeatRunAttemptLease(
    attempt: RunAttempt,
    owner: string,
    now: string,
    ttlMs: number,
): RunAttempt {
    if (attempt.leaseOwner !== owner) {
        throw new Error(
            `Attempt ${attempt.id} 的租约属于 ${attempt.leaseOwner ?? "null"}，不能由 ${owner} 续租`,
        );
    }
    if (attempt.status !== "RUNNING" && attempt.status !== "PENDING") {
        throw new Error(`只有未结束的 Attempt 可以续租：${attempt.id}`);
    }
    return Object.freeze({
        ...attempt,
        leaseExpiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
        heartbeatAt: now,
    });
}

/** §9.8 v1.4 Phase 2：主动释放租约（正常结束时调用）。 */
export function releaseRunAttemptLease(attempt: RunAttempt): RunAttempt {
    return Object.freeze({
        ...attempt,
        leaseOwner: null,
        leaseExpiresAt: null,
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
    if ((status === "FAILED" || status === "REJECTED") != (failureReason !== null)) {
        throw new Error(`${status} Attempt 必须且只能携带 failureReason`);
    }
    return Object.freeze({
        ...attempt,
        status,
        finishedAt,
        failureReason,
        leaseOwner: null,
        leaseExpiresAt: null,
    });
}
