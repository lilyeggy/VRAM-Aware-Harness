
import type { SandboxRecord } from "../sandbox-provider.ts";

/**
 * Broker 进程内的沙箱记录存储。
 *
 * 真正的审计记录在 Master 的 SQLite 里；Broker 侧只保留一份
 * "当前由我持有"的映射，用于 create 后回传 record 与 terminate 对账。
 */
export class InMemorySandboxStore {
    private readonly records = new Map<string, SandboxRecord>();

    create(record: SandboxRecord): void {
        this.records.set(record.id, record);
    }

    get(id: string): SandboxRecord | null {
        return this.records.get(id) ?? null;
    }

    update(record: SandboxRecord, _previousStatus?: string): void {
        this.records.set(record.id, record);
    }

    listUnsettled(): readonly SandboxRecord[] {
        return [];
    }
}
