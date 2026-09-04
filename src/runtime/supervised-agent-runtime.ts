import type { SandboxProvider } from "../sandbox/sandbox-provider.ts";
import type { AgentRuntime, RuntimeEventHandler, RuntimeResumeRequest, RuntimeStartRequest } from "./agent-runtime.ts";

export interface ExecutionSupervisorConfig {
    readonly executionTimeoutMs: number;
    readonly interruptGraceMs: number;
}

interface ActiveInvocation {
    readonly sandboxId: string | undefined;
    readonly runtimePromise: Promise<void>;
    readonly forceStop: (error: Error) => void;
    readonly forced: Promise<never>;
}

export class RuntimeExecutionTimeoutError extends Error {
    constructor(readonly runId: string, readonly timeoutMs: number) {
        super(`Agent Runtime 执行超时：${runId} (${timeoutMs}ms)`);
        this.name = "RuntimeExecutionTimeoutError";
    }
}

/** Bounds runtime calls and converts an unresponsive abort into sandbox cleanup. */
export class SupervisedAgentRuntime implements AgentRuntime {
    private readonly active = new Map<string, ActiveInvocation>();

    constructor(
        private readonly inner: AgentRuntime,
        private readonly sandbox: SandboxProvider,
        private readonly config: ExecutionSupervisorConfig,
    ) {
        assertPositive(config.executionTimeoutMs, "executionTimeoutMs");
        assertPositive(config.interruptGraceMs, "interruptGraceMs");
    }

    subscribe(runId: string, handler: RuntimeEventHandler) { return this.inner.subscribe(runId, handler); }
    start(request: RuntimeStartRequest) {
        return this.invoke(request.run.runId, request.execution?.sandboxId, () => this.inner.start(request));
    }
    resume(request: RuntimeResumeRequest) {
        return this.invoke(request.run.runId, request.execution?.sandboxId, () => this.inner.resume(request));
    }

    async interrupt(runId: string): Promise<void> {
        const active = this.active.get(runId);
        await this.interruptWithinGrace(runId);
        if (active !== undefined && !(await settlesWithin(active.runtimePromise, this.config.interruptGraceMs))) {
            await this.terminate(active.sandboxId);
            active.forceStop(new Error(`Agent Runtime 未在中断宽限期内退出：${runId}`));
        }
    }

    private async invoke(
        runId: string,
        sandboxId: string | undefined,
        operation: () => Promise<void>,
    ): Promise<void> {
        if (this.active.has(runId)) throw new Error(`Run 已在 Runtime 中执行：${runId}`);
        const runtimePromise = operation();
        let forceStop!: (error: Error) => void;
        const forced = new Promise<never>((_resolve, reject) => { forceStop = reject; });
        const invocation = { sandboxId, runtimePromise, forceStop, forced };
        this.active.set(runId, invocation);
        const timeout = deferredTimeout(this.config.executionTimeoutMs);
        try {
            const outcome = await Promise.race([
                runtimePromise.then(() => "DONE" as const),
                timeout.promise.then(() => "TIMEOUT" as const),
                forced,
            ]);
            if (outcome === "DONE") return;
            await this.interruptWithinGrace(runId);
            await this.terminate(sandboxId);
            void runtimePromise.catch(() => undefined);
            throw new RuntimeExecutionTimeoutError(runId, this.config.executionTimeoutMs);
        } finally {
            timeout.cancel();
            if (this.active.get(runId) === invocation) this.active.delete(runId);
        }
    }

    private async interruptWithinGrace(runId: string): Promise<void> {
        const interrupt = this.inner.interrupt(runId);
        if (!(await settlesWithin(interrupt, this.config.interruptGraceMs))) void interrupt.catch(() => undefined);
    }

    private async terminate(sandboxId: string | undefined): Promise<void> {
        if (sandboxId !== undefined) await this.sandbox.terminate(sandboxId);
    }
}

function deferredTimeout(ms: number) {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    return { promise, cancel: () => clearTimeout(timer!) };
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const timeout = deferredTimeout(ms);
    try {
        return await Promise.race([
            promise.then(() => true, () => true),
            timeout.promise.then(() => false),
        ]);
    } finally { timeout.cancel(); }
}

function assertPositive(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须大于 0`);
}
