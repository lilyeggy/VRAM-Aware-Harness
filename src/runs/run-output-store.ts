import type { Database } from "bun:sqlite";

export interface RunOutputChunk {
    readonly id: string; readonly runId: string; readonly sequence: number;
    readonly channel: "answer" | "thinking";
    readonly delta: string; readonly createdAt: string;
}

export class RunOutputStore {
    constructor(private readonly db: Database) {}
    append(runId: string, delta: string, channel: "answer" | "thinking" = "answer"): RunOutputChunk {
        // 单条语句完成序号分配 + 写入：消除 SELECT MAX 与 INSERT 之间的
        // 往返和竞态窗口（UNIQUE(run_id, sequence) 兜底），流式 delta 是
        // 高频写路径，每次省一次查询。
        const chunk = { id: crypto.randomUUID(), runId, channel, delta, createdAt: new Date().toISOString() };
        const row = this.db.query<{ sequence: number }, typeof chunk>(`
            INSERT INTO run_output_chunks (id, run_id, sequence, channel, delta, created_at)
            VALUES ($id, $runId,
                (SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_output_chunks WHERE run_id = $runId),
                $channel, $delta, $createdAt)
            RETURNING sequence;
        `).get(chunk);
        return { ...chunk, sequence: row?.sequence ?? 1 };
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
