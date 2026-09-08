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
import type { SandboxProfile } from "../sandbox/sandbox-profile.ts";

export const WORKER_PROTOCOL_VERSION = 1;

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

export type MasterToWorkerMessage =
    | StartRunMessage
    | ResumeRunMessage
    | InterruptRunMessage
    | ShutdownMessage;

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

export type WorkerToMasterMessage =
    | WorkerReadyMessage
    | RuntimeEventMessage
    | RunCompletedMessage
    | RunFailedMessage
    | RunInterruptedMessage;

export type WorkerProtocolMessage = MasterToWorkerMessage | WorkerToMasterMessage;

// ============================================================================
// 5. Type Guards
// ============================================================================

export function isMasterToWorkerMessage(value: unknown): value is MasterToWorkerMessage {
    if (typeof value !== "object" || value === null) return false;
    const type = (value as { type?: unknown }).type;
    return (
        type === "START_RUN" ||
        type === "RESUME_RUN" ||
        type === "INTERRUPT_RUN" ||
        type === "SHUTDOWN"
    );
}

export function isWorkerToMasterMessage(value: unknown): value is WorkerToMasterMessage {
    if (typeof value !== "object" || value === null) return false;
    const type = (value as { type?: unknown }).type;
    return (
        type === "WORKER_READY" ||
        type === "RUNTIME_EVENT" ||
        type === "RUN_COMPLETED" ||
        type === "RUN_FAILED" ||
        type === "RUN_INTERRUPTED"
    );
}

// ============================================================================
// 6. Message Factory Helpers
// ============================================================================

export function createStartRunMessage(
    runId: string,
    request: RuntimeStartRequest,
    workerConfig?: WorkerRuntimeConfig,
): StartRunMessage {
    return {
        type: "START_RUN",
        runId,
        request,
        workerConfig,
        timestamp: new Date().toISOString(),
    };
}

export function createResumeRunMessage(
    runId: string,
    request: RuntimeResumeRequest,
    workerConfig?: WorkerRuntimeConfig,
): ResumeRunMessage {
    return {
        type: "RESUME_RUN",
        runId,
        request,
        workerConfig,
        timestamp: new Date().toISOString(),
    };
}

export function createInterruptRunMessage(
    runId: string,
    reason?: string,
): InterruptRunMessage {
    return {
        type: "INTERRUPT_RUN",
        runId,
        reason,
        timestamp: new Date().toISOString(),
    };
}

export function createShutdownMessage(graceful = true): ShutdownMessage {
    return {
        type: "SHUTDOWN",
        graceful,
        timestamp: new Date().toISOString(),
    };
}

export function createWorkerReadyMessage(pid: number, runId?: string): WorkerReadyMessage {
    return {
        type: "WORKER_READY",
        pid,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        runId,
        timestamp: new Date().toISOString(),
    };
}

export function createRuntimeEventMessage(
    runId: string,
    event: RuntimeEvent,
): RuntimeEventMessage {
    return {
        type: "RUNTIME_EVENT",
        runId,
        event,
    };
}

export function createRunCompletedMessage(
    runId: string,
    output?: string,
): RunCompletedMessage {
    return {
        type: "RUN_COMPLETED",
        runId,
        output,
        timestamp: new Date().toISOString(),
    };
}

export function createRunFailedMessage(
    runId: string,
    error: unknown,
): RunFailedMessage {
    const serialized = serializeError(error);
    return {
        type: "RUN_FAILED",
        runId,
        error: serialized.message,
        stack: serialized.stack,
        timestamp: new Date().toISOString(),
    };
}

export function createRunInterruptedMessage(
    runId: string,
    reason?: string,
): RunInterruptedMessage {
    return {
        type: "RUN_INTERRUPTED",
        runId,
        reason,
        timestamp: new Date().toISOString(),
    };
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
 * Parses a single JSON line. Returns null if empty or malformed.
 */
export function parseJsonLine<T>(line: string): T | null {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as T;
        }
        return null;
    } catch {
        return null;
    }
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
        if (typeof chunk === "string") {
            this.buffer += chunk;
        } else {
            this.buffer += this.decoder.decode(chunk, { stream: true });
        }

        let newlineIndex: number;
        while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line.length === 0 || !line.startsWith("{")) continue;

            try {
                const parsed = JSON.parse(line);
                if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                    yield parsed as T;
                }
            } catch {
                // Ignore extraneous or unformatted lines (e.g. non-protocol logs)
            }
        }
    }

    *flush(): Generator<T, void, unknown> {
        this.buffer += this.decoder.decode();
        const line = this.buffer.trim();
        this.buffer = "";
        if (line.length > 0 && line.startsWith("{")) {
            try {
                const parsed = JSON.parse(line);
                if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                    yield parsed as T;
                }
            } catch {
                // Ignore trailing invalid line
            }
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
