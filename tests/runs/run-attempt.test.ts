import { expect, test } from "bun:test";

import {
    createRunAttempt,
    finishRunAttempt,
    startRunAttempt,
} from "../../src/runs/run-attempt.ts";

function pendingAttempt() {
    return createRunAttempt({
        id: "attempt-1",
        runId: "run-1",
        attemptNumber: 1,
        kind: "START",
        instanceId: "instance-1",
        templateVersionId: "template-version-1",
        capabilityProfileId: "profile-1",
        policySnapshotId: "policy-snapshot-1",
        sandboxId: null,
        createdAt: "2026-08-10T10:00:00.000Z",
    });
}

test("RunAttempt 固定版本、能力和策略证据后再进入 RUNNING", () => {
    const running = startRunAttempt(
        pendingAttempt(),
        "2026-08-10T10:00:01.000Z",
        "policy-snapshot-1",
        "sandbox-1",
    );
    const succeeded = finishRunAttempt(
        running,
        "SUCCEEDED",
        "2026-08-10T10:00:02.000Z",
    );

    expect(succeeded).toMatchObject({
        status: "SUCCEEDED",
        templateVersionId: "template-version-1",
        capabilityProfileId: "profile-1",
        policySnapshotId: "policy-snapshot-1",
        sandboxId: "sandbox-1",
    });
    expect(() => finishRunAttempt(
        succeeded,
        "FAILED",
        "2026-08-10T10:00:03.000Z",
        "late failure",
    )).toThrow("Attempt 已经结束");
});

test("启动前拒绝仍保留策略快照，并且必须说明原因", () => {
    expect(() => finishRunAttempt(
        pendingAttempt(),
        "REJECTED",
        "2026-08-10T10:00:01.000Z",
    )).toThrow("必须且只能携带 failureReason");

    const rejected = finishRunAttempt(
        pendingAttempt(),
        "REJECTED",
        "2026-08-10T10:00:01.000Z",
        "missing required capability",
    );
    expect(rejected.policySnapshotId).toBe("policy-snapshot-1");
    expect(rejected.failureReason).toBe("missing required capability");
});
