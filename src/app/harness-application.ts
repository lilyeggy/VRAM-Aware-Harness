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
        this.queuePump.stop();
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
}
