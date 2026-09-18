/**
 * Master-Worker IPC Protocol Definition and Stream Framing Utilities.
 *
 * Channel: Stdio (stdin / stdout)
 * Framing: Line-delimited UTF-8 JSON (NDJSON) terminated with newline (\n)
 */

import type {
    RuntimeEvent,
    RuntimeResumeRequest,
    RuntimeStartRequest,
} from "../runtime/agent-runtime.ts";
import type { PiCompactionConfig } from "../runtime/pi-adapter.ts";
import type { SandboxProfile } from "../sandbox/sandbox-profile.ts";
import type { ExecuteToolInput } from "../tools/tool-gateway.ts";

export const WORKER_PROTOCOL_VERSION = 2;

// ============================================================================
// 1. Error Serialization
// ============================================================================

export interface SerializedError {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
}

export function serializeError(error: unknown): SerializedError {
    if (error instanceof Error) {
        return {
            name: error.name || "Error",
            message: error.message || String(error),
            stack: error.stack,
        };
    }
    if (typeof error === "object" && error !== null) {
        const errObj = error as Record<string, unknown>;
        return {
            name: typeof errObj.name === "string" ? errObj.name : "Error",
            message: typeof errObj.message === "string" ? errObj.message : JSON.stringify(error),
            stack: typeof errObj.stack === "string" ? errObj.stack : undefined,
        };
    }
    return {
        name: "Error",
        message: String(error),
    };
}

// ============================================================================
// 2. Worker Configuration Contract
// ============================================================================

export interface WorkerRuntimeConfig {
    readonly piProvider: string;
    readonly piModelId: string;
    readonly piTools: readonly string[];
    readonly piModelsPath: string;
    readonly piAuthPath?: string;
    readonly sandboxProvider: "container" | "managed-local";
    readonly sandboxProfile: SandboxProfile;
    readonly sandboxRuntime: "runsc" | "runc";
    readonly containerImage: string;
    readonly containerUserId: number;
    readonly dockerCommand?: string;
    /**
     * N28 主机制：Pi 会话压缩参数必须随 workerConfig 下发。默认 worker 隔离
     * 模式下 Pi 会话是在 worker 子进程里建的——只在 Master 侧装配会漏掉这条
     * 占绝大多数的执行路径。
     */
    readonly piCompaction?: PiCompactionConfig;
}

// ============================================================================
// 3. Master -> Worker Messages
// ============================================================================

export interface StartRunMessage {
    readonly type: "START_RUN";
    readonly runId: string;
    readonly request: RuntimeStartRequest;
    readonly workerConfig?: WorkerRuntimeConfig;
    readonly timestamp?: string;
}

export interface ResumeRunMessage {
    readonly type: "RESUME_RUN";
    readonly runId: string;
    readonly request: RuntimeResumeRequest;
    readonly workerConfig?: WorkerRuntimeConfig;
    readonly timestamp?: string;
}

export interface InterruptRunMessage {
    readonly type: "INTERRUPT_RUN";
    readonly runId: string;
    readonly reason?: string;
    readonly timestamp?: string;
}

export interface ShutdownMessage {
    readonly type: "SHUTDOWN";
    readonly graceful?: boolean;
    readonly timestamp?: string;
}

export interface ToolPrepareResponseMessage {
    readonly type: "TOOL_PREPARE_RESPONSE";
    readonly runId: string;
    readonly requestId: number;
    readonly decision: ToolPrepareDecisionPayload;
    readonly timestamp?: string;
}

export interface ToolCompleteResponseMessage {
    readonly type: "TOOL_COMPLETE_RESPONSE";
    readonly runId: string;
    readonly requestId: number;
    readonly ok: boolean;
    readonly timestamp?: string;
}

export type MasterToWorkerMessage =
    | StartRunMessage
    | ResumeRunMessage
    | InterruptRunMessage
    | ShutdownMessage
    | ToolPrepareResponseMessage
    | ToolCompleteResponseMessage;

// ============================================================================
// 4. Worker -> Master Messages
// ============================================================================

export interface WorkerReadyMessage {
    readonly type: "WORKER_READY";
    readonly pid: number;
    readonly protocolVersion?: number;
    readonly runId?: string;
    readonly timestamp?: string;
}

export interface RuntimeEventMessage {
    readonly type: "RUNTIME_EVENT";
    readonly runId: string;
    readonly event: RuntimeEvent;
}

export interface RunCompletedMessage {
    readonly type: "RUN_COMPLETED";
    readonly runId: string;
    readonly output?: string;
    readonly timestamp?: string;
}

export interface RunFailedMessage {
    readonly type: "RUN_FAILED";
    readonly runId: string;
    readonly error: string;
    readonly stack?: string;
    readonly timestamp?: string;
}

export interface RunInterruptedMessage {
    readonly type: "RUN_INTERRUPTED";
    readonly runId: string;
    readonly reason?: string;
    readonly timestamp?: string;
}

export interface ToolPrepareRequestMessage {
    readonly type: "TOOL_PREPARE_REQUEST";
    readonly runId: string;
    readonly requestId: number;
    readonly input: ExecuteToolInput;
    readonly timestamp?: string;
}

export interface ToolCompleteRequestMessage {
    readonly type: "TOOL_COMPLETE_REQUEST";
    readonly runId: string;
    readonly requestId: number;
    readonly toolExecutionId: string;
    readonly outcome:
        | { readonly ok: true; readonly result: unknown }
        | { readonly ok: false; readonly error: string };
    readonly timestamp?: string;
}

export type WorkerToMasterMessage =
    | WorkerReadyMessage
    | RuntimeEventMessage
    | RunCompletedMessage
    | RunFailedMessage
    | RunInterruptedMessage
    | ToolPrepareRequestMessage
    | ToolCompleteRequestMessage;

/**
 * ToolGateway prepare 阶段跨 IPC 的裁决载荷。
 * ALLOWED：Master 已写 PREPARED，Worker 可执行真实工具；
 * REUSE：历史 SUCCEEDED 命中，直接复用缓存结果；
 * DENIED：策略或恢复裁决拒绝，Worker 不得触碰真实工具。
 */
export type ToolPrepareDecisionPayload =
    | {
          readonly kind: "ALLOWED";
          readonly toolExecutionId: string;
          readonly lastEventSequence: number;
      }
    | { readonly kind: "REUSE"; readonly result: unknown }
    | { readonly kind: "DENIED"; readonly reason: string };

export type WorkerProtocolMessage = MasterToWorkerMessage | WorkerToMasterMessage;

// ============================================================================
// 5. Type Guards
// ============================================================================

const MASTER_TO_WORKER_TYPES = new Set<unknown>([
    "START_RUN",
    "RESUME_RUN",
    "INTERRUPT_RUN",
    "SHUTDOWN",
    "TOOL_PREPARE_RESPONSE",
    "TOOL_COMPLETE_RESPONSE",
]);

const WORKER_TO_MASTER_TYPES = new Set<unknown>([
    "WORKER_READY",
    "RUNTIME_EVENT",
    "RUN_COMPLETED",
    "RUN_FAILED",
    "RUN_INTERRUPTED",
    "TOOL_PREPARE_REQUEST",
    "TOOL_COMPLETE_REQUEST",
]);

function hasMessageType(value: unknown, knownTypes: ReadonlySet<unknown>): boolean {
    return typeof value === "object"
        && value !== null
        && knownTypes.has((value as { type?: unknown }).type);
}

export function isMasterToWorkerMessage(value: unknown): value is MasterToWorkerMessage {
    return hasMessageType(value, MASTER_TO_WORKER_TYPES);
}

export function isWorkerToMasterMessage(value: unknown): value is WorkerToMasterMessage {
    return hasMessageType(value, WORKER_TO_MASTER_TYPES);
}

// ============================================================================
// 6. Message Factory Helpers
// ============================================================================

function createTimedMessage<T extends { readonly timestamp?: string }>(
    message: Omit<T, "timestamp">,
): T {
    return { ...message, timestamp: new Date().toISOString() } as T;
}

export function createStartRunMessage(
    runId: string,
    request: RuntimeStartRequest,
    workerConfig?: WorkerRuntimeConfig,
): StartRunMessage {
    return createTimedMessage<StartRunMessage>({ type: "START_RUN", runId, request, workerConfig });
}

export function createResumeRunMessage(
    runId: string,
    request: RuntimeResumeRequest,
    workerConfig?: WorkerRuntimeConfig,
): ResumeRunMessage {
    return createTimedMessage<ResumeRunMessage>({ type: "RESUME_RUN", runId, request, workerConfig });
}

export function createInterruptRunMessage(runId: string, reason?: string): InterruptRunMessage {
    return createTimedMessage<InterruptRunMessage>({ type: "INTERRUPT_RUN", runId, reason });
}

export function createShutdownMessage(graceful = true): ShutdownMessage {
    return createTimedMessage<ShutdownMessage>({ type: "SHUTDOWN", graceful });
}

export function createWorkerReadyMessage(pid: number, runId?: string): WorkerReadyMessage {
    return createTimedMessage<WorkerReadyMessage>({
        type: "WORKER_READY",
        pid,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        runId,
    });
}

export function createRuntimeEventMessage(runId: string, event: RuntimeEvent): RuntimeEventMessage {
    return { type: "RUNTIME_EVENT", runId, event };
}

export function createRunCompletedMessage(runId: string, output?: string): RunCompletedMessage {
    return createTimedMessage<RunCompletedMessage>({ type: "RUN_COMPLETED", runId, output });
}

export function createRunFailedMessage(runId: string, error: unknown): RunFailedMessage {
    const serialized = serializeError(error);
    return createTimedMessage<RunFailedMessage>({
        type: "RUN_FAILED",
        runId,
        error: serialized.message,
        stack: serialized.stack,
    });
}

export function createRunInterruptedMessage(runId: string, reason?: string): RunInterruptedMessage {
    return createTimedMessage<RunInterruptedMessage>({ type: "RUN_INTERRUPTED", runId, reason });
}

export function createToolPrepareRequestMessage(
    runId: string,
    requestId: number,
    input: ExecuteToolInput,
): ToolPrepareRequestMessage {
    return createTimedMessage<ToolPrepareRequestMessage>({
        type: "TOOL_PREPARE_REQUEST",
        runId,
        requestId,
        input,
    });
}

export function createToolCompleteRequestMessage(
    runId: string,
    requestId: number,
    toolExecutionId: string,
    outcome: ToolCompleteRequestMessage["outcome"],
): ToolCompleteRequestMessage {
    return createTimedMessage<ToolCompleteRequestMessage>({
        type: "TOOL_COMPLETE_REQUEST",
        runId,
        requestId,
        toolExecutionId,
        outcome,
    });
}

export function createToolPrepareResponseMessage(
    runId: string,
    requestId: number,
    decision: ToolPrepareDecisionPayload,
): ToolPrepareResponseMessage {
    return createTimedMessage<ToolPrepareResponseMessage>({
        type: "TOOL_PREPARE_RESPONSE",
        runId,
        requestId,
        decision,
    });
}

export function createToolCompleteResponseMessage(
    runId: string,
    requestId: number,
    ok: boolean,
): ToolCompleteResponseMessage {
    return createTimedMessage<ToolCompleteResponseMessage>({
        type: "TOOL_COMPLETE_RESPONSE",
        runId,
        requestId,
        ok,
    });
}

// ============================================================================
// 7. Framing, Serialization & Parsing Utilities
// ============================================================================

/**
 * Serializes any protocol message into a single newline-delimited JSON line.
 */
export function formatJsonLine<T>(message: T): string {
    return JSON.stringify(message) + "\n";
}

/**
 * Parses a JSON object from a protocol line, ignoring arrays and primitives.
 */
function parseJsonObject(line: string): Record<string, unknown> | null {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("{") === false) return null;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return parsed !== null && typeof parsed === "object" && Array.isArray(parsed) === false
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

/**
 * Parses a single JSON line. Returns null if empty or malformed.
 */
export function parseJsonLine<T>(line: string): T | null {
    return parseJsonObject(line) as T | null;
}

/**
 * Writes a message followed by newline to a stream and flushes if supported.
 */
export function writeJsonLine<T>(
    writer: { write(data: string): unknown; flush?(): unknown },
    message: T,
): void {
    writer.write(formatJsonLine(message));
    if (typeof writer.flush === "function") {
        writer.flush();
    }
}

/**
 * Incremental parser that buffers binary chunks or strings and yields complete parsed objects.
 * Uses TextDecoder with stream: true to avoid splitting UTF-8 multibyte characters.
 */
export class JsonLineParser<T> {
    private buffer = "";
    private readonly decoder = new TextDecoder("utf-8");

    *feed(chunk: Uint8Array | string): Generator<T, void, unknown> {
        this.buffer += typeof chunk === "string"
            ? chunk
            : this.decoder.decode(chunk, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
            const parsed = parseJsonObject(this.buffer.slice(0, newlineIndex));
            this.buffer = this.buffer.slice(newlineIndex + 1);
            if (parsed) {
                yield parsed as T;
            }
        }
    }

    *flush(): Generator<T, void, unknown> {
        this.buffer += this.decoder.decode();
        const parsed = parseJsonObject(this.buffer);
        this.buffer = "";
        if (parsed) {
            yield parsed as T;
        }
    }
}

/**
 * Async generator reading line-delimited JSON messages from a Web ReadableStream or Node stream.
 */
export async function* createJsonLineReader<T>(
    stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
): AsyncGenerator<T, void, unknown> {
    const parser = new JsonLineParser<T>();

    if ("getReader" in stream && typeof stream.getReader === "function") {
        // Web ReadableStream (e.g. Bun.spawn stdout)
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    for (const item of parser.feed(value)) {
                        yield item;
                    }
                }
            }
            for (const item of parser.flush()) {
                yield item;
            }
        } finally {
            reader.releaseLock();
        }
    } else {
        // Node.js ReadableStream (e.g. process.stdin in Worker)
        const nodeStream = stream as NodeJS.ReadableStream;
        for await (const chunk of nodeStream) {
            for (const item of parser.feed(chunk as Uint8Array)) {
                yield item;
            }
        }
        for (const item of parser.flush()) {
            yield item;
        }
    }
}
