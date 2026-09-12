import {expect,test} from "bun:test";

import { ApiCredentialStore } from "../../src/auth/api-credential-store";
import { openHarnessDatabase } from "../../src/storage/database";

test("registerUser + loginUser 全流程：正确密码返回 token，错误密码返回 null", async () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const store = new ApiCredentialStore(db);

        const { userId, tenantId } = await store.registerUser(
            "Operator@Example.COM ",
            "super-secret-password",
        );
        expect(userId).toBe(tenantId);

        const result = await store.loginUser("operator@example.com", "super-secret-password");
        expect(result).not.toBeNull();
        expect(result!.userId).toBe(userId);
        expect(result!.token.length).toBeGreaterThan(0);
        expect(result!.expiresAt > new Date().toISOString()).toBe(true);

        // 已注册会话可用作请求主体。
        const principal = store.authenticate(result!.token);
        expect(principal?.tenantId).toBe(userId);

        expect(
            await store.loginUser("operator@example.com", "wrong-password"),
        ).toBeNull();

        // 登录后撤销会话，同一 token 不再可用。
        store.revokeSession(result!.token);
        expect(store.authenticate(result!.token)).toBeNull();
    } finally {
        db.close();
    }
});

test("未知邮箱登录同样执行 scrypt 路径，不因短路而泄漏注册状态", async () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const store = new ApiCredentialStore(db);
        await store.registerUser("known@example.com", "super-secret-password");

        // 已知邮箱 + 错误密码 与 未知邮箱 都必须走完整 scrypt 校验后返回 null。
        // 这里断言行为面（均拒绝）；响应时间对齐由 loginUser 内的
        // dummyPasswordHash 结构性保证（未知邮箱不再短路跳过 scrypt）。
        const [knownRejected, unknownRejected] = await Promise.all([
            store.loginUser("known@example.com", "totally-wrong-password"),
            store.loginUser("ghost@example.com", "totally-wrong-password"),
        ]);

        expect(knownRejected).toBeNull();
        expect(unknownRejected).toBeNull();
    } finally {
        db.close();
    }
});

test("密码哈希使用随机盐：同口令两次注册产生不同哈希", async () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const store = new ApiCredentialStore(db);

        await expect(
            store.registerUser("first@example.com", "shared-password-123"),
        ).resolves.toBeDefined();
        await expect(
            store.registerUser("first@example.com", "shared-password-123"),
        ).rejects.toThrow(); // email 唯一约束

        await expect(
            store.registerUser("second@example.com", "shared-password-123"),
        ).resolves.toBeDefined();

        const hashes = db.query<{ passwordHash: string }, []>(
            `SELECT password_hash AS passwordHash FROM users ORDER BY email`,
        ).all();

        expect(hashes.length).toBe(2);
        expect(hashes[0]!.passwordHash).not.toBe(hashes[1]!.passwordHash);
        expect(hashes[0]!.passwordHash.split(":")[0]).not.toBe(
            hashes[1]!.passwordHash.split(":")[0],
        );
    } finally {
        db.close();
    }
});

test("D7：logout 语义——撤销返回 true/false，二次撤销与未知 token 都是 false", async () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const store = new ApiCredentialStore(db);
        await store.registerUser("logout@example.com", "super-secret-password");
        const session = await store.loginUser("logout@example.com", "super-secret-password");
        expect(session).not.toBeNull();

        // 撤销成功一次；再撤销同一 token 返回 false。
        expect(store.revokeSession(session!.token)).toBe(true);
        expect(store.revokeSession(session!.token)).toBe(false);
        expect(store.revokeSession("never-issued-token")).toBe(false);

        // D4：会话归属可用于审计归因——有效会话返回 user_id，撤销后为 null。
        const second = await store.loginUser("logout@example.com", "super-secret-password");
        expect(store.sessionOwner(second!.token)).not.toBeNull();
        store.revokeSession(second!.token);
        expect(store.sessionOwner(second!.token)).toBeNull();
    } finally {
        db.close();
    }
});

test("D7：revokeAllSessions 撤销当前用户全部活跃会话", async () => {
    const db = openHarnessDatabase(":memory:");

    try {
        const store = new ApiCredentialStore(db);
        await store.registerUser("multi@example.com", "super-secret-password");
        await store.registerUser("other@example.com", "super-secret-password");

        const s1 = await store.loginUser("multi@example.com", "super-secret-password");
        const s2 = await store.loginUser("multi@example.com", "super-secret-password");
        const other = await store.loginUser("other@example.com", "super-secret-password");

        const revoked = store.revokeAllSessions(store.sessionOwner(s1!.token)!);
        expect(revoked).toBe(2);

        // 该用户全部会话失效；其他用户不受影响。
        expect(store.authenticate(s1!.token)).toBeNull();
        expect(store.authenticate(s2!.token)).toBeNull();
        expect(store.authenticate(other!.token)).not.toBeNull();
    } finally {
        db.close();
    }
});
