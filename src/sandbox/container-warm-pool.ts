import type { ContainerCommandRuntime } from './container-runtime-adapter.ts';

/** Single-use, workspace-scoped containers. A leased container is never returned. */
export class ContainerWarmPool {
    private readonly entries = new Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>();
    private readonly pending = new Map<string, Promise<void>>();
    private closed = false;
    private initialized: Promise<void> | undefined;
    constructor(
        private readonly commands: ContainerCommandRuntime,
        private readonly docker: string,
        private readonly capacity: number,
        private readonly ttlMs = 60_000,
        private readonly owner = 'default',
    ) {
        if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid warm pool capacity');
    }

    async take(key: string, target: string): Promise<boolean> {
        await this.initialize();
        if (this.closed) throw new Error('Warm pool is closed');
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
        if (this.entries.has(key)) return Promise.resolve();
        const existing = this.pending.get(key);
        if (existing) return existing;
        if (this.entries.size + this.pending.size >= this.capacity) return Promise.resolve();
        const task = this.create(key, args).finally(() => this.pending.delete(key));
        this.pending.set(key, task);
        return task;
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
        for (const entry of entries) {
            clearTimeout(entry.timer);
            await this.remove(entry.name);
        }
    }

    private initialize(): Promise<void> {
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
