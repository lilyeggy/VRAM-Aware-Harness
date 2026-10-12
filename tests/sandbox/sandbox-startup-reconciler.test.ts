import { describe, expect, test } from "bun:test";
import { SandboxStartupReconciler } from "../../src/sandbox/sandbox-startup-reconciler.ts";
import type { RunAttemptStore } from "../../src/runs/run-attempt-store.ts";
import type {
    SandboxProvider,
    SandboxRecord,
    SandboxStatus,
} from "../../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../../src/sandbox/sandbox-store.ts";

function createRecord(status: SandboxStatus, id: string): SandboxRecord {
    return {
        id,
        runId: "run-1",
        policySnapshotId: "snapshot-1",
        provider: "microvm",
        profile: "strict",
        runtime: "firecracker",
        status,
        workspacePath: "/tmp/workspace",
        secretNames: [],
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
        failureReason: null,
    } as unknown as SandboxRecord;
}

/**
 * 复刻 SandboxStore 的乐观锁语义：previousStatus 与当前状态不一致就抛
 * “Sandbox 状态已变化：<id>”（src/sandbox/sandbox-store.ts:72-74）。
 */
class FakeSandboxStore {
    readonly records = new Map<string, SandboxRecord>();

    constructor(record: SandboxRecord) {
        this.records.set(record.id, record);
    }

    listUnsettled(): SandboxRecord[] {
        return [...this.records.values()].filter((record) => (
            record.status === "PROVISIONING" || record.status === "ACTIVE"
        ));
    }

    get(id: string): SandboxRecord | null {
        return this.records.get(id) ?? null;
    }

    update(record: SandboxRecord, previousStatus: SandboxStatus): void {
        const current = this.records.get(record.id);
        const matches = current === undefined ? false : current.status === previousStatus;
        if (matches) {
            this.records.set(record.id, record);
            return;
        }
        throw new Error(`Sandbox 状态已变化：${record.id}`);
    }
}

class FakeProvider {
    constructor(
        private readonly store: FakeSandboxStore,
        private readonly convergeTo: SandboxStatus | null,
        private readonly failure: string | null,
    ) {}

    async cleanupStale(record: SandboxRecord): Promise<void> {
        const target = this.convergeTo;
        if (target) {
            // 真机上 MicrovmSandboxProvider.cleanupStale → terminate 会先写终态。
            const current = this.store.get(record.id);
            if (current) {
                this.store.update(
                    { ...current, status: target },
                    current.status,
                );
            } else {
                throw new Error("record missing");
            }
        }
        if (this.failure) {
            throw new Error(this.failure);
        }
    }
}

const noAttempts = {
    getBySandboxId: () => null,
} as unknown as RunAttemptStore;

function createReconciler(
    store: FakeSandboxStore,
    provider: FakeProvider,
): SandboxStartupReconciler {
    return new SandboxStartupReconciler(
        store as unknown as SandboxStore,
        provider as unknown as SandboxProvider,
        noAttempts,
    );
}

describe("SandboxStartupReconciler 启动对账的乐观锁容错", () => {
    test("清理期间记录已被 Provider 收敛为 TERMINATED 时不抛错，也不覆盖终态", async () => {
        const record = createRecord("ACTIVE", "sandbox-converged");
        const store = new FakeSandboxStore(record);
        const reconciler = createReconciler(
            store,
            new FakeProvider(store, "TERMINATED", null),
        );

        await reconciler.reconcile();

        expect(store.get(record.id)?.status).toBe("TERMINATED");
    });

    test("清理失败且期间状态已收敛时，只报原始清理失败，不报记账失败", async () => {
        const record = createRecord("ACTIVE", "sandbox-cleanup-failed");
        const store = new FakeSandboxStore(record);
        const reconciler = createReconciler(
            store,
            new FakeProvider(store, "LOST", "导出工作区磁盘失败"),
        );

        let message = "";
        try {
            await reconciler.reconcile();
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toContain("Sandbox 启动对账失败，拒绝启动");
        expect(message).toContain("导出工作区磁盘失败");
        expect(message.includes("记账失败")).toBe(false);
    });

    test("正常路径把遗留 ACTIVE 记录标记为 LOST", async () => {
        const record = createRecord("ACTIVE", "sandbox-lost");
        const store = new FakeSandboxStore(record);
        const reconciler = createReconciler(
            store,
            new FakeProvider(store, null, null),
        );

        await reconciler.reconcile();

        const updated = store.get(record.id);
        expect(updated?.status).toBe("LOST");
        expect(updated?.failureReason).toBe("PROCESS_RESTART:遗留执行环境已回收");
    });
});
