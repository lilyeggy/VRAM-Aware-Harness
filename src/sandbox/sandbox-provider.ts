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
    /**
     * 宿主侧挂载根：容器内 /workspace 实际对应的宿主目录。
     * RUN 视野下等于本 Run 的工作区；USER 视野下等于用户工作区根。
     * 工具路径映射必须以它为前缀换算，不能假定它等于 workspacePath。
     */
    readonly mountRoot: string;
    /**
     * 容器内工作目录（bash 等工具的 cwd）。RUN 视野下是 /workspace，
     * USER 视野下是 /workspace/<本 Run 工作区相对用户根的路径>。
     * HOST 边界下没有容器路径语义，等于 workspacePath。
     */
    readonly containerWorkdir: string;
    /**
     * 方案 B：Broker 签发的 per-sandbox capability token。仅 BrokerSandboxProvider
     * 会产生；Worker 用它执行工具命令，不进入审计事件或日志。
     */
    readonly capabilityToken?: string;
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
    /**
     * 工作区视野粒度。RUN：容器只能看见本 Run 的工作区，同用户跨 Run 物理不可见。
     * USER：容器挂用户工作区根，同用户跨 Run 靠策略约束而非物理视野隔离，
     * 换来同用户全量复用。策略守卫据此判断文件系统隔离是否满足要求。
     */
    readonly workspaceScope: "RUN" | "USER" | "NONE";
}

export interface SandboxLifecycleEvent {
    readonly sandboxId: string;
    readonly runId: string;
    readonly status: "LOST" | "FAILED";
    readonly reason: string;
    readonly timestamp: string;
}

export interface SandboxProvider {
    close?(): void | Promise<void>;
    create(input: {
        id: string;
        runId: string;
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
        options?: { readonly workdir?: string },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface SecretProvider {
    /** Secret values are resolved in a User namespace, never by a global name. */
    get(userId: string, name: string): string | null;
}
