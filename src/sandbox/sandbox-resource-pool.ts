/**
 * Two-layer sandbox control-plane prototype.
 *
 * SandboxResource is a reusable execution capacity. It deliberately carries
 * no tenant, run, workspace, policy, or secret identity.
 * SandboxLease is the per-attempt authorization and ownership context.
 *
 * This module is intentionally not wired into the production provider yet:
 * the current Docker provider binds workspace and secrets at container create
 * time. Reuse is only safe after the provider can re-bind and scrub those
 * values between leases.
 */

export type SandboxResourceState = "WARM" | "LEASED" | "QUARANTINED";

export interface SandboxResourceProfile {
    readonly image: string;
    readonly runtime: "runsc" | "runc";
    readonly profile: "default" | "restricted-egress" | "development";
}

export interface SandboxResource {
    readonly id: string;
    readonly profile: SandboxResourceProfile;
    readonly state: SandboxResourceState;
    readonly leaseId: string | null;
    readonly createdAt: string;
    readonly lastReleasedAt: string | null;
}

export interface SandboxLease {
    readonly id: string;
    readonly resourceId: string;
    readonly runId: string;
    readonly tenantId: string;
    readonly workspacePath: string;
    readonly policySnapshotId: string;
    readonly secretNames: readonly string[];
    readonly acquiredAt: string;
}

export interface AcquireSandboxLeaseInput {
    readonly runId: string;
    readonly tenantId: string;
    readonly workspacePath: string;
    readonly policySnapshotId: string;
    readonly secretNames: readonly string[];
    readonly profile: SandboxResourceProfile;
}

export interface SandboxLeaseReleaseResult {
    readonly scrubbed: boolean;
    readonly reason?: string;
}

export interface SandboxResourceFactory {
    createResource(profile: SandboxResourceProfile): Promise<{ id: string }>;
    destroyResource(resourceId: string): Promise<void>;
}

export interface SandboxLeaseAcquireOptions {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

/**
 * Async manager used by a future provider-backed warm pool.
 * Resource creation is intentionally separated from lease authorization.
 */
export class ManagedSandboxResourcePool {
    private readonly pool: SandboxResourcePool;
    private readonly waiters: Array<{
        readonly input: AcquireSandboxLeaseInput;
        readonly resolve: (value: { resource: SandboxResource; lease: SandboxLease } | null) => void;
        readonly reject: (error: unknown) => void;
        readonly timer: ReturnType<typeof setTimeout> | null;
    }> = [];

    constructor(
        private readonly factory: SandboxResourceFactory,
        private readonly capacity: number,
    ) {
        if (!Number.isInteger(capacity) || capacity <= 0) {
            throw new Error("SandboxResourcePool capacity 必须为正整数");
        }
        this.pool = new SandboxResourcePool();
    }

    async warm(profile: SandboxResourceProfile, count = this.capacity): Promise<number> {
        if (!Number.isInteger(count) || count < 0 || count > this.capacity) {
            throw new Error("预热数量必须在 0 到 capacity 之间");
        }
        let created = 0;
        while (this.pool.listResources().length < count) {
            const resource = await this.factory.createResource(profile);
            this.pool.register({ id: resource.id, profile });
            created += 1;
        }
        return created;
    }

    acquire(
        input: AcquireSandboxLeaseInput,
        options: SandboxLeaseAcquireOptions = {},
    ): Promise<{ resource: SandboxResource; lease: SandboxLease } | null> {
        const immediate = this.pool.acquire(input);
        if (immediate !== null) return Promise.resolve(immediate);
        if (options.signal?.aborted) return Promise.reject(new Error("Sandbox Lease 获取已取消"));

        return new Promise((resolve, reject) => {
            const timeout = options.timeoutMs === undefined ? null : setTimeout(() => {
                const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
                if (index >= 0) this.waiters.splice(index, 1);
                resolve(null);
            }, options.timeoutMs);
            this.waiters.push({ input, resolve, reject, timer: timeout });
            options.signal?.addEventListener("abort", () => {
                const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
                if (index >= 0) this.waiters.splice(index, 1);
                if (timeout !== null) clearTimeout(timeout);
                reject(new Error("Sandbox Lease 获取已取消"));
            }, { once: true });
        });
    }

    release(
        leaseId: string,
        tenantId: string,
        result: SandboxLeaseReleaseResult,
    ): SandboxResource {
        const resource = this.pool.release(leaseId, tenantId, result);
        this.drainWaiters();
        return resource;
    }

    async destroyQuarantined(): Promise<number> {
        const quarantined = this.pool.listResources().filter((resource) => resource.state === "QUARANTINED");
        for (const resource of quarantined) await this.factory.destroyResource(resource.id);
        return quarantined.length;
    }

    resources(): readonly SandboxResource[] { return this.pool.listResources(); }
    leases(): readonly SandboxLease[] { return this.pool.listLeases(); }

    private drainWaiters(): void {
        for (let index = 0; index < this.waiters.length; index += 1) {
            const waiter = this.waiters[index];
            if (waiter === undefined) continue;
            const acquired = this.pool.acquire(waiter.input);
            if (acquired === null) continue;
            this.waiters.splice(index, 1);
            index -= 1;
            if (waiter.timer !== null) clearTimeout(waiter.timer);
            waiter.resolve(acquired);
        }
    }
}

export class SandboxResourcePool {
    private readonly resources = new Map<string, SandboxResource>();
    private readonly leases = new Map<string, SandboxLease>();

    register(input: {
        readonly id: string;
        readonly profile: SandboxResourceProfile;
        readonly createdAt?: string;
    }): SandboxResource {
        if (this.resources.has(input.id)) {
            throw new Error(`SandboxResource 已存在：${input.id}`);
        }

        const resource: SandboxResource = Object.freeze({
            id: input.id,
            profile: input.profile,
            state: "WARM",
            leaseId: null,
            createdAt: input.createdAt ?? new Date().toISOString(),
            lastReleasedAt: null,
        });
        this.resources.set(resource.id, resource);
        return resource;
    }

    acquire(input: AcquireSandboxLeaseInput): {
        readonly resource: SandboxResource;
        readonly lease: SandboxLease;
    } | null {
        const resource = [...this.resources.values()].find((candidate) =>
            candidate.state === "WARM"
            && sameProfile(candidate.profile, input.profile),
        );
        if (resource === undefined) return null;

        const lease: SandboxLease = Object.freeze({
            id: crypto.randomUUID(),
            resourceId: resource.id,
            runId: input.runId,
            tenantId: input.tenantId,
            workspacePath: input.workspacePath,
            policySnapshotId: input.policySnapshotId,
            secretNames: Object.freeze([...input.secretNames]),
            acquiredAt: new Date().toISOString(),
        });
        const leased = Object.freeze({
            ...resource,
            state: "LEASED" as const,
            leaseId: lease.id,
        });
        this.resources.set(resource.id, leased);
        this.leases.set(lease.id, lease);
        return { resource: leased, lease };
    }

    getLease(leaseId: string, tenantId: string): SandboxLease | null {
        const lease = this.leases.get(leaseId);
        return lease?.tenantId === tenantId ? lease : null;
    }

    release(
        leaseId: string,
        tenantId: string,
        result: SandboxLeaseReleaseResult,
    ): SandboxResource {
        const lease = this.leases.get(leaseId);
        if (lease === undefined || lease.tenantId !== tenantId) {
            throw new Error(`无权释放 SandboxLease：${leaseId}`);
        }
        const resource = this.resources.get(lease.resourceId);
        if (resource === undefined || resource.leaseId !== leaseId) {
            throw new Error(`SandboxResource 与 Lease 不一致：${leaseId}`);
        }
        this.leases.delete(leaseId);

        const next = Object.freeze({
            ...resource,
            state: result.scrubbed ? "WARM" as const : "QUARANTINED" as const,
            leaseId: null,
            lastReleasedAt: new Date().toISOString(),
        });
        this.resources.set(resource.id, next);
        return next;
    }

    listResources(): readonly SandboxResource[] {
        return [...this.resources.values()];
    }

    listLeases(): readonly SandboxLease[] {
        return [...this.leases.values()];
    }
}

function sameProfile(
    left: SandboxResourceProfile,
    right: SandboxResourceProfile,
): boolean {
    return left.image === right.image
        && left.runtime === right.runtime
        && left.profile === right.profile;
}
