import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface AccessAuditEvent {
    readonly id: string;
    readonly timestamp: string;
    readonly action: string;
    readonly outcome: "ALLOW" | "DENY";
    readonly userId: string | null;
    readonly resourceType: string | null;
    readonly resourceId: string | null;
    readonly reason: string;
    /**
     * D4：鉴权失败时被尝试密钥的 SHA-256 摘要（仅摘要，绝不存明文）。
     * 对无效密钥用户归属天然不可知（userId 为 NULL），
     * 摘要让爆破/重放尝试可以被关联分析。
     */
    readonly attemptedKeyDigest: string | null;
    /** §9.7 v1.3：前一行的 hash；链首为 GENESIS_HASH。 */
    readonly prevHash: string | null;
    /** §9.7 v1.3：本行内容的 SHA-256 链式摘要。 */
    readonly hash: string | null;
}

export interface ListAuditEventsOptions {
    /** 返回条数上限；未指定时默认 200，最大 500。 */
    limit?: number;
    /** 跳过条数（配合 limit 做分页）。 */
    offset?: number;
}

export interface AuditChainVerification {
    readonly ok: boolean;
    /** 参与校验的已 hash 行数。 */
    readonly checked: number;
    /** 跳过的 pre-chain 历史行数（旧库中 hash 为 NULL 的行）。 */
    readonly legacy: number;
    /** 校验失败时第一处断裂所在的行 id。 */
    readonly brokenAt?: string;
    /** 校验失败原因。 */
    readonly reason?: string;
}

const AUDIT_PAGE_DEFAULT_LIMIT = 200;
const AUDIT_PAGE_MAX_LIMIT = 500;

/** 链首的 prev_hash；用 64 个 0 保持与 sha256 十六进制长度一致。 */
export const GENESIS_HASH = "0".repeat(64);

type AuditChainRow = Omit<AccessAuditEvent, "prevHash" | "hash"> & {
    readonly prevHash: string | null;
    readonly hash: string | null;
};

export class AccessAuditStore {
    constructor(private readonly db: Database) {}

    record(
        input: Omit<AccessAuditEvent, "id" | "timestamp" | "attemptedKeyDigest" | "prevHash" | "hash">
            & { attemptedKeyDigest?: string | null },
    ): void {
        const id = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const attemptedKeyDigest = input.attemptedKeyDigest ?? null;
        const prevHash = this.lastHash();
        const hash = computeAuditHash(prevHash, {
            id,
            timestamp,
            ...input,
            attemptedKeyDigest,
        });
        this.db.query<unknown, {
            id: string; timestamp: string; action: string; outcome: "ALLOW" | "DENY";
            userId: string | null; resourceType: string | null;
            resourceId: string | null; reason: string;
            attemptedKeyDigest: string | null; prevHash: string; hash: string;
        }>(`
            INSERT INTO access_audit_events (
                id, timestamp, action, outcome, user_id,
                resource_type, resource_id, reason, attempted_key_digest,
                prev_hash, hash
            ) VALUES (
                $id, $timestamp, $action, $outcome, $userId,
                $resourceType, $resourceId, $reason, $attemptedKeyDigest,
                $prevHash, $hash
            );
        `).run({
            id,
            timestamp,
            ...input,
            attemptedKeyDigest,
            prevHash,
            hash,
        });
    }

    listForUser(
        userId: string,
        options: ListAuditEventsOptions = {},
    ): AccessAuditEvent[] {
        const limit = normalizePageLimit(options.limit);
        const offset = Math.max(0, Math.floor(options.offset ?? 0));
        return this.db.query<AccessAuditEvent, {
            userId: string; limit: number; offset: number;
        }>(`
            SELECT id, timestamp, action, outcome,
                user_id AS userId, resource_type AS resourceType,
                resource_id AS resourceId, reason,
                attempted_key_digest AS attemptedKeyDigest,
                prev_hash AS prevHash, hash AS hash
            FROM access_audit_events WHERE user_id = $userId
            ORDER BY timestamp ASC, rowid ASC
            LIMIT $limit OFFSET $offset;
        `).all({ userId, limit, offset });
    }

    /**
     * 重新计算并校验整条 hash 链。
     *
     * 旧库中 hash 为 NULL 的历史行会被当作 pre-chain legacy 行跳过；一旦
     * 链已经开始，再出现 NULL hash 行即视为断裂。校验失败时返回第一处
     * 断裂位置与原因，调用方可以 fail-closed 或告警。
     */
    verifyChain(): AuditChainVerification {
        const rows = this.db.query<AuditChainRow, []>(`
            SELECT id, timestamp, action, outcome,
                user_id AS userId, resource_type AS resourceType,
                resource_id AS resourceId, reason,
                attempted_key_digest AS attemptedKeyDigest,
                prev_hash AS prevHash, hash AS hash
            FROM access_audit_events
            ORDER BY rowid ASC;
        `).all();

        let prev = GENESIS_HASH;
        let checked = 0;
        let legacy = 0;
        for (const row of rows) {
            if (row.hash === null) {
                if (checked > 0 || prev !== GENESIS_HASH) {
                    return {
                        ok: false,
                        checked,
                        legacy,
                        brokenAt: row.id,
                        reason: "链开始后出现无 hash 的审计行",
                    };
                }
                legacy += 1;
                continue;
            }
            if (row.prevHash !== prev) {
                return {
                    ok: false,
                    checked,
                    legacy,
                    brokenAt: row.id,
                    reason: `prev_hash 不匹配：期望 ${prev}，实际 ${row.prevHash ?? "NULL"}`,
                };
            }
            const expected = computeAuditHash(prev, row);
            if (row.hash !== expected) {
                return {
                    ok: false,
                    checked,
                    legacy,
                    brokenAt: row.id,
                    reason: "hash 不匹配",
                };
            }
            prev = row.hash;
            checked += 1;
        }
        return { ok: true, checked, legacy };
    }

    private lastHash(): string {
        const row = this.db.query<{ hash: string | null }, []>(
            `SELECT hash FROM access_audit_events ORDER BY rowid DESC LIMIT 1`,
        ).get();
        return row?.hash ?? GENESIS_HASH;
    }
}

function computeAuditHash(
    prevHash: string,
    event: Omit<AccessAuditEvent, "prevHash" | "hash">,
): string {
    const payload = JSON.stringify([
        event.id,
        event.timestamp,
        event.action,
        event.outcome,
        event.userId,
        event.resourceType,
        event.resourceId,
        event.reason,
        event.attemptedKeyDigest,
    ]);
    return createHash("sha256").update(`${prevHash}\n${payload}`).digest("hex");
}

function normalizePageLimit(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) {
        return AUDIT_PAGE_DEFAULT_LIMIT;
    }
    return Math.min(AUDIT_PAGE_MAX_LIMIT, Math.max(1, Math.floor(raw)));
}
