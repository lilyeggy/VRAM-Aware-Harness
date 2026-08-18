/**
 * Resource ledger — the chargeback brain behind multi-tenant resource control.
 *
 * Every running attempt *commits* units up front and *settles* on exit. This
 * gives two things the old concurrency counter could not:
 *   - `activeUnits(tenantId)`: how much this tenant is *currently* consuming
 *     (drives fair-share / budget admission);
 *   - settled totals per tenant: an auditable chargeback history ("who used how
 *     much, when, and what happened to it").
 *
 * In-memory by design so the model is trivially testable; persistence is an
 * opt-in store that implements the same interface.
 */
export type LedgerStatus = "RESERVED" | "SETTLED";

export type SettleReason =
    | "COMPLETED"
    | "FAILED"
    | "LOST"
    | "TERMINATED"
    | "INTERRUPTED";

export interface ResourceLedgerEntry {
    readonly entryId: string;
    readonly runId: string;
    readonly tenantId: string;
    readonly units: number;
    readonly status: LedgerStatus;
    readonly reservedAt: string;
    readonly settledAt: string | null;
    readonly settledReason: SettleReason | null;
}

export interface ResourceLedger {
    commit(input: { runId: string; tenantId: string; units?: number }): ResourceLedgerEntry;
    settle(input: { runId: string; reason: SettleReason; units?: number }): ResourceLedgerEntry | null;
    get(runId: string): ResourceLedgerEntry | null;
    activeUnits(tenantId: string): number;
    activeEntries(): readonly ResourceLedgerEntry[];
    /** Total units ever settled for a tenant (chargeback) — or null if never recorded. */
    settledTotalUnits(tenantId: string): number | null;
}

export class MemoryResourceLedger implements ResourceLedger {
    private readonly entries = new Map<string, ResourceLedgerEntry>();

    commit(input: { runId: string; tenantId: string; units?: number }): ResourceLedgerEntry {
        if (this.entries.has(input.runId)) {
            throw new Error(`Run 已在账本中：${input.runId}`);
        }
        const units = input.units ?? 1;
        if (!Number.isFinite(units) || units <= 0) {
            throw new Error("账本单位必须为正数");
        }
        const entry: ResourceLedgerEntry = Object.freeze({
            entryId: crypto.randomUUID(),
            runId: input.runId,
            tenantId: input.tenantId,
            units,
            status: "RESERVED",
            reservedAt: new Date().toISOString(),
            settledAt: null,
            settledReason: null,
        });
        this.entries.set(input.runId, entry);
        return entry;
    }

    settle(input: { runId: string; reason: SettleReason; units?: number }): ResourceLedgerEntry | null {
        const current = this.entries.get(input.runId);
        if (current === undefined) {
            return null;
        }
        const settled: ResourceLedgerEntry = Object.freeze({
            ...current,
            units: input.units ?? current.units,
            status: "SETTLED",
            settledAt: new Date().toISOString(),
            settledReason: input.reason,
        });
        this.entries.set(input.runId, settled);
        return settled;
    }

    get(runId: string): ResourceLedgerEntry | null {
        return this.entries.get(runId) ?? null;
    }

    activeUnits(tenantId: string): number {
        let units = 0;
        for (const entry of this.entries.values()) {
            if (entry.tenantId === tenantId && entry.status === "RESERVED") {
                units += entry.units;
            }
        }
        return units;
    }

    activeEntries(): readonly ResourceLedgerEntry[] {
        return [...this.entries.values()].filter((e) => e.status === "RESERVED");
    }

    settledTotalUnits(tenantId: string): number | null {
        const rows = [...this.entries.values()].filter(
            (e) => e.tenantId === tenantId && e.status === "SETTLED",
        );
        if (rows.length === 0) {
            return null;
        }
        return rows.reduce((sum, e) => sum + e.units, 0);
    }
}
