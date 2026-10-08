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

/**
 * 把任意给定的 CPU / 内存需求映射到能够满足它的最小资源档位。
 *
 * 返回 `null` 表示需求**超出**最高档位（L）。
 * 【硬约束】绝不能把超出 L 的需求向上取整到 L——那会让预热 VM 的实际资源
 * 低于策略声明的限额（例如策略申请 8c/8GiB 却拿到 4c/2GiB），
 * 既是配额语义错误也是资源保证的欺骗。调用方收到 `null` 时必须回退到
 * 按策略精确创建的冷启动路径。
 */
export function mapResourceToTier(
    cpuCores = 2,
    memoryMb = 512,
): MicrovmResourceTier | null {
    if (cpuCores <= 1 && memoryMb <= 256) return "S";
    if (cpuCores <= 2 && memoryMb <= 512) return "M";
    if (cpuCores <= 4 && memoryMb <= 2048) return "L";
    return null;
}

export interface WarmedMicrovm {
    readonly instance: MicrovmInstance;
    readonly tier: MicrovmResourceTier;
    readonly templateHash: string;
    readonly createdAt: number;
}

export interface MicrovmWarmPoolConfig {
    readonly ttlMs?: number; // 默认 300_000 (5 min)
    /**
     * 每个 (模板指纹, 资源档位) 最多保留几台待命 VM。默认 1。
     * 这是池真实容量：`put()` 超出后回收最旧的一台，`take()` 后由
     * Provider 按同一上限补货。
     */
    readonly maxPerTier?: number;
}

interface WarmedEntry {
    readonly vm: WarmedMicrovm;
    readonly timer: ReturnType<typeof setTimeout>;
}

export class MicrovmWarmPool {
    /** key = `${templateHash}:${tier}` → 该组合下按入池顺序排列的待命 VM。 */
    private readonly pool = new Map<string, WarmedEntry[]>();
    private readonly ttlMs: number;
    /** 每个 (模板, 档位) 的待命上限；`put`/Provider 补货共用同一事实来源。 */
    readonly maxPerTier: number;
    private closed = false;

    constructor(
        private readonly driver: MicrovmDriver,
        config: MicrovmWarmPoolConfig = {},
    ) {
        this.ttlMs = config.ttlMs ?? 300_000;
        const maxPerTier = config.maxPerTier ?? 1;
        if (!Number.isInteger(maxPerTier) || maxPerTier < 1) {
            throw new Error(`maxPerTier must be a positive integer, got ${maxPerTier}`);
        }
        this.maxPerTier = maxPerTier;
    }

    private makePoolKey(templateHash: string, tier: MicrovmResourceTier): string {
        return `${templateHash}:${tier}`;
    }

    /** 从预热池中取出一台已就绪的 MicroVM。取出后从池中移除并取消 TTL 销毁定时器。 */
    take(templateHash: string, tier: MicrovmResourceTier): WarmedMicrovm | null {
        if (this.closed) return null;
        const key = this.makePoolKey(templateHash, tier);
        const entries = this.pool.get(key);
        if (!entries || entries.length === 0) {
            return null;
        }

        const entry = entries.shift();
        if (!entry) return null;
        clearTimeout(entry.timer);
        if (entries.length === 0) {
            this.pool.delete(key);
        }
        return entry.vm;
    }

    /**
     * 存入一台预热就绪的 MicroVM，设置 TTL 到期自动回收。
     * 超出 `maxPerTier` 时回收该组合下**最旧**的一台，保证池内数量不超过上限
     * （此前实现遇到同名 key 直接替换，导致配置的容量被彻底忽略）。
     */
    put(templateHash: string, tier: MicrovmResourceTier, instance: MicrovmInstance): void {
        if (this.closed) {
            this.driver.terminate(instance.id).catch(() => undefined);
            return;
        }

        const key = this.makePoolKey(templateHash, tier);
        const entries = this.pool.get(key) ?? [];

        while (entries.length >= this.maxPerTier) {
            const evicted = entries.shift();
            if (!evicted) break;
            clearTimeout(evicted.timer);
            this.driver.terminate(evicted.vm.instance.id).catch(() => undefined);
        }

        const timer = setTimeout(() => {
            this.expire(key, instance.id);
        }, this.ttlMs);

        entries.push({
            vm: {
                instance,
                tier,
                templateHash,
                createdAt: Date.now(),
            },
            timer,
        });
        this.pool.set(key, entries);
    }

    private expire(key: string, vmId: string): void {
        const entries = this.pool.get(key);
        if (!entries) return;

        const index = entries.findIndex((e) => e.vm.instance.id === vmId);
        if (index === -1) return;

        const [entry] = entries.splice(index, 1);
        if (entry) clearTimeout(entry.timer);
        if (entries.length === 0) {
            this.pool.delete(key);
        }
        this.driver.terminate(vmId).catch(() => undefined);
    }

    /** 当前池内待命 VM 总数（跨全部模板与档位）。 */
    size(): number {
        let total = 0;
        for (const entries of this.pool.values()) {
            total += entries.length;
        }
        return total;
    }

    /** 指定 (模板, 档位) 的待命数量；Provider 据此决定是否需要补货。 */
    count(templateHash: string, tier: MicrovmResourceTier): number {
        return this.pool.get(this.makePoolKey(templateHash, tier))?.length ?? 0;
    }

    has(templateHash: string, tier: MicrovmResourceTier): boolean {
        return this.count(templateHash, tier) > 0;
    }

    async close(): Promise<void> {
        this.closed = true;
        const promises: Promise<void>[] = [];
        for (const entries of this.pool.values()) {
            for (const entry of entries) {
                clearTimeout(entry.timer);
                promises.push(this.driver.terminate(entry.vm.instance.id).catch(() => undefined));
            }
        }
        this.pool.clear();
        await Promise.all(promises);
    }
}
