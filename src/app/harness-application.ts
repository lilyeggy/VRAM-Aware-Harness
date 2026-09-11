import type {
    PolicyDecisionStore,
} from "../resources/policy-decision-store.ts";
import type {
    PolicyDecision,
} from "../resources/execution-policy.ts";
import type {
    ResourceObservation,
    ResourceObserver,
} from "../resources/resource-observer.ts";
import type {
    RunStore,
} from "../runs/runstore.ts";
import type { RunOutputStore, RunOutputChunk } from "../runs/run-output-store.ts";
import type { WorkspaceDiff } from "../workspaces/workspace-snapshot.ts";
import type { RunWorkspaceResultCoordinator } from "../workspaces/run-workspace-result.ts";
import type { RunArtifact } from "../workspaces/run-artifact-store.ts";
import type {
    RunQueueCoordinator,
} from "../scheduling/run-queue-coordinator.ts";
import type {
    RunQueuePump,
} from "../scheduling/run-queue-pump.ts";
import type {
    QueueEntry,
    SchedulerCapacity,
    TenantRunScheduler,
} from "../scheduling/tenant-run-scheduler.ts";
import type {
    AgentRun,
    RunEvent,
}   from "../runs/agent-run.ts";
import type {
    ResumeRunInput,
    StartRunInput,
}   from "../runs/run-service.ts";
import type { HarnessInstance } from "../instances/harness-instance.ts";
import type { HarnessInstanceStore } from "../instances/harness-instance-store.ts";
import type { Conversation } from "../conversations/conversation.ts";
import { createConversation } from "../conversations/conversation.ts";
import type { ConversationStore } from "../conversations/conversation-store.ts";
import { summarizeToolDenials, type RunLimitation } from "../policies/run-limitations.ts";
import type { PolicyConstraints, PolicyLayer } from "../policies/effective-policy.ts";
import type { PolicyRegistry } from "../policies/policy-registry.ts";
import type { ToolExecution } from "../tools/tool-execution.ts";

/**
 * N16：人工消解 UNKNOWN_EFFECT 只需要"读未决执行 + 作废它"两个能力，
 * 这里用结构化接口表达，便于测试注入最小替身。
 */
export interface ToolExecutionReviewStore {
    listPreparedForRun(runId: string): ToolExecution[];
    fail(execution: ToolExecution): void;
}


export interface StartupRecoveryCoordinator {
    recover():Promise<void>;
}

/**
 * harnessApplication 要负责的很多
 * 1. 应用启动和停止
 * 2. 提交 run，并查询 run、事件、决策、队列和资源
 * 3. 后续统一处理interrupt/resume
 * 4. http 层只负责协议转换
 */
export class HarnessApplication {
    private started = false;
    private startPromise : Promise<void> | null = null;
    private stopPromise : Promise<void> | null = null;

    constructor(
        private readonly coordinator: RunQueueCoordinator,
        private readonly queuePump: RunQueuePump,
        private readonly runStore: RunStore,
        private readonly decisionStore: PolicyDecisionStore,
        private readonly scheduler: TenantRunScheduler,
        private readonly resourceObserver: ResourceObserver,
        private readonly startupRecovery:StartupRecoveryCoordinator,
        private readonly runOutputStore?: RunOutputStore,
        private readonly workspaceResults?: RunWorkspaceResultCoordinator,
        private readonly instanceStore?: HarnessInstanceStore,
        private readonly conversationStore?: ConversationStore,
        private readonly toolPolicyStore?: { listToolDecisions(runId: string): readonly { toolName: string; action: string; reason: string; decidedAt: string }[] },
        /** N15：租户/平台策略注册表（策略管理面）。 */
        private readonly policyRegistry?: PolicyRegistry,
        /** N16：工具执行库（人工消解 UNKNOWN_EFFECT）。 */
        private readonly toolExecutions?: ToolExecutionReviewStore,
    ) {}

    private async startOnce() : Promise<void> {
        try {
            await this.startupRecovery.recover();
            this.queuePump.start();
            this.started = true;
        } finally {
            this.startPromise = null;
        }
    }

    start():Promise<void> {
        if (this.started) {
            return Promise.resolve();
        }

        if (this.startPromise !== null) {
            return this.startPromise;
        }

        this.startPromise = this.startOnce();
        return this.startPromise;
    }

    async stop() : Promise<void> {
        if (this.stopPromise !== null) return this.stopPromise;
        if (this.startPromise !== null){
            await this.startPromise;
        }

        if (!this.started) {
            return;
        }

        this.started = false;
        // N20：必须"停表 + 等在飞 drain 落地"再往下走。原先只调
        // queuePump.stop()（不等在飞 tick），于是一次在飞的 drain 会越过
        // database.close() 继续写工作区快照 → closed-database 报错 20 次。
        await this.queuePump.stopAndDrain();
        this.stopPromise = (async () => {
            const activeRuns = this.runStore.listActiveRuns();
            const results = await Promise.allSettled(
                activeRuns.map((run) => this.coordinator.interrupt(run.id)),
            );
            const failures = results.filter((result) => result.status === "rejected");
            if (failures.length > 0) {
                throw new Error(`安全关闭时有 ${failures.length} 个 Run 无法中断`);
            }
        })();
        try {
            await this.stopPromise;
        } finally {
            this.stopPromise = null;
        }
    }

    isStarted() : boolean {
        return this.started;
    }

    private assertStarted() : void {
        if (!this.started) {
            throw new Error ("HarnessApplication尚未启动");
        }
    }

    submitRun(input:StartRunInput):AgentRun {
        this.assertStarted();

        const run = this.coordinator.submit(input);

        // 不等待 Run 执行结束，但是立即请求调度，不必等下一个轮询周期
        void this.queuePump.tick();

        return run;
    }

    resumeRun(input:ResumeRunInput):AgentRun {
        this.assertStarted();

        const run = this.coordinator.submitResume(input);

        // 恢复任务与新任务共用同一条自动推进路径。
        void this.queuePump.tick();

        return run;
    }

    getRun(runId:string):AgentRun | null {
        return this.runStore.get(runId);
    }

    getRunsForTenant(tenantId: string): AgentRun[] {
        return this.runStore.listForTenant(tenantId);
    }

    createConversation(input: {
        tenantId: string;
        workspaceId: string;
        title?: string;
    }): Conversation {
        if (this.conversationStore === undefined) {
            throw new Error("对话服务未启用");
        }
        const conversation = createConversation(input);
        this.conversationStore.create(conversation);
        return conversation;
    }

    getConversation(id: string, tenantId: string): Conversation | null {
        return this.conversationStore?.getForTenant(id, tenantId) ?? null;
    }

    getConversationsForWorkspace(tenantId: string, workspaceId: string): Conversation[] {
        return this.conversationStore?.listForWorkspace(tenantId, workspaceId) ?? [];
    }

    getRunsForConversation(tenantId: string, conversationId: string): AgentRun[] {
        return this.runStore.listForSession(tenantId, conversationId);
    }

    /**
     * B6：会话归属（以最早一条 Run 的租户为准）；null 表示未被使用。
     * HTTP 层用它阻止客户端自选 sessionId 抢注其他租户的会话。
     */
    resolveSessionOwner(harnessSessionId: string): string | null {
        return this.runStore.findSessionOwner(harnessSessionId);
    }

    touchConversation(id: string, tenantId: string): void {
        this.conversationStore?.touch(id, tenantId);
    }

    getAgentsForTenant(tenantId: string): HarnessInstance[] {
        return this.instanceStore?.listForTenant(tenantId) ?? [];
    }

    getRunEvents(runId:string):RunEvent[] {
        return this.runStore.listEvents(runId);
    }

    getRunOutput(runId: string): { chunks: RunOutputChunk[]; finalText: string; thinkingText: string } {
        const chunks = this.runOutputStore?.list(runId) ?? [];
        return {
            chunks,
            finalText: chunks.filter((chunk) => chunk.channel === "answer").map((chunk) => chunk.delta).join(""),
            thinkingText: chunks.filter((chunk) => chunk.channel === "thinking").map((chunk) => chunk.delta).join(""),
        };
    }

    getRunWorkspaceDiff(runId: string): WorkspaceDiff | null {
        return this.workspaceResults?.getDiff(runId) ?? null;
    }

    getRunArtifacts(runId: string): RunArtifact[] {
        return this.workspaceResults?.listArtifacts(runId) ?? [];
    }

    getRunArtifact(runId: string, path: string): Promise<Uint8Array | null> {
        return this.workspaceResults?.readArtifact(runId, path) ?? Promise.resolve(null);
    }

    getRunDecisions(runId:string):PolicyDecision[] {
        return this.decisionStore.listForRun(runId);
    }

    /** N3：完成但受限的 Run 的 DENY 账本聚合；未注入工具策略库时空数组。 */
    getRunLimitations(runId:string):RunLimitation[] {
        const decisions = this.toolPolicyStore?.listToolDecisions(runId) ?? [];
        return summarizeToolDenials(decisions);
    }

    getQueue():QueueEntry[] {
        return this.scheduler.listQueue();
    }

    getTenantCapacity(tenantId:string):SchedulerCapacity {
        return this.scheduler.getCapacity(tenantId);
    }

    observeResources():Promise<ResourceObservation> {
        return this.resourceObserver.observe();
    }

    interruptRun(runId:string) : Promise<AgentRun> {
        this.assertStarted();
        return this.coordinator.interrupt(runId);
    }

    // ------------------------------------------------------------------
    // N15：策略管理面。HTTP /admin/policies 背后的读写入口。
    // 注册表未装配时 get* 返回 null、set* 返回 false，由协议层决定 503。
    // ------------------------------------------------------------------

    getPlatformPolicy():PolicyLayer | null {
        return this.policyRegistry?.getPlatformPolicy() ?? null;
    }

    getTenantPolicy(tenantId:string):PolicyLayer | null {
        return this.policyRegistry?.getTenantPolicy(tenantId) ?? null;
    }

    setPlatformPolicy(id:string, policy:PolicyConstraints):boolean {
        if (this.policyRegistry === undefined) return false;
        this.policyRegistry.setPlatformPolicy(id, policy);
        return true;
    }

    setTenantPolicy(tenantId:string, id:string, policy:PolicyConstraints):boolean {
        if (this.policyRegistry === undefined) return false;
        this.policyRegistry.setTenantPolicy(tenantId, id, policy);
        return true;
    }

    // ------------------------------------------------------------------
    // N16：UNKNOWN_EFFECT 的人工消解出口。
    // ------------------------------------------------------------------

    /** 该 Run 上仍"结果不确定"（PREPARED）的工具调用，供界面表达"请人工核对"。 */
    getRunUnknownEffects(runId:string):ToolExecution[] {
        return this.toolExecutions?.listPreparedForRun(runId) ?? [];
    }

    /**
     * 人工核对 UNKNOWN_EFFECT 后消解：
     * - NO_EFFECT：确认该命令没有产生副作用 → 作废 PREPARED 记录（否则
     *   ToolGateway 会一直以"不允许自动重放"拒绝后续同类调用），Run 留在
     *   INTERRUPTED，可继续走既有 /resume。
     * - EFFECT_OCCURRED：确认副作用已经发生 → 同样作废 PREPARED 以避免重放
     *   二次生效，并把 Run 明确终结为 FAILED（不再假装可恢复）。
     */
    resolveUnknownEffect(
        runId:string,
        input:{
            resolution:"NO_EFFECT" | "EFFECT_OCCURRED";
            note?:string;
            actor:string | null;
        },
    ): { run:AgentRun; resolvedExecutionIds:string[] } {
        const run = this.runStore.get(runId);

        if (run === null) {
            throw new Error(`找不到 AgentRun：${runId}`);
        }
        if (run.status !== "INTERRUPTED") {
            throw new Error(
                `只有 INTERRUPTED 的 Run 需要人工消解不确定副作用，当前状态：${run.status}`,
            );
        }

        const prepared = this.toolExecutions?.listPreparedForRun(runId) ?? [];

        if (prepared.length === 0) {
            throw new Error("该 Run 没有待人工核对的不确定工具调用");
        }

        const now = new Date().toISOString();
        const resolvedExecutionIds: string[] = [];

        for (const execution of prepared) {
            this.toolExecutions!.fail({
                ...execution,
                status: "FAILED",
                result: null,
                errorMessage: input.resolution === "NO_EFFECT"
                    ? "人工核对：确认无副作用，已作废该次不确定执行"
                    : "人工核对：确认副作用已发生，已作废该次执行以避免重放",
                finishedAt: now,
            });
            resolvedExecutionIds.push(execution.id);
        }

        const baseEvent = {
            eventId: crypto.randomUUID(),
            runId,
            sequence: this.runStore.getLastEventSequence(runId) + 1,
            timestamp: now,
            payloadVersion: 1,
            payload: {
                resolution: input.resolution,
                note: input.note ?? null,
                resolvedExecutionIds,
                actor: input.actor,
            },
        } as const;

        if (input.resolution === "EFFECT_OCCURRED") {
            const failedRun: AgentRun = {
                ...run,
                status: "FAILED",
                failureReason:
                    `人工核对确认 UNKNOWN_EFFECT 的副作用已发生：${input.note ?? "无备注"}`,
                finishedAt: now,
                updatedAt: now,
            };
            this.runStore.update(failedRun, {
                ...baseEvent,
                type: "RUN_FAILED",
            });
            return { run: failedRun, resolvedExecutionIds };
        }

        this.runStore.appendEvent({
            ...baseEvent,
            type: "MANUAL_REVIEW_RESOLVED",
        });
        return { run, resolvedExecutionIds };
    }
}
