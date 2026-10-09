
import type { EffectivePolicySnapshot } from "../../policies/effective-policy.ts";
import type { MicrovmExecutionResult } from "../microvm/microvm-types.ts";
import type {
    SandboxEnforcementCapabilities,
    SandboxRecord,
} from "../sandbox-provider.ts";

/** 可在 Broker 与 Master/Worker 之间传输的 SandboxHandle 子集（不含函数）。 */
export interface BrokerSandboxHandlePayload {
    readonly id: string;
    readonly workspacePath: string;
    readonly secretNames: readonly string[];
    readonly enforcement: SandboxEnforcementCapabilities;
    readonly mountRoot: string;
    readonly containerWorkdir: string;
    readonly acquisition?: {
        readonly durationMs: number;
        readonly warmHit: boolean;
    };
}

export interface BrokerCreateInput {
    readonly id: string;
    readonly runId: string;
    readonly workspacePath: string;
    readonly policy: EffectivePolicySnapshot;
}

export interface BrokerCreateResult {
    readonly record: SandboxRecord;
    readonly handle: BrokerSandboxHandlePayload;
}

export interface BrokerExecuteOptions {
    readonly workdir?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
}

export type BrokerRequest =
    | { readonly id: string; readonly op: "ping" }
    | { readonly id: string; readonly op: "create"; readonly input: BrokerCreateInput }
    | {
        readonly id: string;
        readonly op: "execute";
        readonly sandboxId: string;
        readonly command: readonly string[];
        readonly options?: BrokerExecuteOptions;
    }
    | { readonly id: string; readonly op: "terminate"; readonly sandboxId: string };

export type BrokerResponse =
    | { readonly id: string; readonly ok: true; readonly result: unknown }
    | { readonly id: string; readonly ok: false; readonly error: string };

export function isBrokerRequest(value: unknown): value is BrokerRequest {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as { id?: unknown; op?: unknown };
    if (typeof candidate.id !== "string") {
        return false;
    }
    return candidate.op === "ping"
        || candidate.op === "create"
        || candidate.op === "execute"
        || candidate.op === "terminate";
}

export function isBrokerResponse(value: unknown): value is BrokerResponse {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as { id?: unknown; ok?: unknown };
    return typeof candidate.id === "string" && typeof candidate.ok === "boolean";
}

export type { MicrovmExecutionResult };
