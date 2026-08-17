import type { Database } from "bun:sqlite";

export interface RunOutputChunk {
    readonly id: string; readonly runId: string; readonly sequence: number;
    readonly delta: string; readonly createdAt: string;
}

export class RunOutputStore {
    constructor(private readonly db: Database) {}
    append(runId: string, delta: string): RunOutputChunk {
        const row = this.db.query<{ sequence: number }, { runId: string }>(`
            SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_output_chunks WHERE run_id = $runId;
        `).get({ runId });
        const chunk: RunOutputChunk = { id: crypto.randomUUID(), runId, sequence: row?.sequence ?? 1, delta, createdAt: new Date().toISOString() };
        this.db.query<unknown, { id: string; runId: string; sequence: number; delta: string; createdAt: string }>(`
            INSERT INTO run_output_chunks (id, run_id, sequence, delta, created_at)
            VALUES ($id, $runId, $sequence, $delta, $createdAt);
        `).run(chunk);
        return chunk;
    }
    list(runId: string): RunOutputChunk[] {
        return this.db.query<RunOutputChunk, { runId: string }>(`
            SELECT id, run_id AS runId, sequence, delta, created_at AS createdAt
            FROM run_output_chunks WHERE run_id = $runId ORDER BY sequence ASC;
        `).all({ runId });
    }
    finalText(runId: string): string { return this.list(runId).map((item) => item.delta).join(""); }
}
