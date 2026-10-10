
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
    /**
     * Master -> Broker 的静态共享 secret（Broker 启动时从环境变量读取）。
     * Worker 侧不持有它，因此无法 create sandbox——create 只允许 Master 发起。
     */
    readonly controlToken: string;
    /**
     * Master 为本 sandbox 生成的 capability token。Broker 保存 token→sandboxId，
     * execute 必须携带匹配 token；terminate 也接受 Broker 的 controlToken
     * 作为 Master 侧恢复/清理的后门。
     */
    readonly token: string;
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
        /** 该 sandbox 的 capability token；缺失或错误一律拒绝。 */
        readonly token: string;
        readonly command: readonly string[];
        readonly options?: BrokerExecuteOptions;
    }
    | {
        readonly id: string;
        readonly op: "terminate";
        readonly sandboxId: string;
        /** 请求方租户；Broker 用它做 sandbox 归属校验，防止跨租户终止。 */
        readonly tenantId: string;
        /** 该 sandbox 的 capability token；Master 侧也可用 controlToken 覆盖。 */
        readonly token: string;
    };

export type BrokerResponse =
    | { readonly id: string; readonly ok: true; readonly result: unknown }
    | { readonly id: string; readonly ok: false; readonly error: string };

export function isBrokerRequest(value: unknown): value is BrokerRequest {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as {
        id?: unknown;
        op?: unknown;
        tenantId?: unknown;
        token?: unknown;
        input?: unknown;
    };
    if (typeof candidate.id !== "string") {
        return false;
    }
    if (candidate.op === "execute" || candidate.op === "terminate") {
        return typeof candidate.tenantId === "string"
            && candidate.tenantId.length > 0
            && typeof candidate.token === "string"
            && candidate.token.length > 0;
    }
    if (candidate.op === "create") {
        if (typeof candidate.input !== "object" || candidate.input === null) {
            return false;
        }
        const input = candidate.input as { controlToken?: unknown; token?: unknown };
        return typeof input.controlToken === "string"
            && input.controlToken.length > 0
            && typeof input.token === "string"
            && input.token.length > 0;
    }
    return candidate.op === "ping";
}

export function isBrokerResponse(value: unknown): value is BrokerResponse {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as { id?: unknown; ok?: unknown };
    return typeof candidate.id === "string" && typeof candidate.ok === "boolean";
}

export type { MicrovmExecutionResult };
