import { expect, test } from "bun:test";

import {
    decideRecovery,
} from "../../src/checkpoints/recovery-decision.ts";
import type {
    ToolEffect,
    ToolExecution,
} from "../../src/tools/tool-execution.ts";

/**
 * 每条测试只关心 effect 对恢复决策的影响，
 * 其余 ToolExecution 字段使用固定值，减少无关差异。
 */
function createPreparedExecution(
    effect: ToolEffect,
): ToolExecution {
    return {
        id: `execution-${effect}`,
        runId: "run-1",
        toolCallId: `tool-call-${effect}`,
        toolName: effect === "READ_ONLY" ? "read" : "bash",
        arguments: {},
        effect,
        status: "PREPARED",
        result: null,
        errorMessage: null,
        createdAt: "2026-07-28T10:00:00.000Z",
        finishedAt: null,
    };
}

test("有 Checkpoint 且所有工具可重放时自动恢复", () => {
    const decision = decideRecovery(
        "checkpoint-1",
        [createPreparedExecution("READ_ONLY")],
    );

    expect(decision).toEqual({
        action: "AUTO_RESUME",
        reason: "SAFE_CHECKPOINT",
        blockingToolExecutionId: null,
    });
});

test("存在未知副作用或缺少幂等证明的写入时要求人工处理", () => {
    const unsafeExecution =
        createPreparedExecution("UNKNOWN_EFFECT");

    const decision = decideRecovery(
        "checkpoint-1",
        [
            createPreparedExecution("READ_ONLY"),
            unsafeExecution,
        ],
    );

    expect(decision).toEqual({
        action: "MANUAL_REVIEW",
        reason: "UNSAFE_TOOL_EFFECT",
        blockingToolExecutionId: unsafeExecution.id,
    });

    const idempotentWriteWithoutProof =
        createPreparedExecution("IDEMPOTENT_WRITE");
    const idempotentWriteDecision = decideRecovery(
        "checkpoint-1",
        [idempotentWriteWithoutProof],
    );

    expect(idempotentWriteDecision).toEqual({
        action: "MANUAL_REVIEW",
        reason: "UNSAFE_TOOL_EFFECT",
        blockingToolExecutionId: idempotentWriteWithoutProof.id,
    });
});

test("没有 Checkpoint 时即使工具可重放也不能自动恢复", () => {
    const decision = decideRecovery(
        null,
        [createPreparedExecution("READ_ONLY")],
    );

    expect(decision).toEqual({
        action: "MANUAL_REVIEW",
        reason: "NO_CHECKPOINT",
        blockingToolExecutionId: null,
    });
});
