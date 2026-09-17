import type {
    Checkpoint,
} from "../checkpoints/checkpoint.ts";
import type {
    PolicyDecision,
} from "../resources/execution-policy.ts";
import type {
    ResourceObservation,
} from "../resources/resource-observer.ts";
import type {
    AgentRun,
    RunEvent,
} from "../runs/agent-run.ts";
import {
    buildRecoveryContinuationInput,
    type ResumeRunInput,
    type StartRunInput,
} from "../runs/run-service.ts";
import type {
    QueueEntry,
} from "../scheduling/tenant-run-scheduler.ts";
import type { RequestPrincipal } from "../auth/request-principal.ts";
import { digest } from "../auth/api-credential-store.ts";
import { hasScope } from "../auth/request-principal.ts";
import type { WorkspaceService } from "../workspaces/workspace-service.ts";
import type { RunLimitation } from "../policies/run-limitations.ts";
import type { RunOutputChunk } from "../runs/run-output-store.ts";
import type { WorkspaceDiff } from "../workspaces/workspace-snapshot.ts";
import type { RunArtifact } from "../workspaces/run-artifact-store.ts";
import type { AccessAuditStore } from "../audit/access-audit-store.ts";
import type { LlmGateway } from "../llm-gateway/llm-gateway.ts";
import { userConsoleResponse } from "./harness-user-console.ts";
import type { Conversation } from "../sessions/harness-session.ts";
import type { PolicyConstraints, PolicyLayer, ResourceLimits } from "../policies/effective-policy.ts";
import type { ToolExecution } from "../tools/tool-execution.ts";
export type UnknownEffectResolution = "NO_EFFECT" | "EFFECT_OCCURRED";

export interface HarnessHttpApplication {
    isStarted():boolean;
    submitRun(input:StartRunInput):AgentRun;
    getRun(runId:string):AgentRun | null;
    getRunsForTenant(tenantId:string):AgentRun[];
    createConversation?(input: { tenantId: string; workspaceId: string; title?: string }): Conversation;
    getConversation?(id: string, tenantId: string): Conversation | null;
    getConversationsForWorkspace?(tenantId: string, workspaceId: string): Conversation[];
    getRunsForConversation?(tenantId: string, conversationId: string): AgentRun[];
    touchConversation?(id: string, tenantId: string): void;
    /** B6：会话归属查询；未提供时跳过会话抢注校验（兼容最小装配）。 */
    resolveSessionOwner?(harnessSessionId: string): string | null;
    getRunEvents(runId:string):RunEvent[];
    getRunOutput(runId:string):{ chunks: RunOutputChunk[]; finalText: string; thinkingText?: string };
    getRunWorkspaceDiff(runId:string):WorkspaceDiff | null;
    getRunArtifacts(runId:string):RunArtifact[];
    getRunArtifact(runId:string, path:string):Promise<Uint8Array | null>;
    getRunDecisions(runId:string):PolicyDecision[];
    /** N3：完成但受限的 Run 的 DENY 聚合；未装配时为空数组。 */
    getRunLimitations?(runId:string):RunLimitation[];
    getQueue():QueueEntry[];
    observeResources():Promise<ResourceObservation>;
    interruptRun(runId:string):Promise<AgentRun>;
    resumeRun(input:ResumeRunInput):AgentRun;
    /** N15：策略管理面（读写租户/平台策略层）。未装配时相关路由返回 503。 */
    /** N16：UNKNOWN_EFFECT 的人工消解出口。 */
    getRunUnknownEffects?(runId:string):ToolExecution[];
    resolveUnknownEffect?(
        runId:string,
        input:{ resolution:UnknownEffectResolution; note?:string; actor:string | null },
    ):{ run:AgentRun; resolvedExecutionIds:string[] };
}

export interface CheckpointLookup {
    get(checkpointId:string):Checkpoint | null;
}

export interface HttpAccessControl {
    authenticate(rawKey: string): RequestPrincipal | null;
    registerUser?(email: string, password: string): Promise<{ userId: string; tenantId: string }>;
    loginUser?(email: string, password: string): Promise<{ token: string; userId: string; tenantId: string; expiresAt: string } | null>;
    revokeSession?(token: string): boolean;
    revokeAllSessions?(userId: string): number;
    /** D4：会话归属查询，供登出审计归因。 */
    sessionOwner?(token: string): string | null;
    workspaceService: WorkspaceService;
    auditStore?: AccessAuditStore;
}
