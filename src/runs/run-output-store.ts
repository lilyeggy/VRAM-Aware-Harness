import type { Database } from "bun:sqlite";

export interface RunOutputChunk {
    readonly id: string; readonly runId: string; readonly sequence: number;
    readonly channel: "answer" | "thinking";
    readonly delta: string; readonly createdAt: string;
}

export class RunOutputStore {
    constructor(private readonly db: Database) {}
    append(runId: string, delta: string, channel: "answer" | "thinking" = "answer"): RunOutputChunk {
        const row = this.db.query<{ sequence: number }, { runId: string }>(`
            SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_output_chunks WHERE run_id = $runId;
        `).get({ runId });
        const chunk: RunOutputChunk = { id: crypto.randomUUID(), runId, sequence: row?.sequence ?? 1, channel, delta, createdAt: new Date().toISOString() };
        this.db.query<unknown, { id: string; runId: string; sequence: number; channel: string; delta: string; createdAt: string }>(`
            INSERT INTO run_output_chunks (id, run_id, sequence, channel, delta, created_at)
            VALUES ($id, $runId, $sequence, $channel, $delta, $createdAt);
        `).run(chunk);
        return chunk;
    }
    list(runId: string): RunOutputChunk[] {
        return this.db.query<RunOutputChunk, { runId: string }>(`
            SELECT id, run_id AS runId, sequence, channel, delta, created_at AS createdAt
            FROM run_output_chunks WHERE run_id = $runId ORDER BY sequence ASC;
        `).all({ runId });
    }
    finalText(runId: string): string { return this.list(runId).filter((item) => item.channel === "answer").map((item) => item.delta).join(""); }
    finalThinking(runId: string): string { return this.list(runId).filter((item) => item.channel === "thinking").map((item) => item.delta).join(""); }
}
