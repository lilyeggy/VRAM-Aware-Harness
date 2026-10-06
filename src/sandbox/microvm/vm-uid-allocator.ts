export interface VmUidGid {
    readonly uid: number;
    readonly gid: number;
}

export class VmUidAllocator {
    private readonly allocations = new Map<string, VmUidGid>();

    /** base 默认 20000，上限 29999。分配 = base + 最小未用值。 */
    constructor(
        private readonly baseUid = 20000,
        private readonly maxUid = 29999,
    ) {
        if (baseUid < 1000) {
            throw new Error(`baseUid must be >= 1000 to avoid system users, got ${baseUid}`);
        }
        if (maxUid < baseUid) {
            throw new Error(`maxUid (${maxUid}) must be >= baseUid (${baseUid})`);
        }
    }

    allocate(sandboxIdOrActiveIds: string | readonly string[]): VmUidGid {
        if (typeof sandboxIdOrActiveIds === "string") {
            const sandboxId = sandboxIdOrActiveIds;
            const existing = this.allocations.get(sandboxId);
            if (existing) {
                return existing;
            }

            const usedUids = new Set(Array.from(this.allocations.values()).map((v) => v.uid));
            for (let candidate = this.baseUid; candidate <= this.maxUid; candidate++) {
                if (!usedUids.has(candidate)) {
                    const result = { uid: candidate, gid: candidate };
                    this.allocations.set(sandboxId, result);
                    return result;
                }
            }
            throw new Error(`UID pool exhausted (range: ${this.baseUid}-${this.maxUid})`);
        }

        // If called as allocate(activeIds: readonly string[])
        const activeIds = sandboxIdOrActiveIds;
        // Purge any allocations not in activeIds
        const activeSet = new Set(activeIds);
        for (const [id] of this.allocations.entries()) {
            if (!activeSet.has(id)) {
                this.allocations.delete(id);
            }
        }
        const usedUids = new Set(Array.from(this.allocations.values()).map((v) => v.uid));
        for (let candidate = this.baseUid; candidate <= this.maxUid; candidate++) {
            if (!usedUids.has(candidate)) {
                return { uid: candidate, gid: candidate };
            }
        }
        throw new Error(`UID pool exhausted (range: ${this.baseUid}-${this.maxUid})`);
    }

    release(sandboxId: string): void {
        this.allocations.delete(sandboxId);
    }

    get(sandboxId: string): VmUidGid | undefined {
        return this.allocations.get(sandboxId);
    }
}
