import type { EffectivePolicySnapshot } from "../policies/effective-policy.ts";
import type {
    SandboxCommandExecutor,
    SandboxHandle,
    SandboxLifecycleEvent,
    SandboxProvider,
} from "./sandbox-provider.ts";
import type { SandboxProfile } from "./sandbox-profile.ts";

export type RoutedSandboxProvider = SandboxProvider & Partial<SandboxCommandExecutor>;

/**
 * Routes an immutable profile to a concrete Provider. The strict slot is an
 * explicit extension point for Kata/Firecracker/managed microVM; its default
 * implementation fails closed instead of pretending runc is strict.
 */
export class SandboxProviderRouter implements SandboxProvider, SandboxCommandExecutor {
    private readonly owners = new Map<string, RoutedSandboxProvider>();
    private readonly handlers = new Set<(event: SandboxLifecycleEvent) => void>();
    private readonly unsubscribers: Array<() => void> = [];

    constructor(
        private readonly providers: Partial<Record<SandboxProfile, RoutedSandboxProvider>>,
        private readonly defaultProfile: SandboxProfile,
    ) {
        const unique = new Set(Object.values(providers));
        for (const provider of unique) {
            if (provider === undefined) continue;
            this.unsubscribers.push(provider.subscribe((event) => {
                for (const handler of this.handlers) handler(event);
            }));
        }
    }

    async create(input: {
        id: string;
        runId: string;
        instanceId: string;
        workspacePath: string;
        policy: EffectivePolicySnapshot;
    }): Promise<SandboxHandle> {
        const profile = input.policy.sandboxProfile ?? this.defaultProfile;
        const provider = this.providers[profile];
        if (provider === undefined) {
            throw new Error(`没有可用的 Sandbox Provider：${profile}；拒绝降级`);
        }
        const handle = await provider.create(input);
        this.owners.set(handle.id, provider);
        return handle;
    }

    async execute(sandboxId: string, command: readonly string[]) {
        const provider = this.owners.get(sandboxId);
        if (provider?.execute === undefined) {
            throw new Error(`Sandbox 没有可用的命令执行边界：${sandboxId}`);
        }
        return provider.execute(sandboxId, command);
    }

    async terminate(sandboxId: string): Promise<void> {
        const provider = this.owners.get(sandboxId);
        if (provider !== undefined) {
            this.owners.delete(sandboxId);
            await provider.terminate(sandboxId);
            return;
        }
        for (const candidate of new Set(Object.values(this.providers))) {
            if (candidate !== undefined) await candidate.terminate(sandboxId);
        }
    }

    async cleanupStale(record: import("./sandbox-provider.ts").SandboxRecord): Promise<void> {
        const provider = this.providers[record.profile];
        if (provider?.cleanupStale === undefined) {
            throw new Error(`Sandbox Provider 不支持启动清理：${record.profile}`);
        }
        await provider.cleanupStale(record);
        this.owners.delete(record.id);
    }

    subscribe(handler: (event: SandboxLifecycleEvent) => void): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    close(): void {
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers.length = 0;
        this.handlers.clear();
        this.owners.clear();
    }
}

export class UnavailableStrictSandboxProvider implements SandboxProvider {
    async create(_input: Parameters<SandboxProvider["create"]>[0]): Promise<SandboxHandle> {
        throw new Error(
            "strict Sandbox Provider 尚未接入；请配置 Kata、Firecracker 或托管 microVM Provider",
        );
    }

    async terminate(_sandboxId: string): Promise<void> {}

    subscribe(_handler: (event: SandboxLifecycleEvent) => void): () => void {
        return () => undefined;
    }
}
