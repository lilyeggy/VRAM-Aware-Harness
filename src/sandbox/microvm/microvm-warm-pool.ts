import type { MicrovmDriver, MicrovmInstance } from "./microvm-types.ts";

export type MicrovmResourceTier = "S" | "M" | "L";

export interface MicrovmTierSpec {
    readonly cpu: number;
    readonly memoryMb: number;
}

export const MICROVM_TIERS: Record<MicrovmResourceTier, MicrovmTierSpec> = {
    S: { cpu: 1, memoryMb: 256 },
    M: { cpu: 2, memoryMb: 512 },
    L: { cpu: 4, memoryMb: 2048 },
};

/** 把任意给定的 CPU / 内存需求映射到能够满足它的最小资源档位 */
export function mapResourceToTier(cpuCores = 2, memoryMb = 512): MicrovmResourceTier {
    if (cpuCores <= 1 && memoryMb <= 256) return "S";
    if (cpuCores <= 2 && memoryMb <= 512) return "M";
    return "L";
}

export interface WarmedMicrovm {
    readonly instance: MicrovmInstance;
    readonly tier: MicrovmResourceTier;
    readonly templateHash: string;
    readonly createdAt: number;
}

export interface MicrovmWarmPoolConfig {
    readonly ttlMs?: number; // 默认 300_000 (5 min)
    readonly maxPerTier?: number; // 默认 2
}

export class MicrovmWarmPool {
    private readonly pool = new Map<string, {
        vm: WarmedMicrovm;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private readonly ttlMs: number;
    private closed = false;

    constructor(
        private readonly driver: MicrovmDriver,
        config: MicrovmWarmPoolConfig = {},
    ) {
        this.ttlMs = config.ttlMs ?? 300_000;
    }

    private makePoolKey(templateHash: string, tier: MicrovmResourceTier): string {
        return `${templateHash}:${tier}`;
    }

    /** 从预热池中取出一台已就绪的 MicroVM。取出后从池中移除并取消 TTL 销毁定时器。 */
    take(templateHash: string, tier: MicrovmResourceTier): WarmedMicrovm | null {
        if (this.closed) return null;
        const key = this.makePoolKey(templateHash, tier);
        const entry = this.pool.get(key);
        if (!entry) return null;

        this.pool.delete(key);
        clearTimeout(entry.timer);
        return entry.vm;
    }

    /** 存入一台预热就绪的 MicroVM，设置 5 分钟 TTL 到期自动回收 */
    put(templateHash: string, tier: MicrovmResourceTier, instance: MicrovmInstance): void {
        if (this.closed) {
            this.driver.terminate(instance.id).catch(() => undefined);
            return;
        }

        const key = this.makePoolKey(templateHash, tier);
        const existing = this.pool.get(key);
        if (existing) {
            // 容量满，回收旧 VM
            clearTimeout(existing.timer);
            this.driver.terminate(existing.vm.instance.id).catch(() => undefined);
        }

        const timer = setTimeout(() => {
            this.expire(key, instance.id);
        }, this.ttlMs);

        this.pool.set(key, {
            vm: {
                instance,
                tier,
                templateHash,
                createdAt: Date.now(),
            },
            timer,
        });
    }

    private expire(key: string, vmId: string): void {
        const entry = this.pool.get(key);
        if (entry && entry.vm.instance.id === vmId) {
            this.pool.delete(key);
            this.driver.terminate(vmId).catch(() => undefined);
        }
    }

    size(): number {
        return this.pool.size;
    }

    has(templateHash: string, tier: MicrovmResourceTier): boolean {
        return this.pool.has(this.makePoolKey(templateHash, tier));
    }

    async close(): Promise<void> {
        this.closed = true;
        const promises: Promise<void>[] = [];
        for (const entry of this.pool.values()) {
            clearTimeout(entry.timer);
            promises.push(this.driver.terminate(entry.vm.instance.id).catch(() => undefined));
        }
        this.pool.clear();
        await Promise.all(promises);
    }
}
