/**
 * Run 级分步时间线（trace）：把 RunEvent 流折叠成"这一步花了多久、花了多少钱"。
 *
 * 只做只读聚合，不改变任何状态；数据全部来自既有事件：
 *   SANDBOX_ACQUIRED / CONTROL_PREPARED / SESSION_INITIALIZED
 *   MODEL_STARTED / MODEL_COMPLETED（含 usage 与 cost）
 *   TOOL_STARTED / TOOL_COMPLETED / TOOL_FAILED
 *   RUN_QUEUED / QUEUE_BLOCKED / RUN_STARTED / 终态事件
 *
 * 用途：回答"这次 Run 的 40 秒花在哪"，以及按模型调用做 token/成本归因。
 */
import type { AgentRun, RunEvent } from "./agent-run.ts";

export type RunTraceStepKind =
    | "sandbox"
    | "model"
    | "tool"
    | "queue"
    | "lifecycle";

export interface RunTraceStep {
    kind: RunTraceStepKind;
    name: string;
    status: "ok" | "error" | "pending";
    startedAt: string;
    durationMs: number | null;
    detail?: Record<string, unknown>;
}

export interface RunTraceTotals {
    /** 提交到终态的墙钟（未终态时为 null）。 */
    wallMs: number | null;
    /** 首次排队到开始执行的等待。 */
    queueWaitMs: number | null;
    sandboxMs: number;
    modelMs: number;
    toolMs: number;
    /** CONTROL_PREPARED / SESSION_INITIALIZED 这类生命周期步骤的耗时。 */
    lifecycleMs: number;
    /**
     * 墙钟里没有归因到任何步骤的时间（等模型排队、Pi 会话初始化之外的
     * 内部处理、事件间隔等）。这个数大，说明有性能问题还没被观测到。
     */
    unaccountedMs: number | null;
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    /** 模型侧成本合计（provider 返回的 cost.total）。 */
    costTotal: number;
}

export interface RunTrace {
    runId: string;
    tenantId: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
    steps: RunTraceStep[];
    totals: RunTraceTotals;
}

function asRecord(payload: unknown): Record<string, unknown> {
    return payload !== null && typeof payload === "object"
        ? payload as Record<string, unknown>
        : {};
}

function numberField(record: Record<string, unknown>, key: string): number {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === "string" ? value : null;
}

function elapsedMs(startedAt: string, endedAt: string): number | null {
    const start = Date.parse(startedAt);
    const end = Date.parse(endedAt);

    if (Number.isFinite(start) === false || Number.isFinite(end) === false) {
        return null;
    }

    return Math.max(0, end - start);
}

export function buildRunTrace(
    run: Pick<AgentRun, "id" | "tenantId" | "status" | "createdAt" | "finishedAt">,
    events: readonly RunEvent[],
): RunTrace {
    const ordered = [...events].sort(
        (left, right) => left.sequence - right.sequence,
    );

    const steps: RunTraceStep[] = [];
    const modelStartedAt = new Map<string, { at: string; name: string }>();
    const toolStartedAt = new Map<string, { at: string; name: string }>();

    let queueWaitMs: number | null = null;
    let queuedAt: string | null = null;
    let startedAt: string | null = null;
    let finishedAt: string | null = null;

    let sandboxMs = 0;
    let modelMs = 0;
    let toolMs = 0;
    let lifecycleMs = 0;
    let modelCalls = 0;
    let toolCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let costTotal = 0;

    for (const event of ordered) {
        const payload = asRecord(event.payload);

        switch (event.type) {
            case "RUN_CREATED":
                queuedAt = event.timestamp;
                break;

            case "RUN_QUEUED":
                if (queuedAt === null) {
                    queuedAt = event.timestamp;
                }
                steps.push({
                    kind: "queue",
                    name: "RUN_QUEUED",
                    status: "ok",
                    startedAt: event.timestamp,
                    durationMs: null,
                    detail: { reason: stringField(payload, "reason") },
                });
                break;

            case "QUEUE_BLOCKED": {
                const reasonCode = stringField(payload, "reasonCode") ?? "UNKNOWN";
                steps.push({
                    kind: "queue",
                    name: `QUEUE_BLOCKED:${reasonCode}`,
                    status: "ok",
                    startedAt: event.timestamp,
                    durationMs: null,
                    detail: {
                        position: numberField(payload, "position"),
                        tenantPosition: numberField(payload, "tenantPosition"),
                    },
                });
                break;
            }

            case "SANDBOX_ACQUIRED": {
                const durationMs = numberField(payload, "durationMs");
                sandboxMs += durationMs;
                steps.push({
                    kind: "sandbox",
                    name: "SANDBOX_ACQUIRED",
                    status: "ok",
                    startedAt: event.timestamp,
                    durationMs,
                    detail: {
                        warmHit: payload.warmHit === true,
                        profile: stringField(payload, "profile"),
                        sandboxId: stringField(payload, "sandboxId"),
                    },
                });
                break;
            }

            case "CONTROL_PREPARED":
            case "SESSION_INITIALIZED": {
                const durationMs = numberField(payload, "durationMs");
                lifecycleMs += durationMs;
                steps.push({
                    kind: "lifecycle",
                    name: event.type,
                    status: "ok",
                    startedAt: event.timestamp,
                    durationMs,
                    detail: { mode: stringField(payload, "mode") },
                });
                break;
            }

            case "MODEL_STARTED": {
                const callId = stringField(payload, "modelCallId") ?? `model-${event.sequence}`;
                modelStartedAt.set(callId, {
                    at: event.timestamp,
                    name: stringField(payload, "model") ?? "model",
                });
                break;
            }

            case "MODEL_COMPLETED": {
                const callId = stringField(payload, "modelCallId") ?? `model-${event.sequence}`;
                const started = modelStartedAt.get(callId);
                modelStartedAt.delete(callId);

                const usage = asRecord(payload.usage);
                const cost = asRecord(usage.cost);
                const durationMs = numberField(payload, "durationMs");
                const callInput = numberField(usage, "inputTokens");
                const callOutput = numberField(usage, "outputTokens");
                const callTotal = numberField(usage, "totalTokens");

                modelCalls += 1;
                modelMs += durationMs;
                inputTokens += callInput;
                outputTokens += callOutput;
                cacheReadTokens += numberField(usage, "cacheReadTokens");
                cacheWriteTokens += numberField(usage, "cacheWriteTokens");
                totalTokens += callTotal;
                costTotal += numberField(cost, "total");

                steps.push({
                    kind: "model",
                    name: started?.name ?? stringField(payload, "model") ?? "model",
                    status: "ok",
                    startedAt: started?.at ?? event.timestamp,
                    durationMs,
                    detail: {
                        modelCallId: callId,
                        provider: stringField(payload, "provider"),
                        stopReason: stringField(payload, "stopReason"),
                        inputTokens: callInput,
                        outputTokens: callOutput,
                        totalTokens: callTotal,
                        costTotal: numberField(cost, "total"),
                    },
                });
                break;
            }

            case "TOOL_STARTED": {
                const callId = stringField(payload, "toolCallId") ?? `tool-${event.sequence}`;
                toolStartedAt.set(callId, {
                    at: event.timestamp,
                    name: stringField(payload, "toolName") ?? "tool",
                });
                break;
            }

            case "TOOL_COMPLETED":
            case "TOOL_FAILED": {
                const callId = stringField(payload, "toolCallId") ?? `tool-${event.sequence}`;
                const started = toolStartedAt.get(callId);
                toolStartedAt.delete(callId);

                const durationMs = started === undefined
                    ? null
                    : elapsedMs(started.at, event.timestamp);
                const isError = event.type === "TOOL_FAILED"
                    || payload.isError === true;

                toolCalls += 1;
                toolMs += durationMs ?? 0;

                steps.push({
                    kind: "tool",
                    name: started?.name ?? stringField(payload, "toolName") ?? "tool",
                    status: isError ? "error" : "ok",
                    startedAt: started?.at ?? event.timestamp,
                    durationMs,
                    detail: {
                        toolCallId: callId,
                        ...(isError ? { error: stringField(payload, "error") } : {}),
                    },
                });
                break;
            }

            case "RUN_STARTED":
            case "RUN_RESUMED":
                startedAt = startedAt ?? event.timestamp;
                steps.push({
                    kind: "lifecycle",
                    name: event.type,
                    status: "ok",
                    startedAt: event.timestamp,
                    durationMs: null,
                });
                break;

            case "RUN_COMPLETED":
            case "RUN_FAILED":
            case "RUN_INTERRUPTED":
                finishedAt = event.timestamp;
                steps.push({
                    kind: "lifecycle",
                    name: event.type,
                    status: event.type === "RUN_COMPLETED" ? "ok" : "error",
                    startedAt: event.timestamp,
                    durationMs: null,
                    detail: {
                        reason: stringField(payload, "reason"),
                        message: stringField(payload, "message"),
                    },
                });
                break;

            default:
                break;
        }
    }

    // 没有配对的开始事件：标记为 pending，方便定位"卡在哪一步"。
    for (const [callId, started] of modelStartedAt) {
        steps.push({
            kind: "model",
            name: started.name,
            status: "pending",
            startedAt: started.at,
            durationMs: null,
            detail: { modelCallId: callId },
        });
    }
    for (const [callId, started] of toolStartedAt) {
        steps.push({
            kind: "tool",
            name: started.name,
            status: "pending",
            startedAt: started.at,
            durationMs: null,
            detail: { toolCallId: callId },
        });
    }

    if (queuedAt !== null && startedAt !== null) {
        queueWaitMs = elapsedMs(queuedAt, startedAt);
    }

    const wallMs = finishedAt === null
        ? null
        : elapsedMs(run.createdAt, finishedAt);

    return {
        runId: run.id,
        tenantId: run.tenantId,
        status: run.status,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt ?? finishedAt,
        steps,
        totals: {
            wallMs,
            queueWaitMs,
            sandboxMs,
            modelMs,
            toolMs,
            lifecycleMs,
            unaccountedMs: wallMs === null
                ? null
                : Math.max(
                    0,
                    wallMs - sandboxMs - modelMs - toolMs - lifecycleMs,
                ),
            modelCalls,
            toolCalls,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens,
            costTotal,
        },
    };
}
