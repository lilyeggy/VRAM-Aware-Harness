import type { SandboxAcquireResponseMessage, WorkerToMasterMessage } from "./worker-protocol.ts";

type Grant = Extract<SandboxAcquireResponseMessage["result"], { ok: true }>;

/** Worker-side IPC client; it never receives the Master control credential. */
export class WorkerSandboxRequester {
    private nextId = 1;
    private pending: { requestId: number; promise: Promise<Grant>; resolve: (grant: Grant) => void;
        reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
    private grant: Grant | undefined;
    private stopped = false;

    constructor(private readonly runId: string, private readonly send: (message: WorkerToMasterMessage) => void,
        private readonly timeoutMs = 120_000) {}

    getOrRequest(): Promise<Grant> {
        if (this.stopped) return Promise.reject(new Error("Sandbox 申请通道已关闭"));
        if (this.grant) return Promise.resolve(this.grant);
        if (this.pending) return this.pending.promise;
        const requestId = this.nextId++;
        let resolve!: (grant: Grant) => void; let reject!: (error: Error) => void;
        const promise = new Promise<Grant>((ok, fail) => { resolve = ok; reject = fail; });
        const timer = setTimeout(() => {
            if (this.pending?.requestId !== requestId) return;
            this.pending = undefined;
            reject(new Error("Sandbox 申请超时，拒绝执行工具"));
        }, this.timeoutMs);
        this.pending = { requestId, promise, resolve, reject, timer };
        try { this.send({ type: "SANDBOX_ACQUIRE_REQUEST", runId: this.runId, requestId }); }
        catch (error) {
            clearTimeout(timer); this.pending = undefined;
            reject(error instanceof Error ? error : new Error(String(error)));
        }
        return promise;
    }

    handle(message: SandboxAcquireResponseMessage): void {
        const pending = this.pending;
        if (!pending || message.runId !== this.runId || message.requestId !== pending.requestId) return;
        clearTimeout(pending.timer); this.pending = undefined;
        if (message.result.ok) { this.grant = message.result; pending.resolve(message.result); }
        else pending.reject(new Error(message.result.error));
    }

    close(): void {
        this.stopped = true;
        if (!this.pending) return;
        clearTimeout(this.pending.timer);
        this.pending.reject(new Error("Sandbox 申请通道已关闭"));
        this.pending = undefined;
    }
}
