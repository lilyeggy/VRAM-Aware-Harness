export class VmCidAllocator {
    private readonly allocations = new Map<string, number>();

    /** base 默认 3，上限 40000。0-2 保留给 hypervisor/local/host。 */
    constructor(
        private readonly baseCid = 3,
        private readonly maxCid = 40000,
    ) {
        if (baseCid < 3) {
            throw new Error(`baseCid must be >= 3, got ${baseCid}`);
        }
        if (maxCid < baseCid) {
            throw new Error(`maxCid (${maxCid}) must be >= baseCid (${baseCid})`);
        }
    }

    allocate(sandboxIdOrActiveIds: string | readonly string[]): number {
        if (typeof sandboxIdOrActiveIds === "string") {
            const sandboxId = sandboxIdOrActiveIds;
            const existing = this.allocations.get(sandboxId);
            if (existing !== undefined) {
                return existing;
            }

            const usedCids = new Set(Array.from(this.allocations.values()));
            for (let candidate = this.baseCid; candidate <= this.maxCid; candidate++) {
                if (!usedCids.has(candidate)) {
                    this.allocations.set(sandboxId, candidate);
                    return candidate;
                }
            }
            throw new Error(`CID pool exhausted (range: ${this.baseCid}-${this.maxCid})`);
        }

        const activeIds = sandboxIdOrActiveIds;
        const activeSet = new Set(activeIds);
        for (const [id] of this.allocations.entries()) {
            if (!activeSet.has(id)) {
                this.allocations.delete(id);
            }
        }
        const usedCids = new Set(Array.from(this.allocations.values()));
        for (let candidate = this.baseCid; candidate <= this.maxCid; candidate++) {
            if (!usedCids.has(candidate)) {
                return candidate;
            }
        }
        throw new Error(`CID pool exhausted (range: ${this.baseCid}-${this.maxCid})`);
    }

    release(sandboxId: string): void {
        this.allocations.delete(sandboxId);
    }

    get(sandboxId: string): number | undefined {
        return this.allocations.get(sandboxId);
    }
}
