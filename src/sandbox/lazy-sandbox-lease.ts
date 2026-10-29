import type { SandboxHandle } from "./sandbox-provider.ts";

/**
 * One execution's on-demand sandbox lifecycle. Concurrent callers share one
 * acquisition; closing during acquisition waits for it and releases it once.
 * Authorization and resource admission remain the caller's responsibility.
 */
export class LazySandboxLease {
    private pending: Promise<SandboxHandle> | undefined;
    private closing: Promise<void> | undefined;
    private closed = false;

    constructor(
        private readonly acquire: () => Promise<SandboxHandle>,
        private readonly release: (handle: SandboxHandle) => Promise<void>,
    ) {}

    async getOrCreate(): Promise<SandboxHandle> {
        if (this.closed) throw new Error("Sandbox 生命周期已结束，拒绝创建");
        if (!this.pending) {
            const pending = Promise.resolve().then(() => this.acquire());
            this.pending = pending;
            // A failed acquisition may be retried explicitly by a later caller.
            void pending.catch(() => { if (this.pending === pending) this.pending = undefined; });
        }
        const handle = await this.pending;
        if (this.closed) throw new Error("Sandbox 创建期间 Run 已结束");
        return handle;
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        const pending = this.pending;
        this.closing = (async () => {
            if (!pending) return;
            let handle: SandboxHandle;
            try { handle = await pending; } catch { return; }
            await this.release(handle);
        })();
        return this.closing;
    }
}
