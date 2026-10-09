
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
        /** 请求方租户；Broker 用它做 sandbox 归属校验，防止跨租户执行。 */
        readonly tenantId: string;
        readonly command: readonly string[];
        readonly options?: BrokerExecuteOptions;
    }
    | {
        readonly id: string;
        readonly op: "terminate";
        readonly sandboxId: string;
        /** 请求方租户；Broker 用它做 sandbox 归属校验，防止跨租户终止。 */
        readonly tenantId: string;
    };

export type BrokerResponse =
    | { readonly id: string; readonly ok: true; readonly result: unknown }
    | { readonly id: string; readonly ok: false; readonly error: string };

export function isBrokerRequest(value: unknown): value is BrokerRequest {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as { id?: unknown; op?: unknown; tenantId?: unknown };
    if (typeof candidate.id !== "string") {
        return false;
    }
    if (candidate.op === "execute" || candidate.op === "terminate") {
        return typeof candidate.tenantId === "string" && candidate.tenantId.length > 0;
    }
    return candidate.op === "ping" || candidate.op === "create";
}

export function isBrokerResponse(value: unknown): value is BrokerResponse {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as { id?: unknown; ok?: unknown };
    return typeof candidate.id === "string" && typeof candidate.ok === "boolean";
}

export type { MicrovmExecutionResult };
