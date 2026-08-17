import {
    expect,
    test,
} from "bun:test";

import type { Checkpoint } from "../../src/checkpoints/checkpoint.ts";
import {
    RecoveryExecutor,
} from "../../src/checkpoints/recovery-executor.ts";
import type {
    RunRecoveryPlan,
} from "../../src/checkpoints/recovery-service.ts";
import type { AgentRun } from "../../src/runs/agent-run.ts";
import type {
    ResumeRunInput,
} from "../../src/runs/run-service.ts";

function createInterruptedRun(
    runId: string,
    checkpointId: string | null,
): AgentRun {
    const timestamp = new Date().toISOString();

    return {
        id: runId,
        tenantId: "tenant-1",
        harnessSessionId: "session-1",
        status: "INTERRUPTED",
        userInput: "完成恢复测试",
        workspacePath: "/tmp/workspace",
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        finishedAt: null,
        checkpointId,
        failureReason: null,
    };
}

function createCheckpoint(
    runId: string,
    checkpointId: string,
): Checkpoint {
    return {
        id: checkpointId,
        runId,
        toolExecutionId: `tool-${runId}`,
        runtimeSessionRef: `/tmp/${runId}.jsonl`,
        lastEventSequence: 3,
        createdAt: new Date().toISOString(),
    };
}

function createAutomaticPlan(runId: string): RunRecoveryPlan {
    const checkpoint = createCheckpoint(
        runId,
        `checkpoint-${runId}`,
    );

    return {
        run: createInterruptedRun(runId, checkpoint.id),
        checkpoint,
        preparedExecutions: [],
        decision: {
            action: "AUTO_RESUME",
            reason: "SAFE_CHECKPOINT",
            blockingToolExecutionId: null,
        },
    };
}

test("AUTO_RESUME 计划会提交到恢复队列", async () => {
    const plan = createAutomaticPlan("run-safe");
    const requests: ResumeRunInput[] = [];
    const queuedRun: AgentRun = {
        ...plan.run,
        status: "QUEUED",
    };
    const executor = new RecoveryExecutor({
        submitResume(input) {
            requests.push(input);
            return queuedRun;
        },
    });

    const results = await executor.execute([plan]);

    expect(requests).toEqual([
        {
            runId: plan.run.id,
            checkpoint: plan.checkpoint!,
            continuationInput: "请从恢复点继续完成任务",
        },
    ]);
    expect(results).toEqual([
        {
            runId: plan.run.id,
            status: "QUEUED",
            run: queuedRun,
            errorMessage: null,
        },
    ]);
});

test("MANUAL_REVIEW 计划不会调用 Runtime 恢复", async () => {
    const run = createInterruptedRun(
        "run-manual",
        "checkpoint-manual",
    );
    const plan: RunRecoveryPlan = {
        run,
        checkpoint: createCheckpoint(
            run.id,
            "checkpoint-manual",
        ),
        preparedExecutions: [],
        decision: {
            action: "MANUAL_REVIEW",
            reason: "UNSAFE_TOOL_EFFECT",
            blockingToolExecutionId: "dangerous-tool",
        },
    };
    let resumeCallCount = 0;
    const executor = new RecoveryExecutor({
        submitResume() {
            resumeCallCount += 1;
            throw new Error("不应提交恢复任务");
        },
    });

    const results = await executor.execute([plan]);

    expect(resumeCallCount).toBe(0);
    expect(results).toEqual([
        {
            runId: run.id,
            status: "MANUAL_REVIEW",
            run,
            errorMessage: null,
        },
    ]);
});

test("一个 Run 提交恢复失败不会阻止后续 Run", async () => {
    const failedPlan = createAutomaticPlan("run-failed");
    const safePlan = createAutomaticPlan("run-after-failure");
    const calledRunIds: string[] = [];
    const queuedRun: AgentRun = {
        ...safePlan.run,
        status: "QUEUED",
    };
    const executor = new RecoveryExecutor({
        submitResume(input) {
            calledRunIds.push(input.runId);

            if (input.runId === failedPlan.run.id) {
                throw new Error("模拟恢复失败");
            }

            return queuedRun;
        },
    });

    const results = await executor.execute([
        failedPlan,
        safePlan,
    ]);

    expect(calledRunIds).toEqual([
        failedPlan.run.id,
        safePlan.run.id,
    ]);
    expect(results.map((result) => result.status)).toEqual([
        "FAILED",
        "QUEUED",
    ]);
    expect(results[0]?.errorMessage).toBe("模拟恢复失败");
    expect(results[1]?.run).toEqual(queuedRun);
});

test("AUTO_RESUME 缺少 Checkpoint 时记录失败", async () => {
    const run = createInterruptedRun("run-no-checkpoint", null);
    const plan: RunRecoveryPlan = {
        run,
        checkpoint: null,
        preparedExecutions: [],
        decision: {
            action: "AUTO_RESUME",
            reason: "SAFE_CHECKPOINT",
            blockingToolExecutionId: null,
        },
    };
    let resumeCallCount = 0;
    const executor = new RecoveryExecutor({
        submitResume() {
            resumeCallCount += 1;
            return run;
        },
    });

    const results = await executor.execute([plan]);

    expect(resumeCallCount).toBe(0);
    expect(results).toEqual([
        {
            runId: run.id,
            status: "FAILED",
            run: null,
            errorMessage:
                "AUTO_RESUME 恢复计划缺少 Checkpoint",
        },
    ]);
});
