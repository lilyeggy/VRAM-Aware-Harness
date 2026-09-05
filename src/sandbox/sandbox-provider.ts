import type { EffectivePolicySnapshot } from "../policies/effective-policy.ts";
import type {
    SandboxProfile,
    SandboxRuntimeEvidence,
    SandboxSpec,
} from "./sandbox-profile.ts";

export type SandboxStatus =
    | "PROVISIONING"
    | "ACTIVE"
    | "TERMINATED"
    | "LOST"
    | "FAILED";

export interface SandboxRecord {
    readonly id: string;
    readonly instanceId: string;
    readonly runId: string;
    readonly policySnapshotId: string;
    readonly provider: string;
    readonly profile: SandboxProfile;
    readonly runtime: string;
    readonly spec: SandboxSpec;
    readonly runtimeEvidence: SandboxRuntimeEvidence;
    readonly status: SandboxStatus;
    readonly workspacePath: string;
    readonly secretNames: readonly string[];
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly failureReason: string | null;
}

export interface SandboxHandle {
    readonly id: string;
    readonly workspacePath: string;
    readonly secretNames: readonly string[];
    /** Runtime facts, not desired policy. Consumers must fail closed on gaps. */
    readonly enforcement: SandboxEnforcementCapabilities;
    withSecrets<T>(callback: (environment: Readonly<Record<string, string>>) => T): T;
    readonly acquisition?: {
        readonly durationMs: number;
        readonly warmHit: boolean;
    };
}

export interface SandboxEnforcementCapabilities {
    readonly toolExecutionBoundary: "HOST" | "SANDBOX";
    readonly filesystemIsolation: boolean;
    readonly processIsolation: boolean;
    readonly networkPolicyEnforced: boolean;
    readonly cpuLimitEnforced: boolean;
    readonly memoryLimitEnforced: boolean;
    readonly diskLimitEnforced: boolean;
    readonly pidLimitEnforced: boolean;
}

export interface SandboxLifecycleEvent {
    readonly sandboxId: string;
    readonly runId: string;
    readonly instanceId: string;
    readonly status: "LOST" | "FAILED";
    readonly reason: string;
    readonly timestamp: string;
}

export interface SandboxProvider {
    close?(): void | Promise<void>;
    create(input: {
        id: string;
        runId: string;
        instanceId: string;
        workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle>;
    terminate(sandboxId: string): Promise<void>;
    subscribe(handler: (event: SandboxLifecycleEvent) => void): () => void;
    /** Remove an execution environment left by a previous service process. */
    cleanupStale?(record: SandboxRecord): Promise<void>;
}

/** Optional command boundary for tools that must execute inside a created sandbox. */
export interface SandboxCommandExecutor {
    execute(
        sandboxId: string,
        command: readonly string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface SecretProvider {
    /** Secret values are resolved in a Tenant namespace, never by a global name. */
    get(tenantId: string, name: string): string | null;
}
