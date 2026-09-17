import type { ContainerCommandRuntime } from './container-runtime-adapter.ts';

const MAX_OWNER_LENGTH = 120;

/**
 * 由**部署身份**导出预热池的 owner 标签值。
 *
 * owner 的用途只有一条：启动清场时"只删属于本部署的遗留预热容器，不碰同机其它实例的"。
 * 它必须**跨进程重启保持稳定**，否则清场等于没做。
 *
 * N29：原先传的是 `port-<HTTP 端口>`——端口是可变配置，改端口重启（或实例迁目录）
 * 之后 owner 就变了，上一个进程留下的预热容器再也匹配不上、永远不会被清理。
 * 而预热容器**不写 `sandboxes` 表**（它是 `ContainerWarmPool` 直接 `docker run` 出来的），
 * 所以启动对账屏障也扫不到它们，最终成为永久孤儿。
 *
 * 用数据库路径做身份是合适的：同一个库不可能被两个 harness 实例同时使用，
 * 因此它既能稳定标识"本部署"，又能把同机其它实例的预热容器隔开（不会误删别人在用的）。
 * 路径含 `/` 等字符不适合直接当标签值，这里做确定性净化。
 */
export function deriveWarmPoolOwner(deploymentIdentity: string): string {
    const sanitized = deploymentIdentity
        .trim()
        .replace(/[^A-Za-z0-9_.-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
    if (sanitized.length === 0) return 'default';
    if (sanitized.length <= MAX_OWNER_LENGTH) return sanitized;
    // 超长路径截断后可能撞车，附一个确定性短哈希保证仍可分辨。
    return `${sanitized.slice(0, MAX_OWNER_LENGTH - 9)}-${fnv1aHex(sanitized)}`;
}

function fnv1aHex(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** Single-use, workspace-scoped containers. A leased container is never returned. */
export class ContainerWarmPool {
    private readonly entries = new Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>();
    private readonly pending = new Map<string, Promise<void>>();
    /**
     * 每个 key 连续"补充出来却没人取"的次数。低频负载下被动补充是净亏损：
     * 每次 Run 结束都白付一次容器创建，TTL 一到就删。达到阈值即停止自动补充，
     * 直到该 key 再次出现真实取用请求（说明需求回来了）才清零。
     */
    private readonly wasteStreaks = new Map<string, number>();
    private closed = false;
    private initialized: Promise<void> | undefined;
    constructor(
        private readonly commands: ContainerCommandRuntime,
        private readonly docker: string,
        private readonly capacity: number,
        private readonly ttlMs = 300_000,
        private readonly owner = 'default',
        private readonly maxWasteStreak = 3,
    ) {
        if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid warm pool capacity');
        if (!Number.isInteger(maxWasteStreak) || maxWasteStreak < 1) {
            throw new Error('Invalid warm pool waste threshold');
        }
    }

    async take(key: string, target: string): Promise<boolean> {
        await this.initialize();
        if (this.closed) throw new Error('Warm pool is closed');
        // 取用请求本身就是需求证据：无论这次有没有货，都清掉止损计数，
        // 让随后的补充重新被允许。否则一次误判会让该 key 永久停供。
        this.wasteStreaks.delete(key);
        const entry = this.entries.get(key);
        if (!entry) return false;
        // Claim synchronously before any I/O so two Runs cannot share a resource.
        this.entries.delete(key);
        clearTimeout(entry.timer);
        const running = await this.commands.run([this.docker, 'inspect', '--format', '{{.State.Running}}', entry.name]);
        if (running.exitCode !== 0 || running.stdout.trim() !== 'true') {
            await this.remove(entry.name);
            return false;
        }
        const rename = await this.commands.run([this.docker, 'rename', entry.name, target]);
        if (rename.exitCode !== 0) {
            await this.remove(entry.name);
            throw new Error('Warm container lease rename failed');
        }
        return true;
    }

    warm(key: string, args: readonly string[]): Promise<void> {
        if (this.closed) return Promise.resolve();
        // 止损：该 key 连续多次补充都没人取，就不要再补，别把低频负载变成双倍创建。
        if ((this.wasteStreaks.get(key) ?? 0) >= this.maxWasteStreak) return Promise.resolve();
        if (this.entries.has(key)) return Promise.resolve();
        const existing = this.pending.get(key);
        if (existing) return existing;
        // 容量管理：腾位置，而不是放弃补货。
        // 原实现是 `size >= capacity 就 return`，于是少数"再也用不到"的旧 key 会永久
        // 占位——真机观察到池里两个旧工作区的容器把全局容量占满，新工作区的补货被
        // 直接挡掉、命中率恒为零。
        if (!this.makeRoom()) return Promise.resolve();
        const task = this.create(key, args).finally(() => this.pending.delete(key));
        this.pending.set(key, task);
        return task;
    }

    /**
     * 为新容器腾出空间：按插入顺序淘汰最旧的备用容器，直到
     * `entries + pending + 1 <= capacity`。
     *
     * 返回 false 表示容量全被**在途创建**占用、已经腾不出位置——此时放弃这次补货，
     * 而不是让备用容器总数超出 capacity。
     * 淘汰属于容量管理、不是需求判断，因此不计入 wasteStreak。
     */
    private makeRoom(): boolean {
        while (this.entries.size + this.pending.size + 1 > this.capacity) {
            const oldest = this.entries.keys().next();
            if (oldest.done === true) return false;
            const entry = this.entries.get(oldest.value);
            if (entry === undefined) return false;
            this.entries.delete(oldest.value);
            clearTimeout(entry.timer);
            void this.remove(entry.name).catch(error =>
                console.error('Warm container eviction failed', error));
        }
        return true;
    }

    private async create(key: string, args: readonly string[]): Promise<void> {
        await this.initialize();
        const name = `agent-harness-warm-${crypto.randomUUID()}`;
        const command = [...args];
        const index = command.indexOf('--name');
        if (index < 0) throw new Error('Missing container name');
        command[index + 1] = name;
        command.splice(1, 0, '--label', `agent-harness.warm-owner=${this.owner}`);
        const result = await this.commands.run([this.docker, ...command]);
        if (result.exitCode !== 0) {
            await this.remove(name);
            throw new Error('Warm container creation failed');
        }
        const timer = setTimeout(() => {
            this.entries.delete(key);
            this.wasteStreaks.set(key, (this.wasteStreaks.get(key) ?? 0) + 1);
            void this.remove(name).catch(error => console.error('Warm container cleanup failed', error));
        }, this.ttlMs);
        timer.unref();
        this.entries.set(key, { name, timer });
    }

    private async remove(name: string): Promise<void> {
        const result = await this.commands.run([this.docker, 'rm', '--force', name]);
        if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
            throw new Error(`Warm container cleanup failed: ${name}`);
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        await Promise.allSettled(this.pending.values());
        const entries = [...this.entries.values()];
        this.entries.clear();
        this.wasteStreaks.clear();
        for (const entry of entries) {
            clearTimeout(entry.timer);
            await this.remove(entry.name);
        }
    }

    /**
     * 启动清场：删掉带本部署 owner 标签的遗留预热容器（上个进程留下的）。
     *
     * 幂等且只跑一次——重复调用返回同一个 promise，所以既可以在 Provider 构造期
     * 主动发起，也可以继续由 `take()`/`warm()` 惰性触发。
     *
     * N29：清理比重的判断只认 owner 标签，所以 owner 必须跨重启稳定（见
     * `deriveWarmPoolOwner`）。命名契约只认 `agent-harness-warm-<十六进制>`，
     * 遇到不符合规范的**直接抛错而不是顺手删掉**：改过名的容器归另一条路径
     * （启动对账）管，命名本身就是职责边界。
     */
    initialize(): Promise<void> {
        return this.initialized ??= (async () => {
            const result = await this.commands.run([this.docker, 'ps', '-a', '--filter', `label=agent-harness.warm-owner=${this.owner}`, '--format', '{{.Names}}']);
            if (result.exitCode !== 0) throw new Error('Cannot reconcile warm containers');
            for (const name of result.stdout.trim().split('\n').filter(Boolean)) {
                if (!/^agent-harness-warm-[a-f0-9-]+$/.test(name)) throw new Error('Unexpected warm container name');
                await this.remove(name);
            }
        })();
    }
}
