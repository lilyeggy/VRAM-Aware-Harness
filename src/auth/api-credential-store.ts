import { createHash, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";

import type { RequestPrincipal } from "./request-principal.ts";

export interface ApiCredential {
    readonly id: string;
    readonly subjectId: string;
    readonly tenantId: string;
    readonly scopes: readonly string[];
    readonly createdAt: string;
    readonly revokedAt: string | null;
}

interface CredentialRow extends ApiCredential {
    keyDigest: string;
    scopesJson: string;
}

/** Credentials are tenant bindings, never a client-supplied tenant selector. */
export class ApiCredentialStore {
    constructor(private readonly db: Database) {}

    create(input: {
        rawKey: string;
        subjectId: string;
        tenantId: string;
        scopes: readonly string[];
    }): ApiCredential {
        if (input.rawKey.trim().length < 16) {
            throw new Error("API Key 至少需要 16 个字符");
        }
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.tenantId)) {
            throw new Error("tenantId 只能包含字母、数字、_ 或 -，且最长 64 位");
        }
        const credential: ApiCredential = {
            id: crypto.randomUUID(),
            subjectId: input.subjectId,
            tenantId: input.tenantId,
            scopes: Object.freeze([...new Set(input.scopes)]),
            createdAt: new Date().toISOString(),
            revokedAt: null,
        };
        this.db.query<unknown, {
            id: string; keyDigest: string; subjectId: string; tenantId: string;
            scopesJson: string; createdAt: string;
        }>(`
            INSERT INTO api_credentials (
                id, key_digest, subject_id, tenant_id, scopes_json, created_at, revoked_at
            ) VALUES ($id, $keyDigest, $subjectId, $tenantId, $scopesJson, $createdAt, NULL);
        `).run({
            ...credential,
            keyDigest: digest(input.rawKey),
            scopesJson: JSON.stringify(credential.scopes),
        });
        return credential;
    }

    authenticate(rawKey: string): RequestPrincipal | null {
        const row = this.db.query<CredentialRow, { keyDigest: string }>(`
            SELECT id, key_digest AS keyDigest, subject_id AS subjectId,
                tenant_id AS tenantId, scopes_json AS scopesJson,
                created_at AS createdAt, revoked_at AS revokedAt
            FROM api_credentials
            WHERE key_digest = $keyDigest AND revoked_at IS NULL;
        `).get({ keyDigest: digest(rawKey) });
        if (row === null) return null;

        // Keep a constant-time comparison even though the indexed digest already matched.
        if (!timingSafeEqual(Buffer.from(row.keyDigest), Buffer.from(digest(rawKey)))) {
            return null;
        }
        return Object.freeze({
            subjectId: row.subjectId,
            tenantId: row.tenantId,
            scopes: Object.freeze(JSON.parse(row.scopesJson) as string[]),
        });
    }

    revoke(id: string): void {
        this.db.query<unknown, { id: string; revokedAt: string }>(`
            UPDATE api_credentials SET revoked_at = $revokedAt
            WHERE id = $id AND revoked_at IS NULL;
        `).run({ id, revokedAt: new Date().toISOString() });
    }
}

export function digest(rawKey: string): string {
    return createHash("sha256").update(rawKey).digest("hex");
}
