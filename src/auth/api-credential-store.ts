import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";

import type { RequestPrincipal } from "./request-principal.ts";

export interface ApiCredential {
    readonly id: string;
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
            tenantId: input.tenantId,
            scopes: Object.freeze([...new Set(input.scopes)]),
            createdAt: new Date().toISOString(),
            revokedAt: null,
        };
        this.db.query<unknown, {
            id: string; keyDigest: string; tenantId: string;
            scopesJson: string; createdAt: string;
        }>(`
            INSERT INTO api_credentials (
                id, key_digest, tenant_id, scopes_json, created_at, revoked_at
            ) VALUES ($id, $keyDigest, $tenantId, $scopesJson, $createdAt, NULL);
        `).run({
            ...credential,
            keyDigest: digest(input.rawKey),
            scopesJson: JSON.stringify(credential.scopes),
        });
        return credential;
    }

    authenticate(rawKey: string): RequestPrincipal | null {
        const session = this.authenticateSession(rawKey);
        if (session !== null) return session;
        const row = this.db.query<CredentialRow, { keyDigest: string }>(`
            SELECT id, key_digest AS keyDigest,
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
            tenantId: row.tenantId,
            scopes: Object.freeze(JSON.parse(row.scopesJson) as string[]),
        });
    }

    registerUser(email: string, password: string): { userId: string; tenantId: string } {
        const normalized = email.trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(normalized)) throw new Error("邮箱格式无效");
        if (password.length < 8) throw new Error("密码至少需要 8 个字符");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const hash = passwordHash(password);
        this.db.query(`INSERT INTO users (id, email, password_hash, created_at) VALUES ($id, $email, $hash, $createdAt)`)
            .run({ id, email: normalized, hash, createdAt: now });
        return { userId: id, tenantId: id };
    }

    loginUser(email: string, password: string): { token: string; userId: string; tenantId: string; expiresAt: string } | null {
        const row = this.db.query<{ id: string; passwordHash: string }, { email: string }>(
            `SELECT id, password_hash AS passwordHash FROM users WHERE email = $email`,
        ).get({ email: email.trim().toLowerCase() });
        if (row === null || !verifyPassword(password, row.passwordHash)) return null;
        const token = randomBytes(32).toString("base64url");
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        this.db.query(`INSERT INTO user_sessions (id, user_id, token_digest, created_at, expires_at, revoked_at) VALUES ($id, $userId, $digest, $createdAt, $expiresAt, NULL)`)
            .run({ id: crypto.randomUUID(), userId: row.id, digest: digest(token), createdAt: now.toISOString(), expiresAt });
        return { token, userId: row.id, tenantId: row.id, expiresAt };
    }

    revokeSession(rawToken: string): void {
        this.db.query(`UPDATE user_sessions SET revoked_at = $revokedAt WHERE token_digest = $digest AND revoked_at IS NULL`)
            .run({ digest: digest(rawToken), revokedAt: new Date().toISOString() });
    }

    private authenticateSession(rawToken: string): RequestPrincipal | null {
        const row = this.db.query<{ userId: string; expiresAt: string }, { digest: string }>(
            `SELECT user_id AS userId, expires_at AS expiresAt FROM user_sessions WHERE token_digest = $digest AND revoked_at IS NULL`,
        ).get({ digest: digest(rawToken) });
        if (row === null || Date.parse(row.expiresAt) <= Date.now()) return null;
        return Object.freeze({ tenantId: row.userId, scopes: Object.freeze(["*"]) });
    }

    revoke(id: string): void {
        this.db.query<unknown, { id: string; revokedAt: string }>(`
            UPDATE api_credentials SET revoked_at = $revokedAt
            WHERE id = $id AND revoked_at IS NULL;
        `).run({ id, revokedAt: new Date().toISOString() });
    }
}

function passwordHash(password: string): string {
    const salt = randomBytes(16).toString("hex");
    return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password: string, encoded: string): boolean {
    const [salt, expected] = encoded.split(":");
    if (!salt || !expected) return false;
    const actual = scryptSync(password, salt, 64).toString("hex");
    return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function digest(rawKey: string): string {
    return createHash("sha256").update(rawKey).digest("hex");
}
